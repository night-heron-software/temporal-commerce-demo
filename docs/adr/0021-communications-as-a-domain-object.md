# ADR-0021 — Customer communications are a domain object

- **Status:** Accepted
- **Date:** 2026-07-25
- **Deciders:** platform operator + oms
- **Tags:** communications, projections, audit
- **Provenance:** duplicated from the parent platform's ADR-0021; held as close to identical as this demo's smaller surface allows.


> **Divergence from the parent platform.** Applicable and implemented in miniature:
> `src/temporal/contracts/communications.ts` and the shopper-facing `OrderCommunications`
> surface carry the domain object; the sends themselves are mock activities (no Mailgun).

## Context

Communications were the only customer-visible side effect the platform did not persist.
`sendOrderStatusEmail` and `sendFeedbackThankYouEmail` were console-only stubs; the checkout
confirmation went out through a real transport but left no record. Once the console scrolled,
"did this order get a shipped notice, and with what tracking number?" had no answer.

That is a support problem before it is an architecture problem: the order trace could show every
workflow transition and every inventory operation, and still not show a single thing the customer
was actually told.

The send sites were also inconsistent — checkout routed through a transport, OMS and fulfillment
logged directly — so there was no single place to instrument even if we wanted to.

## Decision

**A communication is a first-class domain object**, with the same treatment as an order or a
fulfillment: a contract type, a Cassandra source of truth, and a projection.

### Not a Temporal domain

Deliberately **no new workflow, task queue, worker, or state machine**. A communication is an
immutable point-in-time fact, not a process with states — there is nothing for a state machine to
decide. Activity signatures gain a `storeId`, and that is the extent of the workflow-shaped change.

### The pieces

- **Contract** — `packages/contracts/src/communications.ts`: `CustomerCommunication`,
  `CommunicationType` (five sends), `CommunicationChannel` (email today; the field exists so
  in-app/SMS slot in without a schema change), and `buildCommunicationId`.
- **Source of truth** — `customer_communications`, keyed `((store_id, order_id), sent_at, seq)`.
  Store-partitioned like every other tenant table, and **no TTL**: what a customer was told is an
  audit record, not diagnostics (unlike `inventory_history`, which expires at 90 days).
- **Choke point** — `recordCommunication` in
  [`packages/infrastructure/src/communications/`](https://github.com/night-heron-software/nightheron-mono/blob/main/packages/infrastructure/src/communications/):
  one Cassandra INSERT plus a write-through into the `communications` ES index.
- **Templates** — pure subject/body builders, separated from the send path so wording is
  unit-testable without Cassandra, ES, or a transport, and so a template change cannot break a send.

### Failure posture

Both writes are independently try/caught and **neither may fail the send**. The asymmetry is
deliberate: a communication that reached the customer but not the audit log is a reporting gap a
reindex can heal, whereas a send that failed because Elasticsearch was down is a customer-facing
outage. Cassandra failures log at `error` (the source of truth is gone), ES failures at `warn` (the
reindex will fix it).

The record is written regardless of transport success — "we tried to tell them this" is the
auditable fact, and the transport result is logged separately.

### Deterministic ids

The ES doc id is `orderId:sentAtMs:seq`, derived from the Cassandra row's identity, so a live
write-through and a later reindex address the *same* document instead of accumulating duplicates.

### Projection footprint

A dedicated `communications` index — `recipient` as a **keyword** (the point is an exact "what did
we send this customer" lookup, not fuzzy matching), `subject` text+keyword, `body` text,
`orderId`/`correlationId` keywords for the journey join. Plus nested `communications` summaries on
the `orders` doc, joined by `indexOrder` at index time rather than in `buildOrderDocument`, so the
builder stays pure and workflow-sandbox-safe. The join is best-effort — an order must still index
if communications are unavailable.

The index is registered as reindexable: Cassandra can rebuild it, which is exactly why it can
afford a best-effort write-through.

## Consequences

- **Auditable.** "What was this customer told, when, and by which surface" is a partition read, and
  searchable by order, journey correlationId, customer email, or content.
- **One instrumentation point.** Every future channel or template change has one place to go.
- **Orders are searchable by what was said about them**, via the nested summaries.
- **The sends themselves are still stubs.** This ADR makes them *recorded*, not *real* — wiring a
  transport for the OMS and fulfillment sends is separate work.
- **The two `email-service.ts` copies were left alone.** They serve different purposes (a transport
  abstraction in infrastructure, templated auth/invitation senders in the storefront), and
  consolidating them is a refactor with its own risk profile rather than part of this change.
