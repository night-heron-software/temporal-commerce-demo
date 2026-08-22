# ADR-0003 — `prepare → decide → evolve` state machines on Temporal (no separate domain event-sourcing)

- **Status:** Accepted
- **Date:** 2026-06-30 (retroactively recorded)
- **Deciders:** platform / state-machine framework
- **Tags:** temporal, state-machine
- **Amended by:** [ADR-0024](0024-decider-native-state-machines.md) (2026-08-07) — the vocabulary
  is corrected (the driver's `TEvent` carried commands) and the folded shell `decide` is replaced
  by a framework-owned decider fold; the no-second-event-log decision is **reaffirmed**
- **Provenance:** duplicated from the parent platform's ADR-0003; held as close to identical as this demo's smaller surface allows (paths and counts are this repo's).

> **Divergence from the parent platform.** This demo has **six** workflow domains (cart, checkout, oms, fulfillment, inventory, identity) against the parent's eight; the framework is vendored at `src/temporal/framework/` rather than consumed as a package. See [ADR-0012](0012-extract-state-machine-framework-package.md).

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
**`prepare → decide → evolve`**:

- `prepare` — gather inputs (I/O allowed).
- `decide` — **pure**, synchronous; returns `{ next, context, response, error }`. No I/O, no clock,
  no randomness (custom ESLint rules fail the build on violations).
- `finalize` — apply effects (I/O allowed).

There is **no separate domain-level event-sourcing log**. **Temporal owns the durable event
history**; `decide` folds new state into context directly rather than emitting a second, redundant
event stream. This is a deliberate divergence from full functional event sourcing — see
[ADR-0009](0009-chassaing-decider-transfer-pilot.md) for how the Chassaing split is nonetheless adopted
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

## Amendment (2026-08-22) — the third phase is `evolve`, not `finalize`

The decision is unchanged; its vocabulary drifted from the code and is corrected here.

`CommandBlock` has no `finalize` member and never did under the decider-native surface
([ADR-0024](0024-decider-native-state-machines.md)). A command block is
`guard? / prepare? / decide / evolve?`, and the post-decision reactions this record called
"finalize" are declared separately as state- and machine-level `effects`, deliberately outside
the block. Every domain in both codebases was already written that way; only the documents said
otherwise — this record's own title among them, which is why the file is renamed.

`finalize` survives as a **telemetry** name and is correct there: `finalizeActivities` /
`finalize_activities` is the bucket of activities captured after the decision, carried through
the transition recorder into the Order Trace tooling. A reader meeting that field name is not
looking at a leftover mistake.
