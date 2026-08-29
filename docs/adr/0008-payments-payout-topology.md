# ADR-0008 — Payments & payout topology (marketplace rails)

- **Status:** **Accepted** (ratified 2026-07-05 — Q1 resolved: **Express** connected accounts;
  Q2 remains open behind the per-fulfiller rail seam, see ADR-0013)
- **Date:** 2026-06-30 (accepted 2026-07-05)
- **Deciders:** platform operator + accounting
- **Tags:** payments, accounting, go-live
- **Provenance:** duplicated from the parent platform's ADR-0008; held as close to identical as this demo's smaller surface allows.


> **Divergence from the parent platform.** **Not exercised in this demo** — there is no real payment or payout rail (mock gateway only).
> The record is carried for its reasoning, exactly as this corpus already carries 0004
> (multi-tenancy): the parent's decisions explain shapes that are visible here in vestigial or
> mocked form, and re-deciding them per conversation is the waste this file prevents.

## Context

The platform cannot go live without moving real money. The **books are ready, the rails are not**:

- **Capture** (`ORDER_CAPTURE`, [`tran-codes.ts` §5.2](https://github.com/night-heron-software/nightheron-mono/blob/main/packages/accounting/src/tran-codes.ts))
  already posts the full buyer payment against **`PSP_SETTLEMENT`** (the platform's PSP cash balance)
  and splits it, net-revenue style, into platform markup + commission (revenue), **seller margin**
  (`SELLER_PAYABLE`, a liability), tax, and a buyer-funded **fulfillment accrual**. The platform bears
  the PSP fee.
- **Payouts** are modeled but **ledger-only**: `recordSellerPayout` (`SELLER_PAYOUT` §5.6) and
  `recordFulfillerPayout` (`FULFILLER_PAYOUT` §5.18) DR the payable and CR `PSP_SETTLEMENT`
  ([`activities-impl.ts:901`](https://github.com/night-heron-software/nightheron-mono/blob/main/packages/accounting/src/activities-impl.ts)) — **no real Stripe
  transfer or payout is triggered.** Rolling reserve, PSP-fee settle, disputes/chargebacks are all wired
  as tran codes.
- **No Stripe Connect** scaffolding exists (no connected accounts, transfers, `application_fee`, or
  `on_behalf_of`). Stripe today is single-account capture/refund + a webhook handler + a dev simulator.

The [marketplace ledger design](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/integrations/marketplace-ledger-design-twisp.md) already states the
intended model: **"External PSP, Stripe-Connect style (separate charges + transfers). Buyer funds land
in the platform's PSP balance; the platform initiates payouts to sellers. The Twisp ledger mirrors and
reconciles against the PSP."**

**The real actors** the rails must serve:
1. **The platform operator** — takes markup + commission as revenue; bears PSP fees.
2. **Sellers** — receive their margin (a payable), possibly cross-border, requiring KYC.
3. **POD/drop-ship fulfillers** — e.g. Printify (US) but also potentially **cross-border suppliers
   (e.g. Vietnam)** — paid by the platform; their cost is passed through as seller COGS.

## Decision (proposed)

Adopt **Stripe Connect, separate charges + transfers**, with the platform as **merchant of record** on
the buyer charge — the model the ledger is already shaped for:

1. **Buyer charge:** the platform takes the **full** payment as a normal charge into its own PSP
   balance (→ `PSP_SETTLEMENT`), exactly as `ORDER_CAPTURE` models today. No `destination`/`on_behalf_of`
   at charge time.
2. **Seller payout:** create a **Stripe `Transfer`** from the platform balance to the seller's
   **connected account** when `SELLER_PAYOUT` posts (net of rolling reserve). Recommend **Express**
   connected accounts — Stripe hosts KYC/onboarding and the payout dashboard, minimizing the platform's
   compliance surface.
3. **Ledger stays the source of business truth; Stripe is cash truth.** Each real Stripe event maps to
   an existing tran code; a reconciliation pass asserts `PSP_SETTLEMENT` matches the Stripe balance.

**Two sub-decisions are genuinely open and need the operator's call** (see Open Questions) — they do not
block writing this ADR but do block go-live:

- **(Q1) Seller connected-account type** — Express (recommended) vs Custom vs Standard.
- **(Q2) Cross-border fulfiller payout rail** — the hard part. Stripe payout/transfer support to some
  supplier countries (notably **Vietnam**) is limited or unavailable, so paying a cross-border fulfiller
  may require an **off-Stripe rail** (e.g. Wise/Airwallex/bank wire) with the ledger reconciling against
  it. US fulfillers (Printify) can be paid via Connect transfer or ACH.

### Stripe event → tran code mapping (to implement)

| Real Stripe event | Ledger posting |
|:---|:---|
| `payment_intent.succeeded` (capture) | `ORDER_CAPTURE` (§5.2) |
| `charge.refunded` / partial | `ORDER_REFUND` (§5.x) |
| `balance_transaction` fee | `PSPFEE_SETTLE` — clears `PSP_FEES_PAYABLE` (§5.3) |
| `charge.dispute.created` / funds withdrawn | chargeback tran code + reserve draw |
| `Transfer` created to seller | `SELLER_PAYOUT` (§5.6) |
| Fulfiller payment (Connect transfer **or** off-Stripe) | `FULFILLER_PAYOUT` (§5.18) |
| `payout.paid` (platform bank) | reconcile `PSP_SETTLEMENT` |

## Consequences

- **Positive:** Stripe absorbs seller KYC/onboarding + cross-border seller payout + much money-transmitter
  exposure (the platform is merchant of record, not a money transmitter moving third-party funds
  off-platform); the model maps 1:1 onto the existing net-revenue ledger, so the accounting work is
  reconciliation + event wiring, not a re-model; separate charges + transfers keeps full control of
  timing (rolling reserve, hold periods) in the ledger.
- **Negative / costs / risks:** **regulatory** — merchant-of-record + holding third-party funds still
  carries obligations; get legal review before launch. **Cross-border fulfiller payout (Q2)** likely
  needs a second, non-Stripe rail — real integration + reconciliation work. **KYC gating** — a seller
  can't be paid until their connected account is verified; the payout workflow must gate on account
  status. **Disputes** are the platform's (merchant of record) — chargeback + reserve handling must be
  exercised (currently unexercised).
- **Follow-ups (each its own PR/plan):** wire real Stripe (beyond the simulator); build the connected-
  account onboarding into seller/store onboarding ([Theme 5 §P3](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/planning/production-product-theme5-plan-2026-06-30.md));
  implement the seller `Transfer` at `SELLER_PAYOUT`; decide + integrate the cross-border fulfiller rail;
  a Stripe↔ledger reconciliation job; exercise dispute/chargeback + rolling-reserve end-to-end
  ([twisp-fixes](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/planning/twisp-fixes-implementation-plan-2026-06-25.md)); **legal review**.

## Alternatives considered

- **Destination charges (`on_behalf_of` + `application_fee_amount`).** Funds route to the seller's
  connected account at charge time; Stripe takes the platform fee automatically. Cleaner for simple
  single-seller carts, but it fights the existing ledger (funds don't dwell in `PSP_SETTLEMENT`), makes
  platform-controlled rolling reserve and multi-fulfiller cost passthrough awkward, and complicates
  multi-item orders. Rejected in favor of separate charges + transfers, which matches the ledger.
- **Platform-collects-then-pays-out entirely off Stripe (ACH/wire/treasury).** Maximum control, but the
  platform becomes a money transmitter moving third-party funds — heavy licensing/compliance across
  jurisdictions. Rejected as the primary rail; may still be the mechanism for the **cross-border
  fulfiller** leg only (Q2).
- **Do nothing / stay simulated.** Not an option — gates go-live.

## Open questions

- **Q1 — Seller connected-account type: RESOLVED (2026-07-05) = Express.** Stripe hosts KYC/
  onboarding and the payout dashboard; the platform gates payouts on `payouts_enabled` from
  `account.updated` (see `seller_payment_profiles` + `prepareSellerPayoutRail`).
- **Q2 — Cross-border fulfiller payout rail: OPEN, behind a seam.** Fulfiller settlement is
  per-fulfiller config (`fulfiller_payment_profiles.rail`); adding an off-Stripe rail (Wise /
  Airwallex / wire) is a new rail value + activity, not a re-model. See ADR-0013.
- **Q3 — Jurisdictional scope at launch:** still open; bounds the KYC + tax + payout matrix.
- **Capture TIMING was never decided here — settled 2026-08-21 by
  [ADR-0028](0028-capture-timing-auth-then-capture.md).** This ADR maps
  `payment_intent.succeeded` to `ORDER_CAPTURE` but says nothing about *when* the capture happens,
  so the implementation's default stood: automatic capture at the payment step, before an order
  exists. That default is the precondition for the orphaned-capture and paid-but-trapped classes
  (validation runs 013 and 016). ADR-0028 moves to `capture_method: 'manual'` — authorize at
  payment, capture the final amount at order creation — which also makes the reconciler's capture
  leg *witnessed* rather than inferred from the order total.

## Implementation notes (as ratified)

- **Payout ordering (saga):** gate (profile + withdrawable) → real Stripe Transfer (idempotency key
  = payout workflow id) → only then post `SELLER_PAYOUT`. A permanent transfer failure fails the
  workflow before any posting; `transfer.reversed` posts `PAYOUT_RETURN`.
- **The platform Stripe account's payout schedule must be `manual`** — automatic daily payouts move
  cash outside ledger control and `PSP_SETTLEMENT` could never reconcile. Commission sweeps create
  explicit Stripe Payouts instead.
- **Webhook rule:** postings originate from platform workflows; Stripe events *reconcile* them
  (capture, refund, sweep legs in `payment_reconciliation`) and *originate* postings only for
  events the platform did not initiate (disputes, fee settlement, transfer reversals, dashboard
  refunds — the latter routed through OMS with `external: true`).

## References

[Marketplace Ledger Design](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/integrations/marketplace-ledger-design-twisp.md) ·
[ADR-0002 double-entry ledger](0002-double-entry-ledger-net-revenue.md) ·
[Theme 5 §P1 plan](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/planning/production-product-theme5-plan-2026-06-30.md) ·
[twisp-fixes plan](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/planning/twisp-fixes-implementation-plan-2026-06-25.md)
