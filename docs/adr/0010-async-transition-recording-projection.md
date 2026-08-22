# ADR-0010 — Async state-transition recording projection

- **Status:** Accepted (implemented in PR #61 — `workflow_state_transitions` schema,
  `packages/infrastructure/src/transition-recorder/`, framework sink, order-trace consumer;
  rollout steps 5–6 (§8) tracked in todos #28 (parent platform))
- **Date:** 2026-07-02
- **Deciders:** platform / state-machine framework
- **Tags:** temporal, state-machine, data-layer, observability
- **Builds on:** [ADR-0001](0001-cassandra-elasticsearch-temporal-core-triad.md) (Cassandra = projection
  write model), [ADR-0003](0003-prepare-decide-evolve-state-machines.md) (Temporal = sole durable log),
  [ADR-0004](0004-multi-tenant-shared-infrastructure-store-id.md) (tenant `store_id`),
  [ADR-0007](0007-workflow-mediated-projection-writes.md) (projection writes go through the workflow),
  [ADR-0011](0011-workflow-id-and-correlation-tagging.md) (parseable IDs + `CorrelationId`/`StoreId`
  Search-Attribute tags on every workflow — the recorder reads tenant/correlation from these, so it
  needs **zero per-domain wiring**)
- **Provenance:** duplicated from the parent platform's ADR-0010; held as close to identical as this demo's smaller surface allows (paths and counts are this repo's).

> **Divergence from the parent platform.** Recorded transitions carry no real PII here: this demo is pre-production, with mocked payments and stubbed email. The parent's PII handling rules still apply to the parent.

## Context

Every domain runs on the `runStateMachine` driver, which fires an `onTransition` hook on each
state change. We want, for **every** state machine, a durable record of each transition **plus a
full snapshot of the workflow state at that point**, so the [Order Trace tool](../../src/app/dev/order-trace)
can show real before→after state deltas attributed to their triggers. The recording must not block
or destabilize the entity workflow, and Temporal must remain the source of truth.

Forces: Temporal determinism (Cassandra I/O only via activities), continue-as-new, and
workflow-history growth.

## Decision

A **generic async transition-recording projection** in the framework: an **in-workflow buffered
sink** feeds a **background flusher coroutine** that batch-writes each transition — with a full
JSON snapshot of the workflow context — to the `workflow_state_transitions` Cassandra table
(`cassandra/schema.cql`), via the shared `persistWorkflowTransitions` activity
(`src/temporal/transition-recorder/`). Concretely:

- **Non-blocking enqueue.** The driver's `onTransition` point does an O(1) push to a `pending[]`
  buffer; a sibling coroutine loops `await condition(() => pending.length || closing)`, drains a
  bounded batch, and calls the (Temporal-retried) activity. The entity workflow never awaits the
  write — _deferred + batched + retried_, not fire-and-forget: the buffer is replay-safe workflow
  state and the activity is durable.
- **Correlation from Search Attributes.** The recorder reads `StoreId`, `CorrelationId`, `Domain`,
  `OrderId`, `CartId` from `workflowInfo()` — the tags [ADR-0011](0011-workflow-id-and-correlation-tagging.md)
  sets on every start — plus `parseWorkflowId()` as a fallback. Enabling it needs no
  domain-specific code; new domain workers just spread `transitionRecorderActivities`.
- **Full JSON snapshot per transition** (no delta encoding), with a size cap and TTL (90 days).
- **Idempotent under retry/replay.** `PRIMARY KEY ((store_id, workflow_id), seq)` with a
  monotonic `seq` makes the batch INSERT idempotent — no dedup logic.
- **Durability model unchanged.** This is a read-optimized projection/audit; Temporal remains
  authoritative (ADR-0003).

## Consequences

- **Positive:** uniform full-fidelity history for every machine; recording is off the hot path
  (state progression decoupled from Cassandra availability); one mechanism serves the Order Trace
  tool and any future audit/analytics consumer.
- **Negative / costs:** payloads and snapshots are stored **in full, unredacted — by design**
  (this demo is pre-production; mocked payments, no real PII); write amplification (every
  transition produces a batched activity call); the driver must `drain()` before continue-as-new
  and at terminal states.

## Alternatives considered

- **Synchronous activity in `onTransition`** — blocks every transition on Cassandra. Rejected.
- **Fire-and-forget** — no ordering/durability guarantee, orphaned activities. Rejected.
- **External projector tailing Temporal history** — cannot capture the in-memory context snapshot
  without replaying domain logic. Possible long-term evolution, not the starting point.

## Amendment (2026-07-25)

What has changed around this decision since acceptance (the mechanism itself is unchanged):

- **Trigger-kind taxonomy now includes `'automatic'`** (PR #45). Recorded trigger kinds are
  `start` / `update` / `signal` / `timeout` / `automatic`: when the framework advances a
  transitional state on its own (no event, no timer firing), the transition is **recorded** in
  `workflow_state_transitions` with trigger kind `'automatic'` — previously such transitions were
  mislabeled `'timeout'`. The Order Trace tool and the generated state-machine diagrams use the
  same vocabulary.
- **The interceptor module does double duty.** The framework interceptors that serve this
  recorder also inject the correlation header that powers ambient activity correlation — see
  [ADR-0011's amendment](0011-workflow-id-and-correlation-tagging.md#amendment-2026-07-25).
- **Lifecycle stamping (adjacent mechanism).** Alongside transition recording, projections are
  now lifecycle-stamped: ES docs owned by a workflow get `workflowStatus` / `workflowOutcome` /
  `workflowClosedAt` when the workflow closes (PR #37, `src/temporal/projection-completion/`),
  and `fulfiller_orders` docs are stamped when the fulfiller order reaches a terminal status
  (PR #41). The admin Explorer's lifecycle filter (live / completed / both) reads these fields.
