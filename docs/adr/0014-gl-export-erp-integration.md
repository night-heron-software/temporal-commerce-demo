# ADR-0014 — GL export to external accounting systems (QBO first, generic seam)

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** platform operator + accounting
- **Tags:** accounting, integrations
- **Provenance:** duplicated from the parent platform's ADR-0014; held as close to identical as this demo's smaller surface allows.


> **Divergence from the parent platform.** **Not exercised in this demo** — there is no GL export or ERP integration.
> The record is carried for its reasoning, exactly as this corpus already carries 0004
> (multi-tenancy): the parent's decisions explain shapes that are visible here in vestigial or
> mocked form, and re-deciding them per conversation is the waste this file prevents.

## Context

The platform operator's real books live in an external accounting system (QuickBooks Online was
chosen first). The Twisp ledger is the platform's system of record for money, but an accountant
works in the ERP — the ledger must feed it continuously, auditable, and without double-entry drift.
Three design questions: **source** (Twisp vs. the ES `financial_summaries` projection),
**granularity** (per-transaction vs. summarized), and **the adapter seam** (QBO-specific vs.
provider-generic).

## Decision

1. **Source = Twisp, not Elasticsearch.** `financial_summaries` is a single-amount-per-transaction
   convenience projection (rebuildable/lossy by design, ADR-0007/0010) — it cannot produce balanced
   per-account legs. The exporter uses ES only to find the day's correlations, then pulls full
   balanced entries from Twisp (`getOrderJournalEntries`). Entry labels resolve to logical accounts
   via a map **derived from the tran-code templates**
   ([entry-account-map.ts](https://github.com/night-heron-software/nightheron-mono/blob/main/packages/accounting/src/gl-export/entry-account-map.ts)) so the
   export can never drift from what actually posts (an unmapped param fails loud in unit tests).
2. **Granularity = daily summary journal entries** — one external JournalEntry per
   (day, tran code), lines aggregated per (account, direction), **SETTLED layer only** (PENDING
   auth holds and ENCUMBRANCE reserves are internal control layers, not recognized money). External
   systems choke on per-order volume; the Twisp ledger remains the drill-down subledger.
   Per-transaction fidelity is preserved by the CSV exporter. Every batch is balance-asserted
   (Σ DR = Σ CR) before export — an unbalanced batch refuses to export.
3. **Generic seam** ([gl-export/](https://github.com/night-heron-software/nightheron-mono/blob/main/packages/accounting/src/gl-export/)): a `GlExporter`
   interface (`qbo` | `csv` today; Xero/NetSuite = new adapters), an operator-populated
   account-mapping table (`gl_account_mappings`; the exporter **fails loud on unmapped accounts**
   and rejects exclusions that would unbalance a batch), a per-provider checkpoint
   (`gl_export_state`) and export log (`gl_export_log`).
4. **Idempotency:** the batch reference `NH-{yyyymmdd}-{tranCode}` is the QBO `DocNumber`
   (query-before-create + QBO's duplicate-DocNumber rejection); the CSV file path derives from the
   same ref. Re-running any day cannot duplicate entries.
5. **Orchestration:** `exportGlBatchWorkflow` on a daily Temporal Schedule (07:00, after the 06:00
   Stripe↔ledger reconciliation — recon green → books exportable), checkpoint-driven catch-up from
   (checkpoint + 1) through yesterday; a failed batch halts the checkpoint so gaps are impossible.
   Registered only when `USE_GL_EXPORT=true`.
6. **QBO connection:** OAuth2 via `/api/admin/erp/qbo/{connect,callback}`; tokens in
   `erp_connections`, never logged; the rotating refresh token is re-persisted on every refresh.

## Consequences

- **Positive:** the operator's books stay continuously in sync with balanced, auditable summaries;
  the CSV fallback means ERP availability never blocks money movement or closes; adding Xero later
  is one adapter + one mapping set; the tran-code-derived account map makes silent drift structurally
  impossible.
- **Negative / costs:** daily summaries mean the ERP can't drill to order level (by design — the
  ledger is the subledger); the collection path costs one Twisp query per correlation per day;
  operator must maintain the account mapping when the external CoA changes (unmapped accounts stop
  the export loudly).
- **Follow-ups:** seller-facing monthly statements (stretch); Xero adapter when needed; QBO class/
  location dimensions if per-store P&L is wanted in the ERP.

## Alternatives considered

- **Export from `financial_summaries`.** Insufficient: one amount per transaction, no balanced legs;
  also a rebuildable projection, not the system of record. Rejected.
- **Per-transaction export.** Faithful but floods QBO (hundreds of entries/day at modest volume),
  and audits still end up in the platform anyway. Rejected in favor of subledger-style summaries.
- **CSV only (no API adapter).** Manual import burden every close; kept as the fallback, not the
  primary.

## References

[ADR-0002 double-entry ledger](0002-double-entry-ledger-net-revenue.md) ·
[ADR-0008 payments & payout topology](0008-payments-payout-topology.md) ·
[Mixed Accounting Model](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/architecture/mixed-accounting-model.md)
