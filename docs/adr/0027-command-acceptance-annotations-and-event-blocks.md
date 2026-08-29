# ADR-0027 — Command-acceptance annotations and EventBlocks are NOT adopted

- **Status:** Accepted
- **Date:** 2026-08-16
- **Deciders:** Jeff / validation run 015 follow-up
- **Tags:** temporal, state-machine, documentation
- **Extends:** [ADR-0026](0026-per-block-route-declarations.md) (whose "derived truth" objection this
  ADR re-tests with measurements), [ADR-0024](0024-decider-native-state-machines.md)
- **Precedent:** [ADR-0025](0025-phase5-readability-extras-decisions.md) — an ADR whose entire job is
  to record proposals examined and *not* adopted, so they are not re-opened from scratch.
- **Provenance:** duplicated from the parent platform's ADR-0027; held as close to identical as this demo's smaller surface allows.

> **Divergence from the parent platform.** None of substance — this record's value here is the
> same as there: it names the authoring-surface extras that were considered and **not** adopted,
> so they are not re-litigated per review. The framework surface it constrains is the vendored
> copy under `src/temporal/framework/`.


## Context

Two proposals were raised as todos during validation run 015:

1. **Annotate each `CommandBlock` with the states that invoke it** — so a reader of a block knows
   where it is accepted without grepping.
2. **Add `EventBlock`s** — a second block type that handles an event without carrying out a command.

Both are reasonable on their face. Neither survives contact with the measurements, and the second
turned out to rest on an artifact rather than on a fact. Recorded here with the numbers, because "we
looked and decided not to" is worth more than silence — and because one of the two arguments below
is not obvious and was missed on the first pass.

## Decision

**Neither is adopted.** Instead: the generated diagram was fixed (it was actively wrong), and the
question the first proposal was really asking is answered by rendering rather than by comments.

## Evidence

### 1. Command fan-in: annotations would be noise on 72% of blocks

Measured from `docs/reference/state-graph.json` across all eight machines:

| Measure | Count |
| --- | --- |
| Commands total | **65** |
| Accepted in exactly **one** state | **47** (72%) |
| Accepted in **more than one** state | **18** |
| Distinct co-extensive acceptance sets among those 18 | 9 |
| …of which have **more than one member** | **3** |

For the 47, an annotation restates what the single adjacent usage already says. ADR-0026 already
rejected generated annotations as "derived truth… true only as of the last CI-green run, and a third
representation to keep honest"; the fan-in numbers say the trade buys very little even before that
objection applies.

### 2. The argument that actually settles it: an annotation cannot name its own subject

This is the part that is not obvious. An annotation on a *block* would say "accepted in: A, B". But a
state's entry for a command need not be that block — it may be a different handler under the same
command name. The annotation cannot distinguish the two, and the codebase contains both cases:

- **`beginCheckoutBlock`** — cart's `checkout` state *does* accept `beginCheckout`, so
  `// accepted in: active, checkout` would be **literally true and materially misleading**: in
  `checkout` the handler is a deliberate inert `{}` (an idempotent no-op that emits nothing), not the
  block the comment sits on (`packages/cart/src/states.ts:1281-1285`).
- **`updateStatusBlock`** — OMS's `delivered` layers an `enrich` over the block.

So the annotation is least trustworthy exactly where the code is most subtle, which is where a reader
would most rely on it. That inverts the point of writing it.

### 3. EventBlocks: the motivating evidence was a rendering bug

The case for a second block type rests on events a state *handles* but no command *emits*. Querying
the graph found **9 such events, all in one state** — `OMS_STATES.delivered`.

All nine were an artifact. Emissions are derived from a handler's `evolve`-map keys, and
`delivered.updateStatus` was spelled as a bare `{ guard, enrich }` literal that restates no `evolve`,
so the generator recorded `emits: 0` while every other state using the same block recorded
`emits: 10`. The document therefore rendered a command that can force **nine** statuses — four of
them terminal — as *"(no events — idempotent no-op)"*.

**After fixing that, the count of genuine event-only-handling cases is zero.**

It is also zero *structurally*, not just today. The framework has one entry path: signals and timeouts
both **synthesize commands** and run the full pipeline (`nightheron-state-machine/src/machine.ts:306-316`,
driver signal queue `driver.ts:81-95`). There is no event-injection door for an `EventBlock` to stand
in. And it would inherit the defect that killed `emits: { X: { to, evolve } }` (ADR-0026:116-119),
plus a new one: an `EventBlock` and a `CommandBlock` could both claim one event type, requiring a
third merge rule for cross-block-type collisions — where evolve already merges by function *identity*
and routes by *value* equality.

## What was done instead

1. **Fixed the diagram** — the handler is now `{ ...updateStatusBlock, enrich }`, and the generator
   looks through spreads (for `evolve`, and for `guard` so the *(guarded)* marker survives). A bare
   literal now means only what cart's `{}` means: deliberately not the block. This was a bug fix, not
   a feature; the authoritative whole-state view was stating the opposite of the truth.
2. **A ratchet in `packages/infrastructure/src/state-graph.test.ts`** — a command must not report zero
   emissions in one state and many in another. Cart's `checkout/beginCheckout` is a genuinely inert
   acceptance and is listed with its reason, so "0 emissions" can no longer hide the bug above.

## Consequences

- The `CommandBlock` surface is unchanged; no comment to maintain, no third representation.
- The generated diagram is the single derived view, which is the lane ADR-0026 endorsed and
  `docs:diagrams:check` already gates.
- Naming a shared acceptance set as a const remains available and is the preferred way to make
  multi-state acceptance visible — it is code, not commentary, so it cannot drift. `pollingCommands`
  (`packages/fulfillment/src/fulfiller-states.ts:887-891`) is the existing precedent, and the three
  multi-member sets above are the candidates. Not done here; noted so it is not re-derived.

## Revisit if

- **Mean fan-in rises above ~2**, or a real mis-listing bug is ever observed in review. The one
  variant that survives every objection is **typed acceptance** — a machine-checked declaration
  rather than a comment — rejected today as redundancy, not as derivation.
- An event ever needs handling with no command able to emit it. That would require a framework
  entry path that does not exist today, so it would be an ADR-0024 change first.
