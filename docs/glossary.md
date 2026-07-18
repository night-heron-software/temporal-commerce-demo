# Glossary

The project's terms of art, especially the pairs that look interchangeable but aren't.

## Domains and entities

- **OMS / order** — the *Order Management System* domain (`src/temporal/oms/`). The workflow ID
  domain segment is `order` (`demo.order.{orderId}`); prose and directory names say "OMS." One
  domain, two spellings, historical reasons.
- **Fulfillment** — the domain that manages *all* fulfiller orders for one customer order
  (`fulfillmentWorkflow`, one per order). Aggregates status across its fulfiller orders and
  signals the OMS.
- **Fulfiller** — the party that produces and ships goods (this demo simulates one, `simulated`).
  The platform this demo was extracted from routes to multiple real fulfillers.
- **Fulfiller order** — the portion of an order assigned to a single fulfiller
  (`fulfillerOrderWorkflow`, one per fulfiller per order; domain segment `fulfiller-order`). A
  customer order → one fulfillment workflow → N fulfiller-order workflows.
- **Store** — the tenant unit. The demo is single-tenant: `DEMO_STORE_ID = 'demo'` everywhere a
  store ID appears.

## State machine vocabulary

Two vocabularies coexist by design ([ADR-0009](adr/0009-chassaing-decider-split.md)):

- **Command → facts → state** (the pure core): `decide(command, state)` emits past-tense **facts**;
  `evolve(state, fact)` folds each fact — the only writer of state. Facts are **transient**: never
  persisted, folded in the same call.
- **Event / signal / update** (the Temporal transport): how inputs reach the workflow. The shell
  enriches an incoming update into a *command* (attaching `meta.timestamp`, prepared data) before
  the decider sees it.
- **prepare → decide → finalize** — the handler shape ([ADR-0003](adr/0003-prepare-decide-finalize-state-machines.md)):
  I/O to gather inputs, a pure decision, I/O to apply effects.
- **Transitional state** — a state the machine passes through without waiting for input
  (e.g. checkout's `validating`); excluded from the "every state needs an outgoing transition for
  input" structural rules.
- **Terminal state** — `complete`, `cancelled`, etc.; written as `__terminal:<name>` in the
  generated state graph.

## Inventory vocabulary

- **Reservation** — a hold on stock for a cart line item, taken via Cassandra compare-and-set
  (LWT). Lifecycle: **reserve** (cart add) → **renew** (checkout start) → **confirm** (order
  placed) or **release** (timeout / cancellation / removal).
- **Blank SKU** — the fulfiller-side identifier stock is keyed by (`(blank_sku, fulfiller_id)`),
  as opposed to the storefront's variant ID.
- **Dirty-flag sweep** — the inventory singleton's projection batching:
  `condition(() => dirtySkus.size > 0, CONSISTENCY_SWEEP_INTERVAL)`.

## Temporal usage vocabulary

- **Update vs. signal** — *updates when a caller needs an answer, signals when nobody's waiting.*
  Cart mutations are updates (validated state back in one round trip); fulfillment status flowing
  up to OMS is a signal.
- **`updateWithStart` / `USE_EXISTING`** — atomic create-or-update: the first interaction with a
  cart and the fiftieth run the same code path.
- **Activity-spawn vs. `startChild` + `ABANDON`** — two decoupling tools: activity-spawn when
  there should be *no parent link at all* (checkout → OMS); `ABANDON` when you want an
  *independent child* (OMS → fulfillment). See Lesson 23.
- **Correlation ID** — `= cartId`, stamped on every journey workflow as a Search Attribute
  ([ADR-0011](adr/0011-workflow-id-and-correlation-tagging.md)); one visibility query returns the
  whole chain.
- **Transition recording** — the async projection writing every state transition + full context
  snapshot to `workflow_state_transitions` ([ADR-0010](adr/0010-async-transition-recording-projection.md));
  what the Order Trace tool reads.
- **Unified worker** — the single dev/first-production process running all six domain workers on
  one connection ([Worker Topology](worker-scaling.md)).

## Data vocabulary

- **Write side / read side** — Cassandra (durable records, per-entity partitions) vs.
  Elasticsearch (projections the app queries directly). Only workflows cross the seam
  ([Data Architecture](data-architecture.md)).
- **Projection** — a read-optimized document derived from workflow state, written by an activity;
  the app's query API, and the only cache there is.
