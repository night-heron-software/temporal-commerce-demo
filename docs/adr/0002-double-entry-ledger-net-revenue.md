# ADR-0002 — Double-entry ledger (Twisp-modeled) with net revenue recognition

- **Status:** Accepted
- **Date:** 2026-06-30 (retroactively recorded)
- **Deciders:** accounting/platform architecture
- **Tags:** accounting, payments
- **Provenance:** duplicated from the parent platform's ADR-0002; held as close to identical as this demo's smaller surface allows.


> **Divergence from the parent platform.** **Not exercised in this demo** — there is no ledger (no Twisp; payments are a mock gateway).
> The record is carried for its reasoning, exactly as this corpus already carries 0004
> (multi-tenancy): the parent's decisions explain shapes that are visible here in vestigial or
> mocked form, and re-deciding them per conversation is the waste this file prevents.

## Context

A marketplace moves money between shoppers, sellers, POD suppliers, the payment processor, and the
platform operator. Order capture, refunds (partial and per-line), fulfillment settlement, PSP fees,
disputes, tax, and payouts must all reconcile, be auditable, and never drift due to floating-point
error. An ad-hoc "orders table with amounts" cannot express balanced money movement or support audit.

Two sub-questions needed settling:

1. **How to model money movement** — bespoke tables vs. a real ledger.
2. **What counts as platform revenue** — gross (whole order value) vs. net (platform markup only).

## Decision

We will keep a **Cassandra-backed double-entry ledger**, modeled on Twisp: every money movement is a
balanced set of transaction-code postings (`ORDER_CAPTURE`, `ORDER_REFUND`, `FULFILLMENT_ACCRUAL`,
`PSP_SETTLEMENT`, `COMMISSION_SWEEP`, `TAX_REMIT`, reserves, chargebacks, …).

- **Net revenue recognition:** platform markup is revenue; the seller's margin is a **liability**
  (payable), not platform revenue.
- **PSP fees are platform-borne** (`PROCESSING_FEES` / `PSP_FEES_PAYABLE`).
- **OMS owns payment capture** and originates all order postings; the accounting worker owns ledger
  activities and scheduled jobs.
- All arithmetic goes through the integer-cents `Money` value object — no floats.

## Consequences

- **Positive:** balanced, auditable books; refunds reverse exactly what capture credited; revenue is
  stated honestly (markup, not pass-through); a clean seam for real payout rails.
- **Negative / costs:** more moving parts than an amounts column; postings must be kept balanced by
  construction; the ledger is payout-*ready* but real PSP/payout rails are still to be wired.
- **Follow-ups:** the payments/payout topology (Stripe Connect vs. collect-then-pay) is a separate,
  still-open decision — [Theme 5 §P1](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/planning/production-product-theme5-plan-2026-06-30.md) — and
  should get its own ADR.

## Alternatives considered

- **Amounts on the orders table** — no audit, no balance guarantee, refunds error-prone. Rejected.
- **Gross revenue recognition** — overstates revenue and misrepresents the marketplace relationship;
  the seller margin is genuinely a liability. Rejected.

## References

[Mixed Accounting Model](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/architecture/mixed-accounting-model.md) ·
[Marketplace Ledger Design](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/integrations/marketplace-ledger-design-twisp.md)
