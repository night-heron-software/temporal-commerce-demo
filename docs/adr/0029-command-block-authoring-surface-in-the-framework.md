# ADR-0029 — The CommandBlock authoring surface moves into the framework

- **Status:** Accepted
- **Date:** 2026-08-22
- **Deciders:** platform / state-machine
- **Tags:** temporal, state-machine, framework, authoring-convention
- **Provenance:** duplicated from the parent platform's ADR-0029; held as close to identical as this demo's smaller surface allows.
- **Amends:** [ADR-0026](0026-per-block-route-declarations.md) (reverses its framework-placement
  rejection) and [ADR-0024](0024-decider-native-state-machines.md) (the `CommandBlock` convention
  becomes a framework type rather than a per-domain interface).

## Context

ADR-0024 established the `CommandBlock` convention and ADR-0026 added `routes` to it. Neither put
the shape itself in `@nightheron/state-machine`. The result, one year of machines later, is that
**every domain redeclares `CommandBlock` by hand** and each state-machine file carries its own
`assembleEvolve`, with ADR-0026 adding a second per-domain assembler, `deriveRoutes`.

ADR-0026 rejected framework placement explicitly:

> `deriveRoutes` is duplicated per domain rather than placed in the framework — the
> `assembleEvolve` precedent. Framework placement was rejected: it buys no wire behavior and costs
> a Go-port parity obligation.

Two things have changed since, and one of the two reasons turns out not to hold.

**The Go-port obligation was overestimated.** `deriveRoutes` returns an ordinary `EventRoute` and
`assembleEvolve` an ordinary evolve function — both are load-time assembly over structures the Go
port already has. Neither adds wire behavior or runtime semantics, so neither is reachable by the
parity tests that make the obligation real (`TestPersistRecordJSONShapeMatchesTypeScript` and its
siblings pin the transition wire format, which this does not touch). The Go port also implements
no `CommandBlock` convention to mirror: its domains build `Route` and `Evolve` directly, because
the TypeScript convention leans on discriminated unions and structural spread, neither of which
has a natural Go shape. The parity cost is not "one more ported function" — it is zero, and the Go
port's README now records that as a deliberate non-port rather than a gap.

**The `assembleEvolve` precedent argues the other way once you count it.** The precedent was cited
to justify a second domain-local assembler. But `assembleEvolve` is duplicated across all eight
machine domains, and `deriveRoutes` was on course to become the ninth through sixteenth copies.
A precedent for duplication is still duplication; it only reads as neutral if you decline to
extend it.

The remaining half of ADR-0026's reasoning — "it buys no wire behavior" — survives intact. It is
simply not an argument against sharing a type; it is an argument that sharing one is *cheap*.

Two further facts made the per-domain shape actively costly rather than merely redundant:

- **The copies had already drifted.** Only cart's `CommandBlock` carried `routes?`. OMS uses
  `enrich` without declaring it at all, reaching the framework's `CommandHandler` through
  structural typing — which type-checks, and which no reader of the OMS interface would predict.
- **The demo cannot follow.** `temporal-commerce-demo` vendors the framework byte-identically
  (its sync ledger verifies this mechanically), so a domain-local `deriveRoutes` in the parent
  cannot reach the demo's domains at all except by copying the function a second time in a second
  repo.

## Decision

We will export the authoring surface from `@nightheron/state-machine`:

1. **`CommandBlock<TContext, TCommandMember, TDeciderCommand, TEvent, TState, TResponse>`**
   extends the existing `CommandHandler` (the shell phases the framework already consumes) with
   `decide`, `routes?`, and `evolve?`. Domains keep a one-line alias binding their own types.
   `enrich?` arrives from `CommandHandler`, so OMS's structural-typing reach becomes a declaration.
2. **`RouteTarget`**, **`RouteMap`**, and **`EvolveMap`**, generic over state and event names.
3. **`deriveRoutes`** and **`assembleEvolve`**, generalized verbatim from cart. Both take a leading
   `domain` label so their throw-at-module-load messages still name the machine that violated the
   law — cart's messages hardcoded a `cart route assembly:` prefix, which becomes a parameter.

All four ADR-0026 laws are unchanged: same event with two destinations in one state throws; extras
may only add `'*'` or weaken to `SELF`; a state with commands may not derive an empty table; and
duplicate evolve keys must be the identical function reference.

This is a **type and helper move, not a semantic change**. The framework's runtime surface
(`MachineState`, `EventRoute`, `resolveNext`) is untouched, so ADR-0026's "Does not touch" clause
still holds for everything except the sentence this record reverses.

## Consequences

- **Positive:** one definition of a block instead of eight, and one assembler pair instead of
  sixteen. Drift of the kind already present (cart-only `routes?`, OMS's undeclared `enrich`)
  stops being possible. The demo can adopt the convention by syncing the framework rather than
  copying functions into a second repo.
- **Negative / costs:** the framework grows an authoring layer, having been deliberately thin —
  the same cost ADR-0024 accepted for the same reason. Every machine domain takes a mechanical
  edit. `deriveRoutes` and `assembleEvolve` gain a required first argument, so every existing call
  site changes.
- **Follow-ups:** migrate all eight machine domains to the shared types; sync the framework into
  `temporal-commerce-demo` and migrate its five.

## Alternatives considered

- **Leave it as ADR-0026 decided.** Rejected on the counting argument above: the precedent for
  duplication was about to be extended eightfold, and a second repo was about to inherit it.
- **Share `deriveRoutes` only, leaving `assembleEvolve` domain-local.** Rejected as
  self-undermining — the `assembleEvolve` precedent is half of what ADR-0026 rejected framework
  placement on, so reversing the decision while preserving the precedent argues against itself.
- **A shared module outside the framework package.** Would have kept the framework thin, but the
  demo vendors only `nightheron-state-machine/src/`, so anything outside it still fails to reach
  the demo — which is the concrete problem to solve.
- **Port the helpers to Go for symmetry.** Rejected: there is no Go `CommandBlock` convention for
  them to assemble, so a Go `DeriveRoutes` would be a function with no callers.
