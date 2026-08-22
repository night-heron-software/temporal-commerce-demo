# ADR-0022 — One lifecycle id + order-keyed inventory reservations

- **Status:** Accepted (implemented in PRs #105/#106/#107, 2026-07-31)
- **Date:** 2026-07-31
- **Deciders:** platform / inventory
- **Tags:** inventory, identity, data-layer, multi-tenancy
- **Provenance:** duplicated from the parent platform's ADR-0022; held as close to identical as this demo's smaller surface allows.
- **Builds on:** [ADR-0016](0016-inventory-write-path-integrity.md) (CAS counters, journal every
  mutation), [ADR-0011](0011-workflow-id-and-correlation-tagging.md) (workflow IDs + tags)
- **Amends:** [ADR-0019](0019-ambient-correlation-propagation.md) (see §One id below)

> **Divergence from the parent platform.** The demo adopts the **one-lifecycle-id half only** — the cartId is the correlation id (see [ADR-0011](0011-workflow-id-and-correlation-tagging.md)'s 2026-08-12 amendment). The order-keyed reservation model below is **not implemented here**: reservations stay per-variant release-then-re-reserve (`src/temporal/contracts/inventory.ts`).

## Context

Two vocabularies had leaked into the inventory domain: `blank_sku` (POD/catalog — a "blank" is
the undecorated garment) and `variant_id` (catalog — a design placed on a blank). Inventory
counts stock; it needs neither. Reservations were one row per cart-line, keyed by an opaque
`reservation_id` derived as `${cartId}-${variantId}` at ten call sites, and every lifecycle
operation was per-reservation: a checkout confirm cost ~6N Cassandra round-trips for an N-line
cart, releases fanned out per-hold, and callers threaded cartId around solely to re-derive ids.
Separately the platform maintained four identifiers per journey — cartId, correlationId
(ADR-0019's separate UUID), orderId (minted at `createOrder`), and the reservation ids — all
requiring propagation and mapping.

## Decision

### One lifecycle id

A single UUID, minted when the cart is created, plays every role: cart entity id, **orderId**,
inventory reservation key, and correlation value. Surface names stay role-appropriate (cart-land
says cartId, order/inventory-land says orderId, the `CorrelationId` Search Attribute keeps its
name) — but they all carry **the same value**. Nothing is threaded, mapped, or kept in sync;
`createOrder` no longer mints (`orderId = cartId`), and payment authorization records carry the
real orderId even before the order row exists. Order creation is deterministic per journey: a
retried submit reuses the same id.

**One deliberate exception: the checkout workflow's entity id.** Checkout is retryable — a
shopper can abandon and re-enter it — and each attempt must be its own Temporal workflow, so
`packages/cart/src/states.ts` mints a fresh `uuid4()` per attempt rather than reusing the
lifecycle id. That does not fragment the journey: the attempt is started with the cart's
`CorrelationId`, so it still answers the one-id query alongside every other workflow. The
property that matters is correlation, not identity reuse.
*(Corrected 2026-08-01 by validation run 001, which found this section claiming the checkout
entity id was unified when the code deliberately does the opposite.)*

**ADR-0019 amendment:** its ambient-propagation machinery (interceptor headers, journal
partitioning) survives unchanged, but "correlationId is its own UUID distinct from cartId" is
reversed. That separation existed because cartId was being *accidentally* reused as a stand-in
orderId; one deliberate id with a documented role list fixes the same ambiguity without a fourth
identifier.

### Reservations are (orderId, sku, quantity, status)

- **Schema:** `inventory_reservations_w` PK `((store_id, order_id), sku)` — one partition per
  order, one row per sku, tenant in the partition key (invariant #4, which the old tables
  violated). Registry `inventory_reservations_by_status_w` PK `(status, sku, store_id,
  order_id)`: platform sweeps read one partition; preemption is a clustering-prefix read.
  `inventory_reservations_by_cart_w` deleted — the primary IS by-key.
- **Merge semantics:** two cart lines sharing a sku are ONE hold whose quantity is the sum. The
  cart owns the line→sku mapping (`CartItem.sku`, resolved once at add-to-cart) and computes
  per-sku totals at every edit; inventory only counts.
- **Client:** `InventoryClient` (packages/inventory/src/client.ts) — `reserve` (absolute
  quantities; `exact: true` releases skus absent from the set), `commit` (resurrect-if-expired +
  confirm as ONE op), `release` (routes TEMPORARY→RELEASED / CONFIRMED→CANCELLED), `fulfill`,
  `transfer`, `getHolds`. Every op: one partition read → pure `planApply` → per-(sku, fulfiller)
  CAS → one logged batch (registry + journal ride along) → one inventory-changed signal.
- **Idempotency is the row:** absolute quantities make a retried reserve re-apply to the same
  result; status transitions make a retried release a no-op. The row-per-(orderId, sku) shape
  pays for idempotency under Temporal activity retries — not for catalog knowledge.

### The split guard

`selectFulfillerRow` binds a sku group to ONE fulfiller row ("one hold, one counter, one CAS"),
and current plugins resolve a constant fulfiller per fulfiller_type, so no order can split one
sku across fulfillers. `transfer` **throws** if a caller's aggregation implies a split. Escape
hatch if a future plugin needs one: re-cluster to `((store_id, order_id), sku, fulfiller_id)` —
a contained schema change.

### What the CAS invariant looks like now

The counter unit is unchanged: `inventory_stock_w (sku, fulfiller_id)` under compare-and-set
with bounded jittered retry (PR #94). Within one order each sku appears exactly once, so an
op's CASes touch distinct rows and run in parallel — the per-sku serialization PRs #94/#104
enforced procedurally is now structural. `commit`'s resurrect runs under the same bounded retry,
removing the single-shot lost-race hazard #104's analysis identified.

## Consequences

- **Round-trips:** confirm ~6N → ~2; release ~5N → ~2+2S; cart destroy N activities → 1;
  fulfillment transfer/fulfill N sequential ops → one call each; checkout renew loses its N
  catalog reads (skus ride on the items). Payloads shrink to `orderId` + sku subsets.
- **Journal (ADR-0016/0019 preserved):** still partitioned `((store_id, correlation_id))`;
  lifecycle ops journal under the hold's order id (== correlation value), platform mutations
  keep `__platform__`. Columns: `reservation_id`/`variant_id` → `order_id`; `sku`.
- **Boundary:** catalog keeps `variants.blank_sku` (its vocabulary); callers translate at the
  edge. `inventory_fulfillability` (external availability flags) untouched.
- **Costs:** cart edits must recompute per-sku sums (pure, tested); order rows' duplicate
  cart_id/order_id columns are redundant (cleanup deferred); the trace UI loses the per-variant
  chip on inventory events (nothing to disambiguate — holds are per-sku now).

## Alternatives considered

- **Rename-only** (keep per-variant rows) — leaves 2N round-trips and the four-id lifecycle.
- **Quantity-per-line with a separate ledger for retry-dedup** — reinvents the deleted row.
- **orderId minted at createOrder, key threaded backwards** — keeps a cartId↔orderId mapping
  alive everywhere; rejected in favour of minting once at journey start.
