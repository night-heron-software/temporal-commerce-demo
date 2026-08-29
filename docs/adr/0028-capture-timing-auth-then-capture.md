# ADR-0028 — Capture timing: authorize at payment, capture at order creation

- **Status:** **Accepted**
- **Date:** 2026-08-21
- **Deciders:** Jeff (decision taken 2026-08-20 during validation run 016 remediation planning)
- **Tags:** payments, checkout, accounting, go-live
- **Provenance:** duplicated from the parent platform's ADR-0028; held as close to identical as this demo's smaller surface allows.


> **Divergence from the parent platform.** **Not exercised in this demo** — there is no Stripe authorize/capture window: the mock gateway charges synchronously inside the submit saga, before createOrder, so the window this record closes cannot occur (verified during the reconciliation; the CART_CHANGED submit guard covers the mock-gateway analogue).
> The record is carried for its reasoning, exactly as this corpus already carries 0004
> (multi-tenancy): the parent's decisions explain shapes that are visible here in vestigial or
> mocked form, and re-deciding them per conversation is the waste this file prevents.

## Context

[ADR-0008](0008-payments-payout-topology.md) settled the payments *topology* — the platform is
merchant of record, buyer funds land in `PSP_SETTLEMENT`, `ORDER_CAPTURE` posts the split — and it
maps `payment_intent.succeeded` to that posting. **It never decided capture *timing*.** By default,
timing fell out of the implementation: `ensurePaymentIntent` creates a PaymentIntent with no
`capture_method`, so the shopper's client-side `confirmPayment` **captures immediately**, at the
payment step, before an order exists.

That default is the precondition for a family of defects validation has now hit three times:

| Run | What happened |
| --- | --- |
| 013 | Three captures against one correlation, **$140.69 orphaned** against no order ([#235](https://github.com/night-heron-software/nightheron-mono/issues/235)) |
| 016 | A shopper paid **$36.50**, edited the cart to **$63.02**, and the order shipped **$26.52 short** (`ff821710`) |
| 016 | A capture of **$63.02** left stranded against no order (`c6a483c4`) |

Once Stripe reports `succeeded`, **the amount is frozen**. So a cart edit after payment leaves the
§7.9a submit guard exactly one honest answer: refuse with `PAID_AMOUNT_MISMATCH` and name both
figures. The guard is correct. What it cannot offer is a way *forward*: the shopper's only exits are
restore the cart to precisely what they paid, or cancel. In the words that opened this work — *there
needs to be a way to approve the new amount without changing the cart.*

The topology is the problem: **money is captured before an order exists.**

## Decision

**We will authorize at the payment step and capture the final amount at order creation.**

1. `ensurePaymentIntent` creates with **`capture_method: 'manual'`**. Confirming the card
   *authorizes*; it does not move money. The intent settles at `requires_capture`.
2. The **capture** happens inside `prepareSubmitOrder`, after the price-integrity and money guards
   pass and after inventory holds commit, **immediately before `createOrder`**. It is the money edge
   of the submit saga and compensates like one.
3. The captured amount is the **final order total**, reconciled against the authorization:

   | Final total vs authorized | Action | Shopper sees |
   | --- | --- | --- |
   | **lower** | capture less (`amount_to_capture < amount`) | nothing — native to Stripe |
   | **higher**, increment eligible | `incrementAuthorization`, then capture | nothing |
   | **higher**, increment ineligible or failed | refuse; offer explicit re-approval | an approval prompt |

   Only the third row needs a shopper-facing moment. That is a far smaller surface than "let the
   shopper approve a new total" first suggests, and it is the honest scope.
4. **`ORDER_CAPTURE` posts what Stripe actually took** — the capture call's `amount_received`,
   threaded through to the ledger — not the order total assumed equal to it.

### What this changes about the reconciler

The `capture` leg becomes **witnessed** rather than inferred. Today `recordPaymentCapture` writes
the reconciliation `expected` from the order total, and the webhook later reports the observed
figure; both derived from the same number, which is precisely why `ops:money-parity` could not see
an undercharge ([#302](https://github.com/night-heron-software/nightheron-mono/issues/302), fixed
separately). After this change the expected side is a real capture response.

**The grace window's race inverts.** `reconcilePaymentEventWorkflow`'s retry ladder exists because
"a webhook can beat the posting activity by seconds" — true when capture happened at the payment
step, minutes before order creation. Now the posting and the capture are near-simultaneous and the
webhook is the async one, so the *posting* usually lands first. `matchObservation` is order-agnostic
by construction (either side may write first), so **no matcher change is required** — but the
comment describing which race is being defended is now wrong, and the behaviour must be verified
rather than assumed.

### `#245` item 4 is absorbed, not implemented

An unsubmitted authorization **expires on its own**. The orphaned-capture class stops being
*created*, so no auto-void logic is built — which is the better outcome, since auto-voiding a
capture that was about to be matched is its own failure mode (the reason the 30s grace retry
exists). `/dev/unmatched-captures` remains the operator queue for legacy and residual rows.

## Consequences

- **Positive:** the "paid but trapped" class disappears rather than being guarded against; a
  decrease is handled natively; the ledger posts cash that was actually moved; `ORDER_CAPTURE`
  finally posts when an order exists, which is what ADR-0008's event mapping always implied.
- **Negative / costs:**
  - **Authorization expiry becomes a real deadline.** Card authorizations hold roughly **7 days**
    (network- and issuer-dependent). Capture must happen inside that window. Today's submit path is
    interactive and completes in seconds, so this is not a live risk — but any future flow that
    parks a checkout between payment and submit (a manual review, a back-order) now has a hard
    clock, and an expired authorization must be re-authorized rather than captured.
  - **Incremental authorization is not universally available** — it is card-network and processor
    dependent (broadly: Visa/Mastercard on supported processors; commonly unavailable on others).
    The increase path therefore **requires** the re-approval fallback; it cannot assume the increment
    succeeds. Treat an increment failure as expected, not exceptional.
  - **Some payment methods do not support manual capture at all.** Card is the path this platform
    exercises; a future non-card method may need capture-at-payment, and the code must branch on
    that rather than assume every intent can be authorized-then-captured.
  - **Mock mode must gain the same two-step shape**, or every mock-mode test exercises a sequence
    production no longer performs.
- **Follow-ups:** the shopper-facing re-approval UI; re-derived money-guard tests (the `CC-J3` /
  `CC-J4` families survive the redesign in substance and must be re-derived, not deleted); and a
  re-read of the reconciler's grace-window comment against the inverted race.

### Amendment 2026-08-24 — re-approval mints a FRESH intent

Recorded after [mono-issue-0326](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/reference/work-glossary/mono-issue-0326.md), which found the
re-approval path was a closed loop in practice.

The original write-up left the *mechanism* of the third row open, and the implementation inherited
an assumption from elsewhere that turned out to be unachievable here. `SubmitRejected`'s fold
deliberately **retains** `paymentAttempt` on a `needs-reauthorization` rejection, reasoning that
"the retry after the shopper approves must reuse the same intent rather than mint a second one
against the same basket". That reasoning is correct for every other rejection and impossible for
this one: **we reach this branch precisely because the authorization could not be raised**, so
reusing the intent can only fail the same way.

What the loop looked like: the modal's approve was pure navigation to the payment page, which read
the latched `paymentAlreadySucceeded` and rendered *"your payment is approved"* with no card form —
so the shopper pressed Continue, returned to review, submitted, and got the modal again. Forever.

**The decision:** approving mints a **fresh** PaymentIntent for the current total and **releases**
the superseded hold, via a `reapprovePayment` command.

Three properties make that safe, and each is pinned by a test:

- **Release, not abandon.** An abandoned authorization stands for days. Cancelling it is what makes
  clearing the approval state honest — otherwise two holds sit on the card while the checkout
  claims the shopper approved nothing. If the old intent turns out to be **captured**, the command
  refuses outright rather than clearing anything.
- **The latch's exception is narrow.** `paymentAlreadySucceeded` is latched against *ignorance*
  (ADR-0028's own `CC-J4-LATCH`: a re-mint for a mode flip knows nothing about the old intent). The
  new `PaymentApprovalSuperseded` event is *knowledge* — it is emitted only after the old hold was
  released — which is why its fold may assign rather than latch. A guard refuses the whole command
  unless the machine is actually holding a `reauthorization`, so the latch cannot be cleared by a
  bare client call.
- **This is not the run-013 three-captures shape**, which was *accidental* re-minting from retry
  loops keyed on a clock. Here a new intent is minted once, only on an explicit shopper approval,
  and its idempotency key names the successor attempt the fold lands on.

The **Follow-ups** line above is now discharged: the shopper-facing re-approval UI exists
(`ReauthorizationModal`), and its approve advances the machine rather than routing.

## Alternatives considered

- **Keep automatic capture; refund the difference on a decrease, second charge on an increase.**
  Rejected: it makes every price change a money movement with its own failure and reconciliation
  path, and a second charge is exactly how run 013 produced three captures for one order.
- **Keep automatic capture; forbid cart edits once payment succeeds.** Rejected: mid-checkout cart
  edits are legal by decision ([#256](https://github.com/night-heron-software/nightheron-mono/issues/256)),
  and forbidding them re-creates the dead end this ADR exists to remove — the shopper is stuck, and
  being stuck is what drove the retry loop in run 013.
- **Capture at payment, then reconcile the difference asynchronously.** Rejected: it accepts a
  window in which the books and the PSP knowingly disagree, and every safety net this platform has
  is built to treat exactly that state as an incident.

## References

[ADR-0008 payments & payout topology](0008-payments-payout-topology.md) ·
[ADR-0002 double-entry ledger](0002-double-entry-ledger-net-revenue.md) ·
[mono issue #299](https://github.com/night-heron-software/nightheron-mono/issues/299) ·
[validation-remediation-2026-08-20-016](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/validation/validation-remediation-2026-08-20-016.md)
(Phase 4) · [validation run 016 session record](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/validation/validation-session-2026-08-20-016.md)
