# ADR-0009 — Chassaing `decide → events → evolve` split in the pure core

- **Status:** Accepted
- **Tags:** temporal, state-machine
- **Provenance:** adapted from the parent platform's ADR-0009 (piloted there on inventory
  `transfer`; adopted across this demo's domains)
- **Refines:** [ADR-0003](0003-prepare-decide-finalize-state-machines.md)

## Context

[ADR-0003](0003-prepare-decide-finalize-state-machines.md) folded Jérémie Chassaing's `decide` +
`evolve` into a single pure `decide` that returns `{ context, next }`, because Temporal already
owns the durable event history. It left open whether an explicit `decide → events → evolve` split
would pay for itself. The parent platform resolved this with a one-domain spike; the demo adopts
the outcome across its domains.

## Decision

Domains express their pure core as a Chassaing **decider**: `decide(command, state) => facts`
(pure, emits past-tense facts) and `evolve(state, fact) => state` (pure, the **only** writer of
state). Each domain has a co-located `*-decider.ts`
([cart-decider.ts](../../src/temporal/cart/cart-decider.ts),
[oms-decider.ts](../../src/temporal/oms/oms-decider.ts), …). The `prepare → decide → finalize`
handler stays the shell: its `decide` runs the pure decider, folds the facts with `evolve`, and
returns the driver's `{ context, next }`. **The `runStateMachine` driver is unchanged.**

ADR-0003's durability model is reaffirmed: **facts are transient** — folded into state in the same
call, never persisted as a second log. Time enters as data (`meta.timestamp`), never from a clock
read inside `decide` — lint-enforced.

## Consequences

- **Positive:**
  - *Tests without the sandbox.* Decider tests assert `decide` and `evolve` as plain functions —
    no `@temporalio/workflow` mock, no driver, no harness. This is what lets most of the test
    suite run with zero containers ([testing guide](../testing-guide.md)).
  - *Single writer.* All state mutation is concentrated in `evolve`; the state registry becomes
    pure routing.
  - *Determinism by construction.* No clock/randomness in the core — the ESLint rules that ban
    them have a natural enforcement point.
- **Negative / costs:** one extra file per domain and a small shell adapter; a second vocabulary
  (`command`/`fact`) alongside the framework's transport events.

## Alternatives considered

- **Terminology-only rename** — undersells the testability and single-writer gains. Rejected.
- **Keep the folded `decide`** — viable for trivial domains, but the split's cost proved low and
  driver-neutral. Rejected as the default.
- **Persist the facts (full event sourcing)** — permanent non-goal; duplicates Temporal history.
