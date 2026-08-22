# ADR-0025 — Readability extras (clarity plan Phase 5): context views and discriminated responses are NOT adopted

- **Status:** Accepted (merge of the Phase 5 PR is the acceptance)
- **Date:** 2026-08-09
- **Deciders:** Jeff / state-machine-clarity-plan (parent platform) Phase 5
- **Tags:** temporal, state-machine, framework
- **Provenance:** duplicated from the parent platform's ADR-0025; held as close to identical as this demo's smaller surface allows.
- **Extends:** [ADR-0024](0024-decider-native-state-machines.md) (the decider-native surface
  these decisions leave unchanged)

> **Divergence from the parent platform.** Carried as the parent's record of options **rejected**; nothing here is implemented in either repo. It is referenced by [ADR-0026](0026-per-block-route-declarations.md)'s scope clause.

## Context

The clarity plan deliberately deferred two readability extras until the migrations landed, to be
"decided with evidence rather than taste" — plus one item it pre-declared out of scope:

1. **Per-state context views** — an opt-in `view: (ctx) => Slice` selector typing
   `guard`/`prepare`/`effects` on a narrowed slice. Adoption bar: post-migration handlers still
   read meaningfully more than they need.
2. **Discriminated update responses** — replace the flat `error`/`response` siblings with a
   tagged result. Adoption bar: the guard typing has _not_ already made the flat shape harmless.
3. **Release-before-finalize** (reconciliation P15's open sub-item) — pre-declared as not taken
   in this plan; recorded here only so its status is findable.

All eight machines are migrated ([#197](https://github.com/night-heron-software/nightheron-mono/pull/197)–[#203](https://github.com/night-heron-software/nightheron-mono/pull/203);
framework [#5](https://github.com/night-heron-software/nightheron-state-machine/pull/5)–[#7](https://github.com/night-heron-software/nightheron-state-machine/pull/7)),
so the evidence exists. This ADR records it and the decisions it forces.

## Evidence

### 1. What handlers actually read (context views)

Distinct `ctx.*` fields read across each migrated `states.ts` (guards + prepares + effects — the
phases a view would narrow), against the width of the context type:

| Machine                 | Context fields | Distinct `ctx.*` read | Shape of the reads                                          |
| ----------------------- | -------------- | --------------------- | ----------------------------------------------------------- |
| inventory transfer      | —              | 0                     | decider-only; handlers read nothing                         |
| inventory replenishment | —              | 0                     | decider-only; handlers read nothing                         |
| fulfillment (parent)    | —              | 0                     | decider-only; handlers read nothing                         |
| catalog                 | —              | 3                     | `productId`, `input`, `storeId`                             |
| cart                    | 4              | 4                     | 29 of 33 accesses are the aggregate root `ctx.cart`         |
| oms                     | 12             | 5                     | 46 of 50 accesses are the aggregate root `ctx.order`        |
| fulfiller-order         | 10             | 8                     | dominated by the aggregate root `ctx.so`                    |
| checkout                | 17             | 14                    | the submit saga + PaymentIntent prepares are genuinely wide |

Two shapes, neither helped by a view:

- **Aggregate-root readers** (cart, oms, fulfiller-order): handlers overwhelmingly read one root
  field. A view would be `(ctx) => ctx.order` — renaming a property access, at the price of a new
  per-state concept and one more indirection between the handler and the state it acts on.
- **Genuinely wide handlers** (checkout): `prepareSubmitOrder` needs pricing, identity,
  correlation, the parent handle, and the collected state because the _operation_ is wide. A view
  can only restate that width; it cannot reduce what a reader must understand.

Three machines read nothing at all — ADR-0024 already delivered the narrowing the view was
designed for, by moving decisions into the pure decider (which owns full state by definition).

**Decision: NOT adopted.** The adoption bar ("handlers still read meaningfully more than they
need") is not met anywhere.

### 2. How update responses are consumed (discriminated responses)

The flat shape's pre-ADR-0024 danger was ambiguity: an `error` on a response could ride alongside
a transition that had _happened anyway_. The rejection semantics of ADR-0024 removed exactly
that: a **thrown** update failure now always means "rejected — no transition, no projection"
(guard refusal, prepare throw, or unlisted command), while an **`error` field on a returned
state** always means a domain _decided_ to fold a failure and stay
(`ShippingRejected`/`SubmitRejected` in checkout — [checkout/states.ts](../../src/temporal/checkout/states.ts)).
The two channels no longer overlap in meaning.

Consumers already treat them that way:

- Every `executeUpdate` call site wraps in try/catch — the storefront's
  `executeCheckoutUpdate` ([cart-actions.ts](../../src/app/shop/cart-actions.ts) §199)
  and each admin/customer order action
  ([admin-order-actions.ts](<../../apps/storefront/src/app/store-admin/(protected)/admin-order-actions.ts>)).
  OMS's refund/return rejections surface here as typed failures with the guard's reason (proven
  live in the Phase 3 validation: `Unknown line item: bogus-line` reached the caller).
- The returned state, inline `error` included, is passed through to the UI **as the contract** —
  the checkout pages branch on it directly
  ([review/page.tsx](../../src/app/shop/checkout/review/page.tsx) §58,
  [shipping/page.tsx](../../src/app/shop/checkout/shipping/page.tsx) §229).

A tagged result (`{ok} | {error}`) would ripple through the framework's update registration,
every domain's `respond`, every server action, and the UI components that read `state.error` —
to re-encode a distinction the channels already carry and the consumers already handle.

**Decision: NOT adopted.** The adoption bar is failed in the plan's own terms: the guard typing
_has_ made the flat shape harmless.

### 3. Release-before-finalize

**Deferred, unchanged** — as the plan pre-declared. It interacts with effects ordering (effects
run inside the update exchange today, which is what let the Phase 3 validation observe Stripe
refunds synchronously) and deserves its own decision with latency evidence from
production-shaped load. It remains the reconciliation plan P15 open sub-item; nothing in this
ADR forecloses it.

## Consequences

- Phase 5 closes with **zero framework changes** — the decider-native surface of ADR-0024 stands
  as-is. This is the good outcome: the migrations themselves delivered the readability the
  extras were hedging for.
- The readability investment shifts to Phase 6 (the docs rewrite), which now documents one
  surface with no pending shape changes.
- If a future machine's handlers genuinely sprawl (the evidence table's bar), revisit item 1
  with that machine as the exhibit; if a future consumer needs to distinguish rejection reasons
  programmatically beyond message text, revisit item 2 with that consumer.
