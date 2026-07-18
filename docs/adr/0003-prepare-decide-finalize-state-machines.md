# ADR-0003 — `prepare → decide → finalize` state machines on Temporal (no separate domain event-sourcing)

- **Status:** Accepted
- **Tags:** temporal, state-machine
- **Provenance:** adapted from the parent platform's ADR-0003

## Context

The demo's domain workflows (cart, checkout, oms, fulfillment, inventory, identity) need a uniform,
legible, testable authoring shape. Two questions:

1. **Workflow shape** — free-form workflow code per domain vs. a shared state-machine driver.
2. **Event sourcing** — should domains event-source their own state (à la Chassaing's Decider:
   `decide` emits events, `evolve` folds them), given Temporal *already* keeps a durable event
   history?

## Decision

Every domain is expressed as a **state machine** run by the shared `runStateMachine` driver
(`src/temporal/framework/driver.ts`), with each state's handlers structured as
**`prepare → decide → finalize`**:

- `prepare` — gather inputs (I/O allowed).
- `decide` — **pure**, synchronous; returns `{ next, context, response, error }`. No I/O, no clock,
  no randomness (custom ESLint rules fail the build on violations).
- `finalize` — apply effects (I/O allowed).

There is **no separate domain-level event-sourcing log**. **Temporal owns the durable event
history**; `decide` folds new state into context directly rather than emitting a second, redundant
event stream. This is a deliberate divergence from full functional event sourcing — see
[ADR-0009](0009-chassaing-decider-split.md) for how the Chassaing split is nonetheless adopted
*inside* the pure core without persisting a second log.

## Consequences

- **Positive:** one mental model across all six domains; `decide` is trivially unit-testable
  (pure), which the test policy requires; the machine graph is generated to
  [state-machine diagrams](../reference/state-machine-diagrams.md) + `state-graph.json` and
  CI-checked; durability/replay is Temporal's, not hand-rolled.
- **Negative / costs:** the system is "decider-shaped" but not event-sourced at the domain level —
  no standalone domain event log to replay outside Temporal; a plain durable function would reach
  simple workflows with less ceremony (the framework earns its keep on domains with real
  branching).

## Alternatives considered

- **Free-form per-domain workflow code** — inconsistent, hard to test/diagram. Rejected.
- **Full functional event sourcing at the domain level** — duplicates Temporal's event history for
  little gain. Rejected; the reasoning-style benefits are captured by ADR-0009 instead.
