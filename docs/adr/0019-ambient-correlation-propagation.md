# ADR-0019 — correlationId is its own key, propagated ambiently to activities

- **Status:** Accepted — **restored by [ADR-0031](0031-correlation-id-is-its-own-key.md)
  (2026-08-27).** ADR-0022 briefly made the correlationId the platform's single lifecycle id
  (cartId = checkoutId = orderId); that clause is reversed and the separate mint described below
  is in force again. **The 2026-07-30 entity-key-fallback amendment in *Consequences* is
  withdrawn** — see the note there. The propagation machinery (interceptor headers,
  `CorrelationId` Search Attribute, journal partitioning) never changed through any of this.
- **Date:** 2026-07-25
- **Deciders:** platform operator + observability
- **Tags:** temporal, observability, correlation
- **Provenance:** duplicated from the parent platform's ADR-0019; held as close to identical as this demo's smaller surface allows.

> **Divergence from the parent platform.** Superseded in the same way it is in the parent — see the amendment note in its Status line, and [ADR-0022](0022-one-lifecycle-id-order-keyed-inventory.md). The propagation machinery is live in this demo; the separate-UUID decision is not.

## Context

[ADR-0011](0011-workflow-id-and-correlation-tagging.md) established `CorrelationId` as the Search
Attribute that ties a journey's workflows together. Two things about how it was implemented turned
out to be wrong.

**It was not its own value.** `buildWorkflowStartOptions` took `correlationId?: string` and fell
back to `?? cartId`. In practice nothing ever passed one, so "the correlation id" *was* the cart id
everywhere. Two consequences:

- The fallback hid missing propagation. A start site that forgot to thread the id still produced a
  plausible-looking tag, so a journey could silently fragment across two roots — `cartId` here, a
  different `cartId` there after a cart merge — with nothing failing.
- It forced a meaning onto `cartId` that it should not carry. The cart is one participant in the
  journey, not its identity, and things that outlive the cart (refunds, returns, fulfiller orders)
  had no honest key.

**It did not reach activities at all.** The Search Attribute is workflow-scoped. Every log line
written from an activity — which is where nearly all the real work happens, and therefore where
nearly all `system_errors` documents come from — had no correlationId, so an error could not be tied
back to the order that produced it. Threading it as a parameter would mean touching every activity
signature in the repo, and would still miss anything called transitively.

## Decision

**`correlationId` is a required field with no fallback, minted once at cart creation, and propagated
to activities as ambient context.**

### Required, not optional-with-a-default

`BuildWorkflowStartOptionsInput.correlationId` is `string | undefined` — required to write, but
allowed to be `undefined`. Correlation-less singletons (provisioning, seeds, imports, sweeps) opt
out by passing `undefined` explicitly, which reads as a decision at the call site instead of an
omission. All 31 start sites were updated; the compiler found every one.

The value is a fresh UUID minted where the journey begins
([`cart-actions.ts`](../../src/app/shop/cart-actions.ts)). Downstream workflows do
not re-derive it: they read their own `CorrelationId` Search Attribute back via
`workflowCorrelationId()` (framework) and pass it to the next start.

### Ambient propagation to activities

Three pieces, two of which live in `@nightheron/state-machine` (see its
`correlation-header`/`activity-capture` modules):

1. The **workflow-outbound** interceptor stamps a `correlationId` header on every scheduled
   activity, local activities included, read from the scheduling workflow's Search Attribute.
2. The **activity-inbound** interceptor
   (`worker-otel.ts` (parent platform)) decodes that header and
   runs the activity inside `runWithCorrelationId` — an `AsyncLocalStorage` scope
   ([`correlation-context.ts`](../../src/temporal/framework/correlation-header.ts)). It is
   always installed, independent of OTel, and ordered *before* the OTel interceptor so correlation
   is the outer scope.
3. A **pino mixin** stamps `correlationId` onto every log line emitted anywhere on that async path.

`AsyncLocalStorage` rather than a module-level variable because a worker runs many activities from
different journeys concurrently; the scope must not cross-stamp.

### The key is persisted, not just tagged

A Search Attribute is queryable for 90 days and only for workflows. The journey key is therefore
also written to the data it describes: `correlation_id` on `orders`, `order_status_history`,
`inventory_reservations_w` and its by-status registry; `correlationId` on the `orders`,
`fulfiller_orders`, `fulfillments`, `shipments`, `carts`, and `reservations` ES documents; and
top-level (lifted out of `context`) on every `system_errors` document.

`Cart.Order` gains a `correlationId` field, so the order carries its own journey key rather than
having it re-derived at each read. The accounting ledger's correlation — previously
`ctx.order.cartId` at three sites — now uses it.

Where the key is stamped depends on where the code runs: pure document builders take it as a
parameter (they execute in the workflow sandbox); activity-side writers read
`currentCorrelationId()`.

## Consequences

- **One query returns a journey**, and it is no longer coincidentally the cart id:
  `CorrelationId = '<uuid>'` in Temporal, `correlationId` in Elasticsearch, `correlation_id` in
  Cassandra.
- **Errors are attributable.** An entry in `/dev/system-errors` names the journey that produced it.
- **A missing propagation is now visible** rather than silently re-rooting on a cart id. The
  trade-off is accepted deliberately: an untagged workflow yields untagged children.
  > **Amended 2026-07-30 — reverted to the demo model.** The trade-off's cost showed up in
  > practice: one untagged root (a debug script) produced a whole journey of workflows with no
  > `CorrelationId` attribute and fulfiller-order/fulfillment/shipment ES documents no journey
  > sweep could find. Child-start sites now read the parent's own Search Attribute **with an
  > entity-key fallback**, exactly as temporal-commerce-demo does: cart→checkout falls back to
  > `cartId`, checkout→order and OMS→fulfillment to `order.correlationId` (itself cartId-rooted
  > for legacy journeys), fulfillment→fulfiller-order to `cartId`. A legacy root therefore
  > associates its journey under the cart id rather than orphaning it; freshly minted journeys
  > are unaffected (their own SA always wins). `buildWorkflowStartOptions` itself stays strict —
  > `correlationId` remains required with explicit `undefined` as the only opt-out.
  >
  > > **Withdrawn 2026-08-27 by [ADR-0031](0031-correlation-id-is-its-own-key.md).** The
  > > entity-key fallback was safe only while ADR-0022 made the correlation equal to the entity id
  > > it fell back to. Decoupled again, `?? cartId` does not orphan a journey — it files one under
  > > the **wrong** key, which is worse: an orphan is visible as an absence, a mis-filed journey
  > > looks like a real one. Every such site now raises via `requireCorrelationId()`, as does
  > > `buildWorkflowStartOptions`' own silent `if (correlationId)` drop.
- ~~Two deliberate fallbacks remain~~ **Withdrawn with the amendment above (ADR-0031):**
  `createOrder` now raises via `requireCorrelationId()` when ambient context is absent, and the
  remaining `?? order.correlationId` reads carry the journey key the order itself holds — a
  journey-key source, not an entity-key fallback.
- **Cost:** one `AsyncLocalStorage` read per log line, and one header per scheduled activity.
- **Amends ADR-0011**, which describes `correlationId` as defaulting to `cartId`.
