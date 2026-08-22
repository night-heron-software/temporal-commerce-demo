# ADR-0026 — Per-block route declarations; per-state route tables derived

- **Status:** Accepted — **amended by [ADR-0029](0029-command-block-authoring-surface-in-the-framework.md)
  (2026-08-22):** the decision and all four laws stand; only the Consequences bullet placing
  `deriveRoutes` per-domain is reversed. The helper, `assembleEvolve`, and the `CommandBlock`
  shape itself now live in `@nightheron/state-machine`, and both assemblers take a leading
  `domain` label.
- **Date:** 2026-08-14
- **Tags:** temporal, state-machine, readability, authoring-convention
- **Provenance:** duplicated from the parent platform's ADR-0026; held as close to identical as this demo's smaller surface allows.
- **Extends:** [ADR-0024](0024-decider-native-state-machines.md) (the CommandBlock convention
  grows one member). **Does not touch:** the framework surface
  (`MachineState`/`EventRoute`/`resolveNext` are unchanged — no Go-port sync), anything
  [ADR-0025](0025-phase5-readability-extras-decisions.md) rejected, ADR-0010/0020/0022/0023, the
  rejection contract, or the cart dispatcher's `VERSION_NEUTRAL_EVENTS` layer.

> **Divergence from the parent platform.** The audit counts here are the parent's. This demo's equivalent proof is its own edge-triple pin — 132 route edges before the migration, 133 after, the one addition being `shipped`'s `FulfillmentPartiallyShipped`, which this repo's literal had encoded by omission.

## Context

ADR-0024 and the CommandBlock convention put a command's guard, prepare, decide, and evolve
entries in one block. One fact about a command remained invisible from its block: **the next
state.** Transitions live in per-state `route:` tables inside the `m.state(...)` calls at the
bottom of each machine file, 300–700 lines from the blocks, resolved by a framework rule
(last-routed-event-wins, `'*'` fallback, unrouted → `SELF`) that the domain file never states.
Reading "what does `beginCheckout` do?" took four jumps within one file.

The audit that makes this ADR sound: across all eight machines and **137 route entries, no event
routes to two different targets depending on the current state**. Two absence-exceptions exist —
checkout's `ValidationFailed` (terminal from `validating`, deliberately unlisted in `collecting`
so it falls to `'*': SELF`) and the fulfiller machine's `FulfillerOrderFailed` (terminal from four
states, unlisted in `shipped`) — and both are encoded as an *absence plus a comment*, the least
discoverable form knowledge takes in this repo. Meanwhile the duplication cost of per-state
tables is real: OMS spreads 23 distinct events over 72 route entries, five states re-listing the
same ~10-entry admin block.

**An event's destination is a machine-global fact in practice.** This ADR makes it one in form.

## Decision

1. **Blocks declare their routes.** Each domain's `CommandBlock` gains one optional member:

   ```ts
   routes?: { [E in DomainEvent['type']]?: StateName | `__terminal:${string}` | Self };
   ```

   A block lists an entry for every event it emits **that moves the machine**. Absence means
   "stays" (exactly today's unrouted/`'*'` behavior). An explicit `SELF` entry is permitted where
   staying put is itself worth stating.

2. **Per-state route tables are derived, not hand-written.** Each machine file defines a
   domain-local `deriveRoutes(commands, extras?)` (~30 lines, the `assembleEvolve` precedent),
   and each `m.state(...)` call becomes:

   ```ts
   const activeCommands = { addItem: addItemBlock, /* … */ beginCheckout: beginCheckoutBlock };
   const active = m.state('active', {
     commands: activeCommands,
     route: deriveRoutes(activeCommands, { '*': SELF }),
     /* timeout, effects, onTimeout unchanged */
   });
   ```

   The framework still receives a plain `EventRoute` object; `resolveNext` and
   last-routed-event-wins are untouched.

3. **Two load-time laws**, enforced by `deriveRoutes` throwing at module load (as
   `assembleEvolve` already does for divergent evolve entries):

   - **Same event, two destinations, one state → throw.** Two blocks in one state's commands
     table declaring different targets for one event is a contradiction, caught before any test
     runs. (The 137-entry audit says this never fires on current code.)
   - **Extras may only add `'*'` or weaken an event to `SELF` — never redirect.** A state may
     *refuse to move* on an event; it may not send it somewhere other than the block's declared
     destination. This is the legibility guarantee: a block's declared route is truthful in every
     state that lists it, and any stay-exception is explicit at the `m.state` call instead of an
     absence.

   Additionally, `deriveRoutes` throws if a state with commands derives an empty table — the
   symptom of a handler-override literal that forgot to carry its block's routes.

4. **The two absence-exceptions become code.** Checkout's dissolves: the two emitters of
   `ValidationFailed` never share a state, so each block declares its own truth
   (`validateBlock` → `terminal('failed')`; `ensurePaymentIntentBlock` leaves it undeclared and
   the comment moves to the block that owns it). The fulfiller's becomes an explicit override:
   `shipped` derives with `extras: { FulfillerOrderFailed: SELF, '*': SELF }`.

## Consequences

- A block now answers "what happens next" locally: `routes: { CheckoutEntered: 'checkout' }`
  sits beside the decide that emits it. Routing-marker events, whose entire meaning *is* their
  route, become self-describing at their emission site.
- OMS's five copied admin route blocks collapse into one declaration on `updateStatusBlock`
  (~72 route entries → ~30 declarations).
- **What gets worse, accepted deliberately:** a state's full outbound surface is no longer one
  literal — it is the union of its blocks' declarations plus extras. The generated diagram
  (`docs/reference/state-machine-diagrams.md`) is the authoritative whole-state view, and the
  derived table is inspectable in tests. During migration, machines on the old and new shapes
  coexist; the diagram generator reads both.
- The diagram generator learns to resolve `deriveRoutes(...)` calls statically (the block
  `routes` literals and the extras literal are object literals, same as before); the legacy
  route-literal path is retained as the per-machine rollback.
- `deriveRoutes` is duplicated per domain rather than placed in the framework — the
  `assembleEvolve` precedent. Framework placement was rejected: it buys no wire behavior and
  costs a Go-port parity obligation.

## Relation to the critique

`docs/reference/state-machine-critique.md` §8 judged XState's "the definition *is* the diagram"
property "inherent, not fixable." This ADR **narrows** that verdict rather than overturning it:
the piece a reader most often needs — the next state, from the command — moves into the
definition. What remains inherent: per-state acceptance (which states list a block) and a state's
assembled outbound surface are still distributed facts whose authoritative rendering is the
generated diagram.

## Alternatives rejected

- **Generated `// journey:` annotations above each block** (generator `--annotate`/`--check`).
  Zero semantic risk and evaluated seriously, but the annotation is derived truth — not
  navigable, true only as of the last CI-green run, and a third representation to keep honest.
  Chosen instead as *rendering* (journey lines in the generated diagrams doc), not as source
  comments.
- **Merging `evolve` into a combined `emits: { X: { to, evolve } }` member.** Puts ~5,700 lines
  of decider tests (which assert shared-evolve *reference identity*) into migration and conflates
  two merge disciplines — evolve merges by function identity, routes merge by value equality.
  The two-member shape gets the legibility win at a fraction of the cost.
- **A machine-level transitions table** (one central `{ Event: target }` map). Removes the
  duplication but moves knowledge *further* from the blocks — the opposite of the objective.
- **Keeping hand-written tables + provenance comments.** Comments are the failure mode this ADR
  exists to remove (both current exceptions live in comments).
