# ADR-0016 — Inventory write-path integrity

- **Status:** Accepted — **vocabulary + shape updated by [ADR-0022](0022-one-lifecycle-id-order-keyed-inventory.md)
  (2026-07-31):** `blank_sku` → `sku`; reservations re-keyed `((store_id, order_id), sku)` with
  per-sku merged quantities. The invariants here are UNCHANGED: counters move only under CAS on
  `inventory_stock_w (sku, fulfiller_id)`, and every mutation journals to `inventory_history`.
  The row-per-(orderId, sku) shape pays for idempotency under activity retries, not for catalog
  knowledge — inventory knows nothing about variants.
- **Date:** 2026-07-25
- **Deciders:** platform operator + inventory
- **Tags:** inventory, cassandra, correctness
- **Provenance:** duplicated from the parent platform's ADR-0016; held as close to identical as this demo's smaller surface allows.

> **Divergence from the parent platform.** The demo implements the CAS stock counters and the reserve → confirm → release lifecycle. It does **not** implement the attributed-counter fulfiller split, expiry-only preemption, or the drift reconciler — its inventory is a pattern demo, seeded once, single-source.

## Context

The platform's core inventory invariant — no oversell — was not actually held. A review of the
write path (and the same review in the `temporal-commerce-demo` sibling, whose findings were
explicitly flagged as shared) found five structural holes in
`inventory-command-repository.ts` (parent platform):

1. **Only `reserve()` was guarded.** `release`, `cancel`, and `fulfill` were plain
   read-modify-write against `reserved_stock`, so any two concurrent lifecycle events on a SKU
   could lose one of their decrements. `Math.max(0, …)` then hid the resulting underflow.
2. **Reservations were not attributed to a fulfiller.** `reserve()` picked a specific stock row
   and incremented *that* row's counter, but wrote `fulfiller_id = null` onto the reservation.
   `release()` therefore guessed `stockRows[0]` — on a multi-fulfiller SKU it routinely
   decremented a row that had never held the units, corrupting two counters at once.
3. **Preemption evicted live holds.** Eligibility was `now > created_at + 15min`. Renewal extends
   `expires_at` without touching `created_at`, so an active checkout became preemptable purely by
   age — and because stock is a platform-global pool, one store's oversized cart could take
   another store's live hold.
4. **Pay-after-expiry produced phantom inventory.** `confirm()` had no status or expiry guard. If
   the expiry sweep released a hold while the shopper sat on the payment step, `confirm()` still
   flipped the row to CONFIRMED and re-inserted it into the active registry — but the
   `reserved_stock` had already been given back. The unit shipped and `total_stock` never came
   down. Nothing about the resulting state is inconsistent, so no reconciler could ever detect it.
5. **Checkout reassigned every hold to `stock LIMIT 1`.** `confirmReservations` transferred each
   reservation to whichever fulfiller row came back first, discarding attribution entirely.

Two structural facts constrain the fix. Stock is global per `(blank_sku, fulfiller_id)`
([core-schema.cql](../../cassandra/schema.cql)) — reservations are not store-partitioned.
And **Cassandra cannot put a cross-partition batch behind an LWT**: the stock compare-and-set and
the three reservation-row writes are unavoidably two operations.

## Decision

**Guard every counter mutation, attribute every hold, and heal what atomicity cannot cover.**

### Attribution

`reserve()` writes the fulfiller row it incremented onto all three reservation rows. Every
subsequent decrement targets that row via `releaseAttributedCounter`. A row with no
`fulfiller_id` is pre-attribution debris: it is reported, never guessed at.

Row selection moved from `.find()` (first row that fits) to `selectFulfillerRow` (most available).
Max-available spreads concurrent reserves for a SKU across partitions instead of piling every
compare-and-set onto whichever row the driver returned first — the main source of spurious
contention failures. A group is never split across rows: if no single row covers the quantity, the
reserve fails even when the rows sum to enough.

### Compare-and-set everywhere

`casAdjustStock` is the single mutation point: read → compute → `UPDATE … IF reserved_stock = ?`,
three attempts with jittered backoff. On exhaustion it throws `InventoryContentionError`, which
callers surface to Temporal's retry policy — contention is transient, unlike genuine insufficient
stock. An underflow is still clamped to zero, but logged at **error**; it is now a drift signal
rather than a silent correction.

Terminal operations flip the reservation's **status before** decrementing. A failure between the
two then leaves stock held against a dead hold — under-selling, which the reconciler heals — rather
than freed stock against a hold that still looks live, which is an oversell.

### Grouping

`reserveGroup` takes **one CAS per `blank_sku`** covering all of a cart's variants on that blank,
then writes one reservation row per variant. Two variants of the same blank previously issued two
competing compare-and-sets against the same partition, so one lost and the whole cart failed. The
per-variant rows are what keep every downstream lookup (fulfillment transfer/fulfill/release, cart
release, reconcile) addressing a row that exists. Reservation ids come from
`Inventory.buildReservationId(cartId, variantId)` in contracts — previously derived at eight
separate call sites.

### Expired-only preemption

`selectPreemptibleReservations` accepts a candidate only when `expires_at < now`. Live holds are
never touched at any age. Preempting an expired hold is just an inline version of what the sweep
would do minutes later; preempting a live one is taking stock from an active shopper.

### Pay-after-expiry: re-acquire, or refuse the order

`confirm()` returns a `ConfirmOutcome` and only accepts a live `TEMPORARY` hold. Checkout confirms
in two phases: `resurrect()` re-acquires any hold that was released — back to `TEMPORARY`, under a
fresh availability-checked CAS, **never straight to CONFIRMED** — and only then does the confirm
run. If the stock is genuinely gone, the submit fails **before `createOrder`** and refunds, with a
deterministic idempotency key so a Temporal retry cannot double-refund. `fulfill()` keeps a
backstop for anything that slips through: a shipped-but-unheld reservation decrements `total_stock`
only, never double-counting the release.

### The reconciler

`reconcileStockCounters` recomputes every `reserved_stock` from the active reservation rows
(`computeExpectedReserved`) and CAS-corrects the difference, on the `inventory-reconcile` Schedule
(15m, `STOCK_RECONCILE_SCHEDULE_ID`). This is the deliberate answer to the non-atomic CAS-then-rows
pair: rather than trying to prevent every interleaving, the write path fails toward under-selling
and this heals the rest. Corrections log at **warn** — drift is a bug signal — and the
unattributed-rows report is deduped by id-set so a recurring sweep does not re-report the same
debris every cycle.

## Consequences

- **The invariant now holds** under concurrency: `reserved_stock` on a fulfiller row equals the sum
  of active reservations attributed to it, continuously repaired.
- **Failures resolve toward under-selling.** A stuck decrement briefly holds unsellable stock; the
  reconciler releases it. The reverse (freed stock, live-looking hold) is no longer reachable.
- **`confirmReservations` can fail**, and callers must handle it. This is a behavioural change: a
  submit can now be refused after a successful payment. That is strictly better than the
  alternative, which was shipping goods the platform had not counted.
- **Fulfiller assignment is no longer decided at confirm time.** The hold keeps its reserve-time
  attribution; real assignment happens in OMS, and `transferToFulfiller` moves the counter between
  rows rather than only rewriting a label.
- **Contention surfaces as a retry, not a failed cart.** `InventoryContentionError` is retryable.
- **Amends [ADR-0004](0004-multi-tenant-shared-infrastructure-store-id.md).** Its "deliberately not
  store-scoped" carve-out for the global inventory pool still stands, but the cross-tenant
  consequence is narrower: preemption can no longer reach another store's *live* hold, only an
  expired one.

### Deferred

Tenancy levers stay out of scope: stock remains platform-global per `(blank_sku, fulfiller_id)`, so
stores still draw from one pool. Expired-only preemption removes the sharpest edge (evicting
another store's live hold) but not the sharing itself. Store-scoped keys, per-store soft
allocations for contested SKUs, and a store-aware availability projection are recorded as future
levers in the inventory overhaul plan (parent platform), whose
Phase 1 this ADR completes. Phases 2–5 (dirty-marker projections, queue-routed mutations,
`inventoryStrategy` honouring, supplier seams) remain planned.
