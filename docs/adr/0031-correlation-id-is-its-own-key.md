# ADR-0031 — The correlation id is its own key again

- **Status:** Accepted (2026-08-27)
- **Date:** 2026-08-27
- **Deciders:** platform / accounting
- **Tags:** identity, observability, accounting, multi-tenancy
- **Supersedes in part:** [ADR-0022](0022-one-lifecycle-id-order-keyed-inventory.md) — its
  §*One lifecycle id* **correlation clause only**. Everything else in ADR-0022 stands.
- **Restores:** [ADR-0019](0019-ambient-correlation-propagation.md)'s separate-mint model, and
  **withdraws that ADR's 2026-07-30 entity-key-fallback amendment**.
- **Provenance:** duplicated from the parent platform's ADR-0031; held as close to identical as this demo's smaller surface allows.

> **Divergence from the parent platform.** The mechanism is identical — the journey key is its
> own UUID, minted at cart creation, owned by the cart workflow, cached in a scoped cookie. The
> demo's smaller surface means fewer touchpoints: no `user_carts` row (cookie-only identity), no
> Stripe webhook or ops sweeps (the parent's five correlation-as-entity-key bug fixes), and no
> Twisp ledger — though the motivating hazard (a reused cart id splicing two journeys onto one
> correlation key with no discriminator) applies to any correlation-keyed read, including this
> demo's ES journey queries and order trace.

## Context

ADR-0022 collapsed four identifiers into one: a single UUID minted at cart creation played cart
entity id, orderId, inventory reservation key, and correlation value. Its argument was sound on
its own terms — the separation ADR-0019 introduced existed because `cartId` was being *accidentally*
reused as a stand-in orderId, and "one deliberate id with a documented role list fixes the same
ambiguity without a fourth identifier."

What that argument did not price in is what happens when the one id is **adopted from a client**.

Validation run 019 adopted a cart id from run **018** — out of a 30-day cookie, onto a stack wiped
40 minutes earlier — and started a fresh journey under it. Under ADR-0022 that is not two carts
sharing an id; it is **two journeys sharing a correlation**. The Twisp ledger read
(`packages/accounting/src/activities-impl.ts`, `getOrderJournalEntries`) is keyed on
`CORRELATION_ID` with **no journey or time discriminator**, so the two journeys' money lands in one
bucket and every fee check downstream reconciles against a total that belongs to neither.

Run 019 fixed the *symptom* with a precheck (`decideCookieCartReuse`): probe the cookie's cart, and
mint a fresh id when the cart is confirmed dead. That precheck is correct and stays. But it carries
a deliberate, documented residual:

> **transient error → REUSE.** Minting on any failure would orphan a live cart every time Temporal
> hiccupped during a page load. **A duplicate correlation is recoverable; a shopper silently
> separated from their cart is not.**

That trade-off is only forced because the journey key and the cart entity key are the same value.
Reusing a cart is what the shopper wants; reusing a *journey identity* is what corrupts the ledger.
While the two are welded, one cannot be had without the other.

## Decision

**`correlationId` is its own UUID again** — minted server-side where the journey begins, distinct
from every entity id, and propagated by the machinery ADR-0019 already built.

`cartId == orderId` **remains**, and so does ADR-0022's §*Reservations are (orderId, sku, quantity,
status)*. That half of ADR-0022 bought the round-trip collapse (confirm ~6N → ~2) and is untouched
here. This ADR reverses one clause, not the document.

### The workflow owns the value; the browser only caches it

The cart workflow reads its journey key off its **own** `CorrelationId` Search Attribute and returns
it on every `CartDetails`. The storefront caches it in a cookie scoped as `<cartId>:<correlationId>`
— self-invalidating the moment the cart id moves — and reconciles against the workflow's answer on
every mutation, adopting the workflow's value whenever the two disagree.

The cache is deliberately not authoritative. A client-chosen journey key would re-open the exact
hole this ADR closes, because the ledger read has no discriminator to fall back on. A cache miss
costs at most the correlation on one request's storefront log lines; it can never decide what money
is filed under.

### A missing correlation is now an error, not a fallback

Every child-start site read `workflowCorrelationId() ?? <someEntityId>`. Under ADR-0022 that was a
no-op — the correlation *was* that entity id. Under this ADR the same expression silently roots a
journey under a value that is not its correlation, which is **worse than the orphaning the fallback
was written to prevent** (ADR-0019's 2026-07-30 amendment), because the result looks plausible and
nothing fails.

Both branches are unacceptable, so neither is taken: `requireCorrelationId(value, context)`
(`packages/contracts/src/constants.ts`) throws. It is pure — it takes the value rather than reading
it — so it stays on the plain contracts barrel and is importable from workflow, activity, and web
code alike without pulling `@temporalio/workflow` into a bundle that cannot carry it (backlog #45).

`buildWorkflowStartOptions` had a second, quieter version of the same hazard: `if (correlationId)`
silently dropped the Search Attribute for any falsy value, so a threading bug produced an **untagged
workflow** whose whole journey of ES documents no sweep could find. `undefined` remains the
documented opt-out for correlation-less singletons (services, sweeps, seeds); every other falsy
value now throws.

### Reading a correlation is not the same as deriving one

Two sources legitimately hold the *same* journey value and may still be read in sequence: a
workflow's Search Attribute and the order record's own `correlationId` (persisted since ADR-0019).
`workflowCorrelationId() ?? order.correlationId` is a second reader of one value, not a fallback to
a different id, and remains correct. What is banned is reaching for an **entity** id — `cartId`,
`orderId`, a document id — when the journey key is absent.

## Consequences

- **A cart id collision is no longer a money collision.** Adopting a cart id — including on the
  precheck's deliberate transient-error path — resumes a cart without resuming a journey identity.
  The residual quoted above stops being a ledger risk and becomes what it always read as: a cart
  the shopper keeps.
- **Correlation-as-entity-key bugs surfaced and were fixed**, each of which had been correct only
  by coincidence: the Stripe webhook drove the checkout workflow from `metadata.correlationId`
  (`apps/storefront/src/lib/stripe-events.ts`) and now reads a `metadata.cartId` that rides the
  PaymentIntent alongside it; `sweep-stranded-authorizations` resolved an order row and cancelled a
  checkout by correlation; `repair-unsettled-fee` matched `{ term: { orderId: correlationId } }` and
  now matches the order document's own `correlationId`; the inventory journal wrote `orderId` into a
  partition keyed `((store_id, correlation_id))`; the projection rebuild filed a cart document under
  `nudge.docId`.
- **Reservations gain a correlation field.** `ReservationDocument` omitted one on the stated grounds
  that the orderId already was the correlation — which would have left reservations as the single
  projection a journey query cannot reach.
- **No schema migration.** `inventory_history` and `payment_reconciliation` already partition on
  `correlation_id`; they simply receive correct values now. The ES reservations mapping gains one
  keyword field.
- **Clean break, no compat.** Persisted journeys written under the coupled model do not resolve
  as correlated and are not made to: a `pnpm db:init` wipe is the expected accompaniment (repo
  posture — see `docs/reference/engineering-rules.md` §0).
- **Cost:** one uuid per journey, and a cookie the storefront must keep in step with the cart
  pointer. Both are retired together by `retireCartIdentity`, because a surviving correlation
  cookie is the same class of bug as a surviving cart pointer (mono-issue-0348).

## Alternatives considered

- **Keep the coupling; document the invariant** ("a cart id is never adopted across a journey
  boundary") and close the backlog item as decided-not-to-change. Rejected: the invariant is not
  enforceable at the point that matters, because the precheck must reuse on a transient error and
  cannot distinguish that case from a genuinely dead cart.
- **Cookie as the source of truth** for the journey key. Rejected: it makes the ledger key
  client-chosen, which is the hole being closed, not a cheaper way to close it.
- **`describe()` the cart workflow on every mutation** to read the Search Attribute. Rejected: an
  extra RPC per mutation, and it still races `workflowIdConflictPolicy: 'USE_EXISTING'`.
- **A fourth identifier** distinct from all three. Rejected for ADR-0022's original reason — this
  ADR restores a separation that already existed rather than inventing a new id.
