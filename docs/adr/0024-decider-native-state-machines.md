# ADR-0024 — Decider-native state machines: command/event vocabulary, framework-owned fold, guard phase

- **Status:** Accepted (merge of the Phase 0 PR is the acceptance) — **amended by
  [ADR-0029](0029-command-block-authoring-surface-in-the-framework.md) (2026-08-22):** the
  `CommandBlock` convention is unchanged, but the type is exported by the framework instead of
  redeclared per domain.
- **Date:** 2026-08-07
- **Deciders:** Jeff / state-machine-clarity-plan (parent platform) Phase 0
- **Tags:** temporal, state-machine, framework
- **Provenance:** duplicated from the parent platform's ADR-0024; held as close to identical as this demo's smaller surface allows.
- **Supersedes:** the *opt-in posture* of [ADR-0009](0009-chassaing-decider-transfer-pilot.md) —
  its Option B substance is retained and extended
- **Amends:** [ADR-0003](0003-prepare-decide-evolve-state-machines.md) (vocabulary); its
  no-second-event-log decision is **reaffirmed**, for the third time
- **Relaxes:** the "prepare→decide→evolve shape is not up for refactor" alignment constraint
  (reconciliation plan (parent platform)) and
  Theme-1 Guardrail 1
  (theme 1 plan (parent platform)), for this
  change only

> **Divergence from the parent platform.** Counts in this record are the parent's **eight** machine domains. This demo has **five** (cart, checkout, oms, fulfillment, fulfiller-order). References to the Go port and to 'the demo' are the parent describing this repo from outside.

## Context

ADR-0009 adopted Chassaing's `decide → events → evolve` split as an *available, opt-in* pattern
and shipped only a type: `Decider<Command, Event, State>` in
`nightheron-state-machine/src/types.ts`, consumed by nothing in the driver. Reality since:
**all eight** machine domains adopted it, each hand-writing the fold — eight decider modules
(~1,900 lines), eight `apply()` adapters no two alike, dead `initialState`/`isTerminal` members,
terminality decided twice, and routing that re-derives conditions (`items.length === 0`) because
the events are discarded at the `apply` boundary. The vocabulary ADR-0003 fixed before the
decider existed is inverted: the framework's `TEvent` carries commands, so domains renamed their
actual events to `*Fact`. "Prepare succeeds ⇒ decide cannot fail" is held by mirrored, unenforced
guards. The full analysis, with file:line evidence, is
the clarity plan §2 (parent platform).

## Decision

We will make the decider the **standard core** of every machine domain and move its machinery
into `@nightheron/state-machine`:

1. **The framework owns the fold.** `applyCommand(decider, ctx, command) → { context, events }`,
   implemented once. A domain supplies `{ decide, evolve }` — pure, zero framework imports.
   `Decider.isTerminal` is **removed** (terminality is routing's job; the member is dead in every
   domain); `initialState` becomes an optional test seam.
2. **Commands and events are distinct, and named correctly.** A **command** is intent: it may
   require side-effecting preparation and, once decided, generates events. An **event** reports
   something that happened, and is *reacted to*: folded by `evolve`, routed on, answered by
   effects. Framework `TEvent → TCommand`; `StateInput.kind: 'event' → 'command'`;
   `MappedUpdateRegistration.toEvent → toCommand`; domain wire unions become `*Command`
   (collapsing today's near-isomorphic wire/decider pairs into one union); `*Fact → *Event`.
   The **persisted** transition-record trigger kinds
   (`'start'|'signal'|'update'|'timeout'|'automatic'`) are already transport-accurate and do
   **not** change — this is a source-level rename, not a wire-format change.
3. **Routing keys on emitted events.** Each state declares a table
   `{ <EventType>: nextState | terminal(reason), '*': SELF }` evaluated by the framework — the
   shell never re-derives what the decider already said.
4. **A pure `guard` phase owns rejection.** `guard(ctx, command)` runs before `prepare`; every
   rejection derivable from `(ctx, command)` lives there, so a guarded command's `decide` is
   total (no error channel, enforced by type). Rejections — guard or prepare-throw — release the
   caller with a typed error and **neither transition nor project**. The TOCTOU rule stands:
   atomic check-and-reserve remains a single activity in `prepare`; a prepare mutation must be
   guarded-unreachable on every reject path or idempotent.
5. **Effects are event-keyed.** Side-effect reactions (activities, `startChild`, external
   signals) are declared per event type and run by the framework after the fold, replacing the
   four current mechanisms (prepare / finalize / `onTransition` / after-driver-returns).
   Projections stay on the [ADR-0023](0023-async-projections-via-projection-service.md) path.
6. **Events remain transient.** In-memory, per-call, never persisted — Temporal history is the
   sole durable log. `identity` and `accounting` remain intentionally imperative.

Sequencing, migration order, and acceptance criteria are the
clarity plan (parent platform)'s Phases 1–8; the old
authoring surface is deleted when the last domain migrates (pre-production clean break, new
executions only).

## The rename map

| Now | Becomes | Where | Blast radius |
|:----|:--------|:------|:-------------|
| `TEvent` generic | `TCommand` | framework `types.ts`, `authoring.ts`, `driver.ts`, `pure-state.ts` | framework + every domain's type args; Go port; demo vendored copy |
| `StateInput.kind: 'event'` / `.event` | `'command'` / `.command` | framework `types.ts:3-6` | in-memory only; wire trigger kinds unchanged |
| `MappedUpdateRegistration.toEvent` | `toCommand` | framework `types.ts` | checkout/oms registrations |
| shell `decide` (returns `DecisionResult`) | framework fold + `route` table | framework + every `states.ts` | resolved structurally — only the decider's `decide` survives |
| `CartEvent` (wire) | `CartCommand` (merged with decider union) | `packages/cart/src/types.ts:144` **and** `packages/contracts/src/cart.ts:427` (duplicated) | storefront imports via contracts; cart `states.ts`/`definitions.ts` |
| `CartFact` | `CartEvent` | `packages/cart/src/cart-decider.ts:68` | name freed by the wire rename |
| `CheckoutInput` (wire) | `CheckoutCommand` (merged) | `packages/checkout/src/types.ts:76` | checkout `states.ts`/`workflows.ts` |
| `CheckoutFact` | `CheckoutEvent` | `packages/checkout/src/checkout-decider.ts:76` | |
| `OrderEvent` (wire) | `OrderCommand` (merged) | `packages/oms/src/types.ts:217` | oms `states.ts`/`workflows.ts` |
| `OrderFact` | `OrderEvent` | `packages/oms/src/oms-decider.ts:56` | name freed by the wire rename |
| `CatalogFact` | `CatalogEvent` | `packages/catalog/src/catalog-decider.ts:27` | `ProductSignal` (transport) keeps its name |
| `ReplenishmentFact` | `ReplenishmentEvent` | `packages/inventory/src/replenishment-decider.ts:18` | |
| `FulfillmentFact` | `FulfillmentEvent` | `packages/fulfillment/src/fulfillment-decider.ts:23` | |
| `FulfillerFact` | `FulfillerEvent` | `packages/fulfillment/src/fulfiller-decider.ts:43` | |
| `TransferEvent` | *(unchanged — already correct)* | `packages/inventory/src/transfer-decider.ts:33` | the pilot named it right |

`*Signal` unions keep their names — they are transport, mapped into commands at registration.
Every row also lands in: the diagram generator + `state-graph.json` (same commit, or
`docs:diagrams:check` fails), doc-assertion pins on the renamed tokens, the Go port
(same semantics; wire fixture test asserts no format drift), and the demo's six domains.

## Consequences

- **Positive:** one vocabulary that matches the literature; one fold instead of eight; `decide`
  total by type where guarded; routing and effects visible as data (diagrammable without AST
  archaeology); the per-handler reading surface shrinks to command in → events out.
- **Negative / costs:** the framework grows real machinery (it was deliberately thin); every
  machine domain migrates; the Go port and demo each take a full sync; the old surface's
  deletion is a breaking change (acceptable pre-production, and scheduled, not incidental).
- **Follow-ups:** the clarity plan's Phases 1–8; lint bans on the retired names after Phase 4;
  the Go-port wire fixture test; flipping the affected doc-assertion pins per phase.

## Alternatives considered

- **Rename only (ADR-0009's Option A revisited)** — fixes the words, leaves eight hand-rolled
  folds and the discarded events. Rejected again, same reason.
- **Keep the decider opt-in per domain** — the option is fiction: 8 of 8 machines opted in;
  "opt-in" now only means "unsupported by the framework." Rejected.
- **Guard as convention + lint** — a lint cannot see that a rejection depends only on
  `(ctx, command)`; the type-level exclusion can. Rejected.
- **Persist the events (full domain event sourcing)** — permanent non-goal, third reaffirmation:
  it would duplicate Temporal history.
