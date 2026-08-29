# ADR-0013 — Fulfiller settlement rails (auto-charge + platform payout)

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** platform operator + accounting
- **Tags:** payments, accounting, fulfillment
- **Provenance:** duplicated from the parent platform's ADR-0013; held as close to identical as this demo's smaller surface allows.


> **Divergence from the parent platform.** **Not exercised in this demo** — there is no fulfiller settlement (simulated fulfillment only).
> The record is carried for its reasoning, exactly as this corpus already carries 0004
> (multi-tenancy): the parent's decisions explain shapes that are visible here in vestigial or
> mocked form, and re-deciding them per conversation is the waste this file prevents.

## Context

ADR-0008 settled the buyer/seller rails (Stripe Connect, separate charges + transfers) but left
fulfiller settlement under-modeled. The ledger's `FULFILLER_PAYOUT` (§5.18) assumes the platform
*initiates* payment from its PSP balance (DR `fulfiller:{id}:payable` / CR `PSP_SETTLEMENT`). The
dominant real-world POD flow is the opposite: **Printify charges the platform's card per order** —
money the platform never initiates, leaving `OPERATING_BANK` (the card's funding account), not the
Stripe balance. ADR-0008's Q2 (cross-border rail for suppliers Stripe can't pay) also needs a seam
that doesn't force a re-model later.

## Decision

**Two settlement modes, configured per fulfiller** in `fulfiller_payment_profiles`
(`settlement_mode` + `rail`; see [accounting-schema.cql](https://github.com/night-heron-software/nightheron-mono/blob/main/infra/cassandra/accounting-schema.cql)):

1. **`auto_charge` (Printify model).** A scheduled ingest workflow
   (`ingestFulfillerBillingWorkflow`, every 6h) pulls billing lines from the fulfiller's plugin
   adapter (`ProductTypePlugin.listBillingTransactions`, injected into the accounting worker via
   `setFulfillerBillingSource` — accounting never imports plugins) and matches each charge to the
   order's **outstanding** payable (pure matcher:
   [fulfiller-billing-matcher.ts](https://github.com/night-heron-software/nightheron-mono/blob/main/packages/accounting/src/fulfiller-billing-matcher.ts)):
   - matched portion → **`FULFILLER_AUTOCHARGE`**: DR `fulfiller:{id}:payable` / CR `OPERATING_BANK`
   - billed beyond the payable → **`FULFILLER_CHARGE_OVERAGE`**: DR `FULFILLMENT_COST` /
     CR `OPERATING_BANK` (a platform expense; *billed-vs-payable at settlement* — distinct from the
     estimate↔actual `FULFILL_VARIANCE_*` at delivery)
   - undercharge → residual payable stays for later lines; no outstanding payable at all →
     **unmatched**, escalated as a system error (never silently posted).
   Postings carry the ORDER's correlation id (so outstanding computations see prior debits) with the
   fulfiller's billing transaction id as the payment reference; the per-fulfiller
   `billing_checkpoint` advances only after a fulfiller's lines fully process.

2. **`platform_payout`.** `processFulfillerPayoutWorkflow` is rail-aware
   (`prepareFulfillerPayoutRail`): rail `stripe_transfer` creates a real Stripe Transfer first
   (same saga ordering and idempotency as seller payouts — ADR-0008), then posts the existing
   `FULFILLER_PAYOUT` (which correctly credits `PSP_SETTLEMENT` for this rail); rail `manual`
   records ledger-only (money moves out-of-band, e.g. wire).

**Cash-leg simplification (pre-production, deliberate):** the platform card is treated as
operating-bank cash (`CR OPERATING_BANK` at charge time). If a statement-cycle credit card is used
in production, introduce a `CARD_PAYABLE` liability (charge: CR `CARD_PAYABLE`; statement payment:
DR `CARD_PAYABLE` / CR `OPERATING_BANK`) — an additive change.

**ADR-0008 Q2 stays open behind this seam:** paying a cross-border supplier (e.g. Vietnam) via
Wise/Airwallex/wire is a new `rail` value plus one payment activity — profiles, matcher, tran
codes, and workflows are unchanged.

## Consequences

- **Positive:** the ledger now mirrors how POD money actually moves; overcharges are visible P&L,
  not silent drift; both rails share the payable so switching a fulfiller's rail is config, not
  migration; the cross-border question is isolated to one enum value.
- **Negative / costs:** billing ingestion depends on adapter-quality billing data (Printify's
  billing API has no webhook — polling with checkpoints); the operating-bank-as-card simplification
  slightly misstates timing within a card statement cycle.
- **Follow-ups:** Printify `listBillingTransactions` implementation in `nightheron-plugin-pod`
  (sibling repo); real fulfiller actual-cost variance exercised end-to-end (twisp-fixes plan);
  `CARD_PAYABLE` refinement at production planning.

## References

[ADR-0008 payments & payout topology](0008-payments-payout-topology.md) ·
[Mixed Accounting Model](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/architecture/mixed-accounting-model.md) ·
[Marketplace Ledger Design](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/integrations/marketplace-ledger-design-twisp.md)
