# ADR-0020 — Projection docs record their workflow's lifecycle

- **Status:** Accepted
- **Date:** 2026-07-25
- **Deciders:** platform operator + observability
- **Tags:** elasticsearch, projections, temporal, observability
- **Provenance:** duplicated from the parent platform's ADR-0020; held as close to identical as this demo's smaller surface allows.

## Context

Every projection document carries a domain `status` — `active`, `processing`, `TEMPORARY`. None
of them can answer the question an operator actually asks first: **is this still running?**

A cart sitting at `active` and a cart whose workflow died a month ago are the same document. A
`TEMPORARY` reservation whose workflow was terminated looks exactly like one a shopper is holding
right now. The Explorer therefore showed an ever-growing pile of documents with no way to separate
live work from history, and "how many orders are actually in flight" had no answer short of
cross-referencing Temporal.

Two properties make this awkward to solve at the domain level:

- **Closing is not a status.** A workflow can close as completed, cancelled, or failed, and the
  last two do not correspond to any domain status the machine passed through.
- **The doc's writer is not always its owner.** `fulfiller_orders` documents are written by the
  long-running OMS workflow, not by the fulfiller child, so nothing in that document's own write
  path knows when the child ended.

## Decision

**A projection document is live until its owning workflow closes, at which point the driver stamps
it.** Absence of the stamp is the signal — nothing has to be written while a workflow is running.

### The stamp

Three fields (`WorkflowLifecycleFields` in
[`contracts/elasticsearch.ts`](../../src/lib/es-client.ts)):
`workflowStatus: 'completed'`, `workflowOutcome: 'completed' | 'canceled' | 'failed'`,
`workflowClosedAt`. They are added to the six indices in `LIFECYCLE_INDICES` — orders,
fulfiller_orders, carts, reservations, fulfillments, shipments.

### The mechanism

A machine declares what it owns:

```ts
projections: { refs: (ctx) => [{ index: ES_INDICES.orders, id: ctx.order.orderId }] }
```

The framework driver (`@nightheron/state-machine`, ADR-0012) then marks at **all three exits** —
terminal, cancellation, and failure. Three details carry the weight:

- The mark runs **after** `onTerminal`/`onCancellation`, so a domain's own final re-index cannot
  overwrite it.
- The failure path is gated on `instanceof TemporalFailure`. A plain `Error` fails the workflow
  *task* — the workflow is still open and will retry — and the continue-as-new sentinel is not a
  failure at all. Marking on either would declare a running workflow dead.
- Every mark is wrapped in try/catch. A marking failure must never fail an otherwise-completed
  workflow; the doc simply stays live, which is the safe direction to be wrong in.

Machines without a `projections` config schedule no activity and replay unchanged.

The host side is `markProjectionsCompleted`
([`packages/infrastructure/src/projection-completion/`](../../src/temporal/framework/projection-completion.ts)),
registered on every worker beside `transitionRecorderActivities`. It issues a **partial** update, so
it can only ever touch the lifecycle trio — a full re-index here would race the domain's own writes.
Two per-ref conditions are tolerated rather than retried, because retrying cannot fix either: a doc
that was never indexed, and a missing index during the reindex delete/recreate window.

### Derivation from status, for the cases marking cannot reach

`deriveLifecycleFromStatus(index, status, closedAt)` maps terminal domain statuses onto the same
fields. It is used in two places:

1. **`buildFulfillerOrderDocument`** — these docs are written by OMS, so without this a delivered
   fulfiller order would read as live for as long as the order stays open, potentially weeks.
2. **`buildOrderDocument` and the reindexer** — a reindex *replaces* the whole document, so a mark
   that existed only as a close-time partial update would be silently erased the next time an index
   was rebuilt.

`delivered` is deliberately **not** terminal for an order: it stays open for feedback, refunds, and
returns until `complete`.

### Migration

`ensureIndicesExist()` now issues `putMapping` for indices that already exist. Creation is skipped
for an existing index, which is the Elasticsearch analogue of `CREATE TABLE IF NOT EXISTS` quietly
ignoring a new column — new fields would never become queryable. `putMapping` is additive only; a
conflicting change still needs a real reindex.

## Consequences

- **Live vs. completed is one query**, on the presence of `workflowStatus`. The Explorer gains a
  Live / Completed / Both control, offered only for indices that carry the fields — showing it
  elsewhere would silently return nothing.
- **The outcome is recorded, not just the fact of closing.** A cancelled order and a completed one
  are distinguishable in the projection, which the domain status alone could not express.
- **Marking is best-effort by design.** The failure mode is a document that stays live, never a
  workflow that fails because Elasticsearch was briefly unavailable.
- **Reservations are stamped but nothing marks them yet.** Mono's `reservations` index currently
  has no live writer — only the reindexer, which reads the active-only registry — so terminal
  reservations are not indexed at all. The fields and the derivation are in place for when they
  are; this ADR does not add the writer.
- **Carts are re-indexed on every transition**, so a cart's mark relies on the driver's ordering
  (mark after `onTerminal`). This holds because the cart machine re-indexes inside `onTerminal`,
  not after it.
