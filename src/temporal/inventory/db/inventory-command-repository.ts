import { Inventory } from '../../contracts';
import { buildReservationId } from '../../contracts/inventory';
/**
 * Inventory Command Repository (CQRS Write Side)
 *
 * Handles all inventory mutations using Cassandra write tables with
 * Lightweight Transactions (LWT) for atomicity on critical operations.
 */

import { Context } from '@temporalio/activity';
import { executeCql, executeBatch, getCassandraClient } from '../../../lib';
import { logger } from '../../../lib';
import { signalInventoryChanged } from '../inventory-signal';

// ============================================================
// Types
// ============================================================

export const UNLIMITED_STOCK = -1;

function isUnlimited(totalStock: number): boolean {
  return totalStock === UNLIMITED_STOCK;
}

/**
 * Sum available stock (total − reserved) across a SKU's fulfiller rows.
 * Any fulfiller with UNLIMITED_STOCK makes the SKU effectively infinite.
 * Pure — shared by getStockLevel() and both aggregation points in reserve().
 */
export function computeTotalAvailable(
  rows: Array<{ total_stock: number; reserved_stock: number }>,
): number {
  if (rows.some((r) => isUnlimited(r.total_stock))) return Number.MAX_SAFE_INTEGER;
  return rows.reduce((sum, r) => sum + (r.total_stock - r.reserved_stock), 0);
}

/**
 * Pick which expired TEMPORARY reservations to preempt so a new reservation of
 * `quantityNeeded` can fit. Pure decision logic (I/O stays in the reserve path).
 *
 * Only reservations whose TTL has lapsed qualify — live holds are never touched, no matter
 * how old. Age is deliberately NOT the gate: renewals extend `expires_at` without touching
 * `created_at`, so a wall-clock-old hold can still belong to an active checkout. Preempting
 * an expired hold is just an inline version of what the expiry sweep would do minutes later.
 * Oldest are preempted first (FIFO) and preemption stops once enough stock is freed.
 */
export function selectPreemptibleReservations<
  T extends { quantity: number; created_at: Date; expires_at: Date | null },
>(
  candidates: T[],
  opts: {
    totalAvailable: number;
    quantityNeeded: number;
    nowMs: number;
  },
): T[] {
  const expired = candidates
    .filter((r) => r.expires_at !== null && r.expires_at.getTime() < opts.nowMs)
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  let freedStock = 0;
  const toPreempt: T[] = [];
  for (const r of expired) {
    if (opts.totalAvailable + freedStock >= opts.quantityNeeded) break;
    freedStock += r.quantity;
    toPreempt.push(r);
  }
  return toPreempt;
}

/** One per-variant reservation row to create within a single blank_sku group. */
export interface ReservationEntry {
  reservationId: string;
  variantId: string;
  quantity: number;
}

/**
 * Group cart items by blank_sku into per-variant reservation entries.
 *
 * The grouping preserves PR #17's contention fix — one LWT CAS per blank_sku partition —
 * while every variant keeps its OWN reservation row keyed `buildReservationId(cartId,
 * variantId)`, so all lookup sites (fulfillment transfer/fulfill/release, cart release,
 * reconcile) address rows that actually exist. Pure — exported for the regression test.
 */
export function groupItemsByBlankSku(
  cartId: string,
  items: Array<{ variantId: string; blankSku: string; quantity: number }>,
): Map<string, ReservationEntry[]> {
  const groups = new Map<string, ReservationEntry[]>();
  for (const item of items) {
    const entry: ReservationEntry = {
      reservationId: buildReservationId(cartId, item.variantId),
      variantId: item.variantId,
      quantity: item.quantity,
    };
    const group = groups.get(item.blankSku);
    if (group) group.push(entry);
    else groups.set(item.blankSku, [entry]);
  }
  return groups;
}

/**
 * Recompute what reserved_stock SHOULD be per (blank_sku, fulfiller_id) from the active
 * reservation rows. Pure — the drift reconciler compares this against inventory_stock_w and
 * CAS-corrects. Rows without an attributed fulfiller cannot be attributed to a counter and
 * are skipped (they should not exist now that reserve() stamps the fulfiller at creation;
 * the reconciler logs any it sees).
 */
export function computeExpectedReserved(
  rows: Array<{ blank_sku: string; fulfiller_id: string | null; quantity: number }>,
): Map<string, number> {
  const expected = new Map<string, number>();
  for (const row of rows) {
    if (!row.fulfiller_id) continue;
    const key = `${row.blank_sku}|${row.fulfiller_id}`;
    expected.set(key, (expected.get(key) ?? 0) + row.quantity);
  }
  return expected;
}

/**
 * LWT contention on the stock counter. Activities rethrow this so Temporal's retry policy
 * takes over — contention is transient and retryable, unlike genuine insufficient stock.
 */
export class InventoryContentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryContentionError';
  }
}

export interface StockLevel {
  total: number;
  reserved: number;
  available: number;
}

export interface SetFulfillerStockArgs {
  fulfillerId: string;
  fulfillerName: string;
  cost: number;
  totalStock: number;
  orderedStock?: number;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface SetFulfillerStockResult {
  fulfillerId: string;
  previousStock: number;
  newStock: number;
  available: number;
}

export interface ReserveArgs {
  reservationId: string;
  blankSku: string;
  cartId: string;
  variantId: string;
  quantity: number;
  referenceId: string;
  ttlSeconds: number;
}

export interface ReserveResult {
  success: boolean;
  reservationId?: string;
  error?: string;
  /** True when the failure was LWT contention — transient, retry-worthy. */
  contention?: boolean;
}

export interface BatchReserveResult {
  success: boolean;
  reservations?: Array<{ variantId: string; reservationId: string }>;
  error?: string;
  /** True when any underlying failure was LWT contention — transient, retry-worthy. */
  contention?: boolean;
}

export interface ReservationRecord {
  reservationId: string;
  blankSku: string;
  cartId: string;
  variantId: string;
  fulfillerId: string | null;
  quantity: number;
  referenceId: string;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// Cassandra Row Types
// ============================================================

interface StockRow {
  blank_sku: string;
  fulfiller_id: string;
  fulfiller_name: string;
  total_stock: number;
  reserved_stock: number;
  ordered_stock: number;
  cost: number;
  updated_at: Date;
}

interface ReservationRow {
  reservation_id: string;
  blank_sku: string;
  cart_id: string;
  variant_id: string;
  fulfiller_id: string | null;
  quantity: number;
  reference_id: string;
  status: string;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface CartReservationRow {
  cart_id: string;
  reservation_id: string;
  blank_sku: string;
  variant_id: string;
  quantity: number;
  status: string;
}

// ============================================================
// Row Mappers
// ============================================================

// ============================================================
// Active-reservation registry (inventory_reservations_by_status_w)
// ============================================================
// Single source for the registry's statements and reads. The by_status mirror
// must travel with every main-table mutation; building the statements here makes
// a forgotten or mis-keyed mirror a compile-time absence instead of silent drift,
// and keeps the table name + partition literals in one place.

/** DELETE the registry row — MUST be keyed by the PRE-mutation status (its partition). */
function activeRegistryDelete(priorStatus: string, reservationId: string) {
  return {
    query: `DELETE FROM inventory_reservations_by_status_w
            WHERE status = ? AND reservation_id = ?`,
    params: [priorStatus, reservationId] as unknown[],
  };
}

/** INSERT a registry row under its (new) status partition. */
function activeRegistryInsert(row: {
  status: 'TEMPORARY' | 'CONFIRMED';
  reservation_id: string;
  blank_sku: string;
  cart_id: string;
  variant_id: string;
  fulfiller_id: string | null;
  quantity: number;
  reference_id: string;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    query: `INSERT INTO inventory_reservations_by_status_w (
      status, reservation_id, blank_sku, cart_id, variant_id, fulfiller_id,
      quantity, reference_id, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      row.status,
      row.reservation_id,
      row.blank_sku,
      row.cart_id,
      row.variant_id,
      row.fulfiller_id,
      row.quantity,
      row.reference_id,
      row.expires_at,
      row.created_at,
      row.updated_at,
    ] as unknown[],
  };
}

/** Read one active-status partition (the working set for that status). */
function readActiveStatusPartition(status: 'TEMPORARY' | 'CONFIRMED'): Promise<ReservationRow[]> {
  return executeCql<ReservationRow>(
    `SELECT * FROM inventory_reservations_by_status_w WHERE status = ?`,
    [status],
  );
}

// ============================================================
// Inventory history journal (inventory_history)
// ============================================================
// Append-only, correlation-keyed (cart_id = correlationId, ADR-0011) record of every
// inventory mutation — the order-trace tool reads it to show inventory operations
// alongside the workflows that performed them. History statements ride inside each
// operation's existing batch where one exists (atomic with the mutation); everything
// else (failed reserves, drift corrections) is written best-effort.

/** Partition key used for operations that have no owning cart (drift corrections). */
export const PLATFORM_CART_ID = '__platform__';

export type HistoryOperation =
  | 'RESERVE'
  | 'RESERVE_FAILED'
  | 'RENEW'
  | 'CONFIRM'
  | 'RELEASE'
  | 'CANCEL'
  | 'FULFILL'
  | 'TRANSFER'
  | 'DRIFT_CORRECTION';

/** One inventory-history event to journal. `actor`/`at` default at statement-build time. */
export interface HistoryEvent {
  cartId: string;
  operation: HistoryOperation;
  reservationId?: string;
  blankSku?: string;
  variantId?: string;
  fulfillerId?: string | null;
  quantity?: number;
  priorStatus?: string | null;
  newStatus?: string | null;
  referenceId?: string;
  /** Acting workflowId or system actor; defaults to resolveActor(). */
  actor?: string;
  /** Structured extras (error, contention, counter before/after, forCart, …) — stored as JSON. */
  details?: Record<string, unknown>;
  at?: Date;
}

/** An inventory_history row read back, camelCased with `details` JSON-parsed. */
export interface InventoryHistoryRecord {
  cartId: string;
  at: Date;
  seq: number;
  operation: string;
  reservationId: string | null;
  blankSku: string | null;
  variantId: string | null;
  fulfillerId: string | null;
  quantity: number | null;
  priorStatus: string | null;
  newStatus: string | null;
  referenceId: string | null;
  actor: string;
  details: unknown;
}

interface InventoryHistoryRow {
  cart_id: string;
  at: Date;
  seq: number;
  operation: string;
  reservation_id: string | null;
  blank_sku: string | null;
  variant_id: string | null;
  fulfiller_id: string | null;
  quantity: number | null;
  prior_status: string | null;
  new_status: string | null;
  reference_id: string | null;
  actor: string;
  details: string | null;
}

/**
 * Per-process monotonic tiebreak within a timestamp. Reset per process; (at, seq)
 * collisions across processes are tolerable — the journal is append-only and distinct
 * workers rarely share a millisecond within one cart partition.
 */
let historySeq = 0;

/**
 * Who performed the mutation: the acting workflowId when we are inside a Temporal
 * activity, else 'api'.
 *
 * This deliberately deviates from the transition recorder's pattern of passing
 * `workflowInfo()` down as data: threading an actor parameter through every repository
 * call would churn the signatures used by all four activities-impl files, whereas
 * `Context.current()` (AsyncLocalStorage under the hood) already knows the scheduling
 * workflow — and the only non-activity caller (the seed-inventory route) correctly falls
 * back to 'api' via the catch.
 */
function resolveActor(): string {
  try {
    return Context.current().info.workflowExecution?.workflowId ?? 'api';
  } catch {
    return 'api'; // not inside an activity (e.g. the seed-inventory route)
  }
}

/**
 * Build one inventory_history INSERT. Consumes the module seq counter; actor and
 * timestamp default here so call sites stay declarative. Exported for the pure
 * statement-shape tests.
 */
export function historyInsert(event: HistoryEvent): { query: string; params: unknown[] } {
  return {
    query: `INSERT INTO inventory_history (
      cart_id, at, seq, operation, reservation_id, blank_sku, variant_id,
      fulfiller_id, quantity, prior_status, new_status, reference_id, actor, details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      event.cartId,
      event.at ?? new Date(),
      historySeq++,
      event.operation,
      event.reservationId ?? null,
      event.blankSku ?? null,
      event.variantId ?? null,
      event.fulfillerId ?? null,
      event.quantity ?? null,
      event.priorStatus ?? null,
      event.newStatus ?? null,
      event.referenceId ?? null,
      event.actor ?? resolveActor(),
      event.details ? JSON.stringify(event.details) : null,
    ] as unknown[],
  };
}

/**
 * Standalone best-effort journal write for events with no batch to ride in (failed
 * reserves, drift corrections). Logs and swallows failures — history must never break
 * the mutation path it observes.
 */
async function recordHistoryBestEffort(event: HistoryEvent): Promise<void> {
  try {
    const stmt = historyInsert(event);
    await executeCql(stmt.query, stmt.params);
  } catch (err) {
    logger.error(
      { err, operation: event.operation, cartId: event.cartId },
      'Inventory history write failed (best-effort — mutation unaffected)',
    );
  }
}

function rowToHistoryRecord(row: InventoryHistoryRow): InventoryHistoryRecord {
  let details: unknown = null;
  if (row.details != null) {
    try {
      details = JSON.parse(row.details);
    } catch {
      details = row.details; // keep the raw string if it was never valid JSON
    }
  }
  return {
    cartId: row.cart_id,
    at: row.at,
    seq: row.seq,
    operation: row.operation,
    reservationId: row.reservation_id,
    blankSku: row.blank_sku,
    variantId: row.variant_id,
    fulfillerId: row.fulfiller_id,
    quantity: row.quantity,
    priorStatus: row.prior_status,
    newStatus: row.new_status,
    referenceId: row.reference_id,
    actor: row.actor,
    details,
  };
}

function rowToReservation(row: ReservationRow): ReservationRecord {
  return {
    reservationId: row.reservation_id,
    blankSku: row.blank_sku,
    cartId: row.cart_id,
    variantId: row.variant_id,
    fulfillerId: row.fulfiller_id,
    quantity: row.quantity,
    referenceId: row.reference_id,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================
// Guarded counter mutation
// ============================================================

const CAS_MAX_ATTEMPTS = 3;

/**
 * Adjust a stock row's counters via compare-and-set with a small jittered retry.
 *
 * All counter mutations go through here so none of them is a lost-update race: read the row,
 * compute the new values, apply IFF `reserved_stock` is still what we read. On exhausted
 * attempts this THROWS — callers run inside Temporal activities whose retry policy takes
 * over, and the drift reconciler is the final backstop. An underflow (drift already present)
 * is clamped to zero but logged at error level — never silently.
 */
async function casAdjustStock(
  blankSku: string,
  fulfillerId: string,
  reservedDelta: number,
  totalDelta = 0,
): Promise<void> {
  const client = await getCassandraClient();

  for (let attempt = 1; attempt <= CAS_MAX_ATTEMPTS; attempt++) {
    const rows = await executeCql<StockRow>(
      `SELECT total_stock, reserved_stock FROM inventory_stock_w
       WHERE blank_sku = ? AND fulfiller_id = ?`,
      [blankSku, fulfillerId],
    );
    if (rows.length === 0) {
      throw new Error(`Stock row not found for SKU ${blankSku} / fulfiller ${fulfillerId}`);
    }
    const current = rows[0];

    let newReserved = current.reserved_stock + reservedDelta;
    if (newReserved < 0) {
      logger.error(
        { blankSku, fulfillerId, reserved: current.reserved_stock, reservedDelta },
        'reserved_stock underflow — counter drift detected, clamping to 0',
      );
      newReserved = 0;
    }
    const newTotal =
      totalDelta === 0 || isUnlimited(current.total_stock)
        ? current.total_stock
        : current.total_stock + totalDelta;

    const result = await client.execute(
      `UPDATE inventory_stock_w
       SET reserved_stock = ?, total_stock = ?, updated_at = toTimestamp(now())
       WHERE blank_sku = ? AND fulfiller_id = ?
       IF reserved_stock = ?`,
      [newReserved, newTotal, blankSku, fulfillerId, current.reserved_stock],
      { prepare: true },
    );
    if (result.rows[0]['[applied]']) return;

    logger.warn(
      { blankSku, fulfillerId, attempt },
      'Stock counter CAS not applied — concurrent modification, retrying',
    );
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 75));
  }

  throw new InventoryContentionError(
    `Stock counter CAS exhausted after ${CAS_MAX_ATTEMPTS} attempts for ${blankSku}/${fulfillerId}`,
  );
}

// ============================================================
// Repository
// ============================================================

export const InventoryCommandRepository = {
  // --- Stock Operations ---

  /**
   * Set (upsert) fulfiller stock for a SKU.
   */
  async setFulfillerStock(
    blankSku: string,
    args: SetFulfillerStockArgs,
  ): Promise<SetFulfillerStockResult> {
    // Read current stock for the return value
    const existing = await executeCql<StockRow>(
      `SELECT total_stock, reserved_stock FROM inventory_stock_w
       WHERE blank_sku = ? AND fulfiller_id = ?`,
      [blankSku, args.fulfillerId],
    );
    const previousStock = existing.length > 0 ? existing[0].total_stock : 0;

    await executeCql(
      `INSERT INTO inventory_stock_w (
        blank_sku, fulfiller_id, fulfiller_name, total_stock, reserved_stock,
        ordered_stock, cost, address1, address2, city, state, postal_code,
        country, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, toTimestamp(now()))`,
      [
        blankSku,
        args.fulfillerId,
        args.fulfillerName,
        args.totalStock,
        existing.length > 0 ? existing[0].reserved_stock : 0,
        args.orderedStock ?? 0,
        args.cost,
        args.address1,
        args.address2 ?? null,
        args.city,
        args.state,
        args.postalCode,
        args.country,
      ],
    );

    const reservedStock = existing.length > 0 ? existing[0].reserved_stock : 0;
    const result = {
      fulfillerId: args.fulfillerId,
      previousStock,
      newStock: args.totalStock,
      available: args.totalStock - reservedStock,
    };

    await signalInventoryChanged([blankSku]);
    return result;
  },

  /**
   * Get stock level for a SKU across all fulfillers (from write tables).
   * Used internally by mutations that need current state.
   */
  async getStockLevel(blankSku: string): Promise<Inventory.StockLevel> {
    const rows = await executeCql<StockRow>(
      `SELECT total_stock, reserved_stock FROM inventory_stock_w WHERE blank_sku = ?`,
      [blankSku],
    );
    const reserved = rows.reduce((sum, r) => sum + r.reserved_stock, 0);
    const available = computeTotalAvailable(rows);
    if (rows.some((r) => isUnlimited(r.total_stock))) {
      return { total: UNLIMITED_STOCK, reserved, available };
    }
    const total = rows.reduce((sum, r) => sum + r.total_stock, 0);
    return { total, reserved, available };
  },

  // --- Reservation Lifecycle ---

  /**
   * Reserve a group of per-variant entries that share one blank_sku.
   *
   * The core of the reserve path: ONE LWT CAS on the chosen fulfiller row for the group's
   * total quantity (PR #17's contention fix), then one reservation ROW PER VARIANT — each
   * keyed `buildReservationId(cartId, variantId)` and attributed to the fulfiller whose
   * counter was incremented, so release/cancel/fulfill can decrement the right row later.
   *
   * PREEMPTION: if available stock is insufficient, expired TEMPORARY holds on this SKU are
   * released FIFO (an inline expiry sweep) — live holds are never preempted.
   *
   * If the record batch fails after the LWT applied, the increment is compensated; if the
   * compensation also fails, the drift reconciler heals the counter at the next sweep.
   */
  async reserveGroup(
    blankSku: string,
    cartId: string,
    entries: ReservationEntry[],
    referenceId: string,
    ttlSeconds: number,
  ): Promise<ReserveResult> {
    const quantity = entries.reduce((sum, e) => sum + e.quantity, 0);

    const stockRows = await executeCql<StockRow>(
      `SELECT fulfiller_id, total_stock, reserved_stock FROM inventory_stock_w
       WHERE blank_sku = ?`,
      [blankSku],
    );

    if (stockRows.length === 0) {
      return { success: false, error: `No stock found for SKU: ${blankSku}` };
    }

    // Calculate total available across all fulfillers
    let totalAvailable = computeTotalAvailable(stockRows);

    // If not enough available, release expired TEMPORARY holds on this SKU (inline sweep)
    if (totalAvailable < quantity) {
      // Per-SKU partition read on the projected read table — cost tracks THIS SKU's
      // reservations, not the site-wide working set. The projection lags by up to the
      // ~5m consistency sweep, which is safe here: only expired holds qualify, and
      // release() re-checks the source of truth (terminal guard), so a stale row
      // fails closed rather than double-freeing.
      const skuRows = await executeCql<{
        reservation_id: string;
        cart_id: string;
        quantity: number;
        status: string;
        expires_at: Date | null;
        created_at: Date;
      }>(
        `SELECT reservation_id, cart_id, quantity, status, expires_at, created_at
         FROM inventory_reservations_by_sku WHERE blank_sku = ?`,
        [blankSku],
      );
      const preemptable = skuRows.filter((r) => r.status === 'TEMPORARY');

      const toPreempt = selectPreemptibleReservations(preemptable, {
        totalAvailable,
        quantityNeeded: quantity,
        nowMs: Date.now(),
      });
      const freedStock = toPreempt.reduce((sum, r) => sum + r.quantity, 0);

      if (totalAvailable + freedStock >= quantity) {
        for (const r of toPreempt) {
          logger.info(
            { preemptedReservation: r.reservation_id, blankSku, forCart: cartId },
            'Preempting expired TEMPORARY reservation',
          );
          await this.release(r.reservation_id, 'preemption', { forCart: cartId });
        }

        // Re-read stock after preemption
        const freshRows = await executeCql<StockRow>(
          `SELECT fulfiller_id, total_stock, reserved_stock FROM inventory_stock_w
           WHERE blank_sku = ?`,
          [blankSku],
        );
        stockRows.length = 0;
        stockRows.push(...freshRows);
        totalAvailable = computeTotalAvailable(freshRows);
      }
    }

    // Pick the fulfiller with the MOST available stock (spreads CAS contention and leaves
    // the most room for concurrent reserves, unlike first-match).
    const eligible = stockRows.filter(
      (r) => isUnlimited(r.total_stock) || r.total_stock - r.reserved_stock >= quantity,
    );
    const fulfiller = eligible.reduce<StockRow | null>((best, r) => {
      if (!best) return r;
      const availOf = (row: StockRow) =>
        isUnlimited(row.total_stock)
          ? Number.MAX_SAFE_INTEGER
          : row.total_stock - row.reserved_stock;
      return availOf(r) > availOf(best) ? r : best;
    }, null);

    if (!fulfiller) {
      const error = `Insufficient stock. Requested: ${quantity}, Available: ${totalAvailable}`;
      // Failed reserves are exactly what you want visible when debugging an order.
      await recordHistoryBestEffort({
        cartId,
        operation: 'RESERVE_FAILED',
        blankSku,
        quantity,
        referenceId,
        details: { error, contention: false },
      });
      return { success: false, error };
    }

    // LWT: atomically increment reserved_stock only if unchanged since our read
    const client = await getCassandraClient();
    const newReserved = fulfiller.reserved_stock + quantity;
    const result = await client.execute(
      `UPDATE inventory_stock_w
       SET reserved_stock = ?, updated_at = toTimestamp(now())
       WHERE blank_sku = ? AND fulfiller_id = ?
       IF reserved_stock = ?`,
      [newReserved, blankSku, fulfiller.fulfiller_id, fulfiller.reserved_stock],
      { prepare: true },
    );

    const applied = result.rows[0]['[applied]'];
    if (!applied) {
      logger.warn(
        { blankSku, fulfillerId: fulfiller.fulfiller_id },
        'LWT not applied for reserve, concurrent modification detected',
      );
      const error = 'Concurrent modification, retry needed';
      await recordHistoryBestEffort({
        cartId,
        operation: 'RESERVE_FAILED',
        blankSku,
        fulfillerId: fulfiller.fulfiller_id,
        quantity,
        referenceId,
        details: { error, contention: true },
      });
      return { success: false, contention: true, error };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    // Insert per-variant reservation records + mirrors, attributed to the fulfiller whose
    // counter we just incremented.
    const statements = entries.flatMap((entry) => [
      {
        query: `INSERT INTO inventory_reservations_w (
          reservation_id, blank_sku, cart_id, variant_id, fulfiller_id,
          quantity, reference_id, status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'TEMPORARY', ?, ?, ?)`,
        params: [
          entry.reservationId,
          blankSku,
          cartId,
          entry.variantId,
          fulfiller.fulfiller_id,
          entry.quantity,
          referenceId,
          expiresAt,
          now,
          now,
        ] as unknown[],
      },
      {
        query: `INSERT INTO inventory_reservations_by_cart_w (
          cart_id, reservation_id, blank_sku, variant_id, quantity, status
        ) VALUES (?, ?, ?, ?, ?, 'TEMPORARY')`,
        params: [cartId, entry.reservationId, blankSku, entry.variantId, entry.quantity],
      },
      activeRegistryInsert({
        status: 'TEMPORARY',
        reservation_id: entry.reservationId,
        blank_sku: blankSku,
        cart_id: cartId,
        variant_id: entry.variantId,
        fulfiller_id: fulfiller.fulfiller_id,
        quantity: entry.quantity,
        reference_id: referenceId,
        expires_at: expiresAt,
        created_at: now,
        updated_at: now,
      }),
      // History rides in the record batch — atomic with the reservation rows.
      historyInsert({
        cartId,
        operation: 'RESERVE',
        reservationId: entry.reservationId,
        blankSku,
        variantId: entry.variantId,
        fulfillerId: fulfiller.fulfiller_id,
        quantity: entry.quantity,
        newStatus: 'TEMPORARY',
        referenceId,
        details: { counterBefore: fulfiller.reserved_stock, counterAfter: newReserved },
        at: now,
      }),
    ]);

    try {
      await executeBatch(statements);
    } catch (err) {
      // Compensate the counter so the LWT increment doesn't leak as a phantom hold.
      logger.error(
        { blankSku, cartId, err },
        'Reservation record batch failed after LWT — compensating counter',
      );
      try {
        await casAdjustStock(blankSku, fulfiller.fulfiller_id, -quantity);
      } catch (compErr) {
        // Reconciler heals: counter > sum(active reservations) is corrected at next sweep.
        logger.error(
          { blankSku, err: compErr },
          'Counter compensation failed — reconciler will heal',
        );
      }
      return { success: false, error: 'Failed to write reservation records' };
    }

    logger.info(
      {
        blankSku,
        cartId,
        fulfillerId: fulfiller.fulfiller_id,
        quantity,
        reservationIds: entries.map((e) => e.reservationId),
      },
      'Reserved inventory',
    );

    await signalInventoryChanged([blankSku]);
    return { success: true };
  },

  /**
   * Reserve inventory for a single item. Thin wrapper over reserveGroup().
   */
  async reserve(args: ReserveArgs): Promise<ReserveResult> {
    const result = await this.reserveGroup(
      args.blankSku,
      args.cartId,
      [{ reservationId: args.reservationId, variantId: args.variantId, quantity: args.quantity }],
      args.referenceId,
      args.ttlSeconds,
    );
    return result.success ? { success: true, reservationId: args.reservationId } : result;
  },

  /**
   * Release a reservation (checkout cancel, timeout, or failure).
   *
   * Status flips FIRST, counter decrements SECOND — deliberately. If the decrement fails
   * after the flip, a retry hits the terminal guard (no double-decrement) and the row is
   * already gone from the active registry, so the drift reconciler lowers the counter at
   * the next sweep. The reverse order risks decrementing twice, which is the oversell
   * direction — this order fails safe.
   *
   * `reason` labels system-initiated releases in the history journal ('expiry-sweep' from
   * the expiry activity, 'preemption' from reserveGroup's inline sweep — with
   * `extraDetails.forCart` naming the requesting cart); omitted, the history actor is the
   * calling workflow (or 'api').
   */
  async release(
    reservationId: string,
    reason?: string,
    extraDetails?: Record<string, unknown>,
  ): Promise<void> {
    const rows = await executeCql<ReservationRow>(
      `SELECT * FROM inventory_reservations_w WHERE reservation_id = ?`,
      [reservationId],
    );

    if (rows.length === 0) {
      logger.warn({ reservationId }, 'Reservation not found for release');
      return;
    }

    const reservation = rows[0];

    if (
      reservation.status === 'RELEASED' ||
      reservation.status === 'FULFILLED' ||
      reservation.status === 'CANCELLED'
    ) {
      logger.warn({ reservationId, status: reservation.status }, 'Reservation already terminal');
      return;
    }

    const fulfillerId = reservation.fulfiller_id;
    if (!fulfillerId) {
      throw new Error(`Reservation ${reservationId} has no attributed fulfiller ID on release`);
    }

    // Flip status and remove from cart lookup + active registry
    await executeBatch([
      {
        query: `UPDATE inventory_reservations_w
                SET status = 'RELEASED', updated_at = toTimestamp(now())
                WHERE reservation_id = ?`,
        params: [reservationId],
      },
      {
        query: `DELETE FROM inventory_reservations_by_cart_w
                WHERE cart_id = ? AND reservation_id = ?`,
        params: [reservation.cart_id, reservationId],
      },
      activeRegistryDelete(reservation.status, reservationId),
      historyInsert({
        cartId: reservation.cart_id,
        operation: 'RELEASE',
        reservationId,
        blankSku: reservation.blank_sku,
        variantId: reservation.variant_id,
        fulfillerId,
        quantity: reservation.quantity,
        priorStatus: reservation.status,
        newStatus: 'RELEASED',
        referenceId: reservation.reference_id,
        // System-initiated releases carry their sweep/preemption label as the actor.
        actor: reason,
        details:
          reason || extraDetails ? { ...(reason ? { reason } : {}), ...extraDetails } : undefined,
      }),
    ]);

    // Decrement the counter on the reservation's OWN fulfiller row (attributed at reserve).
    await casAdjustStock(reservation.blank_sku, fulfillerId, -reservation.quantity);

    logger.info({ reservationId, blankSku: reservation.blank_sku }, 'Released reservation');
    await signalInventoryChanged([reservation.blank_sku]);
  },

  /**
   * Renew a TEMPORARY reservation (extend TTL).
   * Used at checkout entry to re-confirm the hold without releasing/re-reserving.
   */
  async renewReservation(reservationId: string, newTtlSeconds: number): Promise<boolean> {
    const rows = await executeCql<ReservationRow>(
      `SELECT * FROM inventory_reservations_w WHERE reservation_id = ?`,
      [reservationId],
    );

    if (rows.length === 0) {
      logger.warn({ reservationId }, 'Reservation not found for renewal');
      return false;
    }

    const reservation = rows[0];
    if (reservation.status !== 'TEMPORARY') {
      logger.warn(
        { reservationId, status: reservation.status },
        'Cannot renew non-TEMPORARY reservation',
      );
      return false;
    }

    const newExpiresAt = new Date(Date.now() + newTtlSeconds * 1000);
    await executeBatch([
      {
        query: `UPDATE inventory_reservations_w
                SET expires_at = ?, updated_at = toTimestamp(now())
                WHERE reservation_id = ?`,
        params: [newExpiresAt, reservationId],
      },
      {
        query: `UPDATE inventory_reservations_by_status_w
                SET expires_at = ?, updated_at = toTimestamp(now())
                WHERE status = ? AND reservation_id = ?`,
        params: [newExpiresAt, reservation.status, reservationId],
      },
      historyInsert({
        cartId: reservation.cart_id,
        operation: 'RENEW',
        reservationId,
        blankSku: reservation.blank_sku,
        variantId: reservation.variant_id,
        fulfillerId: reservation.fulfiller_id,
        quantity: reservation.quantity,
        priorStatus: reservation.status,
        newStatus: reservation.status,
        referenceId: reservation.reference_id,
        details: { newExpiresAt: newExpiresAt.toISOString(), ttlSeconds: newTtlSeconds },
      }),
    ]);

    logger.info({ reservationId, newTtlSeconds }, 'Renewed reservation');
    await signalInventoryChanged([reservation.blank_sku]);
    return true;
  },

  /**
   * Cancel a CONFIRMED reservation (order cancelled).
   * Decrements reserved_stock from the assigned fulfiller and sets status to CANCELLED.
   */
  async cancel(reservationId: string): Promise<void> {
    const rows = await executeCql<ReservationRow>(
      `SELECT * FROM inventory_reservations_w WHERE reservation_id = ?`,
      [reservationId],
    );

    if (rows.length === 0) {
      logger.warn({ reservationId }, 'Reservation not found for cancel');
      return;
    }

    const reservation = rows[0];
    if (reservation.status !== 'CONFIRMED') {
      logger.warn(
        { reservationId, status: reservation.status },
        'Can only cancel CONFIRMED reservations',
      );
      return;
    }

    const fulfillerId = reservation.fulfiller_id;
    if (!fulfillerId) {
      throw new Error(`Reservation ${reservationId} has no assigned fulfiller ID on cancel`);
    }

    // Status first, counter second — same fail-safe ordering rationale as release().
    await executeBatch([
      {
        query: `UPDATE inventory_reservations_w
                SET status = 'CANCELLED', updated_at = toTimestamp(now())
                WHERE reservation_id = ?`,
        params: [reservationId],
      },
      {
        query: `DELETE FROM inventory_reservations_by_cart_w
                WHERE cart_id = ? AND reservation_id = ?`,
        params: [reservation.cart_id, reservationId],
      },
      activeRegistryDelete(reservation.status, reservationId),
      historyInsert({
        cartId: reservation.cart_id,
        operation: 'CANCEL',
        reservationId,
        blankSku: reservation.blank_sku,
        variantId: reservation.variant_id,
        fulfillerId,
        quantity: reservation.quantity,
        priorStatus: reservation.status,
        newStatus: 'CANCELLED',
        referenceId: reservation.reference_id,
      }),
    ]);

    await casAdjustStock(reservation.blank_sku, fulfillerId, -reservation.quantity);

    logger.info(
      { reservationId, blankSku: reservation.blank_sku, fulfillerId },
      'Cancelled reservation',
    );
    await signalInventoryChanged([reservation.blank_sku]);
  },

  /**
   * Confirm a reservation (payment succeeded).
   * Removes TTL expiration so the reservation persists until fulfillment.
   */
  async confirm(reservationId: string): Promise<void> {
    const rows = await executeCql<ReservationRow>(
      `SELECT * FROM inventory_reservations_w WHERE reservation_id = ?`,
      [reservationId],
    );

    if (rows.length === 0) {
      logger.warn({ reservationId }, 'Reservation not found for confirm');
      return;
    }

    // Only TEMPORARY → CONFIRMED is legal. A retried confirm on an already-CONFIRMED
    // row is an idempotent no-op; confirming a terminal (RELEASED/CANCELLED/FULFILLED)
    // reservation must not resurrect it — that would flip the main row back to
    // CONFIRMED and insert a never-expiring ghost into the active registry.
    if (rows[0].status !== 'TEMPORARY') {
      logger.warn(
        { reservationId, status: rows[0].status },
        rows[0].status === 'CONFIRMED'
          ? 'Reservation already confirmed'
          : 'Cannot confirm non-TEMPORARY reservation',
      );
      return;
    }

    await executeBatch([
      {
        query: `UPDATE inventory_reservations_w
                SET status = 'CONFIRMED', expires_at = null, updated_at = toTimestamp(now())
                WHERE reservation_id = ?`,
        params: [reservationId],
      },
      {
        query: `UPDATE inventory_reservations_by_cart_w
                SET status = 'CONFIRMED'
                WHERE cart_id = ? AND reservation_id = ?`,
        params: [rows[0].cart_id, reservationId],
      },
      // Active registry: the row moves partitions (TEMPORARY -> CONFIRMED)
      activeRegistryDelete(rows[0].status, reservationId),
      activeRegistryInsert({
        status: 'CONFIRMED',
        reservation_id: reservationId,
        blank_sku: rows[0].blank_sku,
        cart_id: rows[0].cart_id,
        variant_id: rows[0].variant_id,
        fulfiller_id: rows[0].fulfiller_id,
        quantity: rows[0].quantity,
        reference_id: rows[0].reference_id,
        expires_at: null,
        created_at: rows[0].created_at,
        updated_at: new Date(),
      }),
      historyInsert({
        cartId: rows[0].cart_id,
        operation: 'CONFIRM',
        reservationId,
        blankSku: rows[0].blank_sku,
        variantId: rows[0].variant_id,
        fulfillerId: rows[0].fulfiller_id,
        quantity: rows[0].quantity,
        priorStatus: rows[0].status,
        newStatus: 'CONFIRMED',
        referenceId: rows[0].reference_id,
      }),
    ]);

    logger.info({ reservationId }, 'Confirmed reservation');
    await signalInventoryChanged([rows[0].blank_sku]);
  },

  /**
   * Fulfill a reservation (delivered). Decrements total_stock and reserved_stock.
   */
  async fulfill(reservationId: string): Promise<void> {
    const rows = await executeCql<ReservationRow>(
      `SELECT * FROM inventory_reservations_w WHERE reservation_id = ?`,
      [reservationId],
    );

    if (rows.length === 0) {
      logger.warn({ reservationId }, 'Reservation not found for fulfill');
      return;
    }

    const reservation = rows[0];
    if (
      reservation.status === 'FULFILLED' ||
      reservation.status === 'RELEASED' ||
      reservation.status === 'CANCELLED'
    ) {
      logger.warn({ reservationId, status: reservation.status }, 'Reservation already terminal');
      return;
    }
    const fulfillerId = reservation.fulfiller_id;

    if (!fulfillerId) {
      throw new Error(`Reservation ${reservationId} has no assigned fulfiller ID on fulfill`);
    }

    // Status first, counters second — same fail-safe ordering rationale as release().
    // Decrements BOTH total_stock and reserved_stock (delivery consumes the physical unit);
    // total is skipped automatically for UNLIMITED sentinel rows inside casAdjustStock.
    await executeBatch([
      {
        query: `UPDATE inventory_reservations_w
                SET status = 'FULFILLED', updated_at = toTimestamp(now())
                WHERE reservation_id = ?`,
        params: [reservationId],
      },
      {
        query: `DELETE FROM inventory_reservations_by_cart_w
                WHERE cart_id = ? AND reservation_id = ?`,
        params: [reservation.cart_id, reservationId],
      },
      activeRegistryDelete(reservation.status, reservationId),
      historyInsert({
        cartId: reservation.cart_id,
        operation: 'FULFILL',
        reservationId,
        blankSku: reservation.blank_sku,
        variantId: reservation.variant_id,
        fulfillerId,
        quantity: reservation.quantity,
        priorStatus: reservation.status,
        newStatus: 'FULFILLED',
        referenceId: reservation.reference_id,
      }),
    ]);

    await casAdjustStock(
      reservation.blank_sku,
      fulfillerId,
      -reservation.quantity,
      -reservation.quantity,
    );

    logger.info({ reservationId, fulfillerId }, 'Fulfilled reservation');
    await signalInventoryChanged([reservation.blank_sku]);
  },

  /**
   * Transfer a reservation to a specific fulfiller (for fulfillment routing).
   *
   * Reservations are attributed to a fulfiller at reserve time, so a transfer that changes
   * the fulfiller (or the quantity) must MOVE the reserved counter between stock rows —
   * otherwise the old row stays inflated and the new row never covers the hold. Rows are
   * updated before counters so the reconciler's expected view is already correct if a
   * counter adjustment fails mid-way.
   */
  async transferToFulfiller(
    reservationId: string,
    fulfillerId: string,
    quantity: number,
  ): Promise<void> {
    // Load first: the active registry must only be written for rows that exist there
    // (a blind UPDATE would upsert a ghost row into the status partition).
    const transferRows = await executeCql<ReservationRow>(
      `SELECT * FROM inventory_reservations_w WHERE reservation_id = ?`,
      [reservationId],
    );
    if (transferRows.length === 0) {
      logger.warn({ reservationId }, 'Reservation not found for transfer');
      return;
    }
    const current = transferRows[0];
    const priorFulfillerId = current.fulfiller_id;
    const priorQuantity = current.quantity;

    const statements = [
      {
        query: `UPDATE inventory_reservations_w
                SET fulfiller_id = ?, quantity = ?, updated_at = toTimestamp(now())
                WHERE reservation_id = ?`,
        params: [fulfillerId, quantity, reservationId] as unknown[],
      },
    ];
    if (current.status === 'TEMPORARY' || current.status === 'CONFIRMED') {
      statements.push({
        query: `UPDATE inventory_reservations_by_status_w
                SET fulfiller_id = ?, quantity = ?, updated_at = toTimestamp(now())
                WHERE status = ? AND reservation_id = ?`,
        params: [fulfillerId, quantity, current.status, reservationId],
      });
    }
    statements.push(
      historyInsert({
        cartId: current.cart_id,
        operation: 'TRANSFER',
        reservationId,
        blankSku: current.blank_sku,
        variantId: current.variant_id,
        fulfillerId,
        quantity,
        priorStatus: current.status,
        newStatus: current.status,
        referenceId: current.reference_id,
        details: {
          fromFulfillerId: priorFulfillerId,
          toFulfillerId: fulfillerId,
          fromQuantity: priorQuantity,
          toQuantity: quantity,
        },
      }),
    );
    await executeBatch(statements);

    // Move the reserved counter to match the new attribution (active holds only —
    // terminal reservations no longer occupy a counter).
    if (current.status === 'TEMPORARY' || current.status === 'CONFIRMED') {
      if (priorFulfillerId && priorFulfillerId !== fulfillerId) {
        await casAdjustStock(current.blank_sku, priorFulfillerId, -priorQuantity);
        await casAdjustStock(current.blank_sku, fulfillerId, quantity);
      } else if (priorFulfillerId && quantity !== priorQuantity) {
        await casAdjustStock(current.blank_sku, priorFulfillerId, quantity - priorQuantity);
      } else if (!priorFulfillerId) {
        // Legacy pre-attribution row: the counter lives on an unknown row; the reconciler
        // will settle it against the new attribution at the next sweep.
        logger.warn(
          { reservationId, fulfillerId },
          'Transfer of unattributed reservation — reconciler will settle counters',
        );
        await casAdjustStock(current.blank_sku, fulfillerId, quantity);
      }
    }

    logger.info({ reservationId, fulfillerId, quantity }, 'Transferred reservation to fulfiller');
    await signalInventoryChanged([current.blank_sku]);
  },

  // --- Batch Operations ---

  /**
   * Reserve all items for a cart, consolidated by blank_sku.
   * Multiple variants may share the same underlying blank — we accumulate their
   * quantities so there is exactly one LWT reserve (one CAS on inventory_stock_w)
   * per unique blank_sku. Safe to parallelize since each targets a different partition.
   * Rolls back on any failure.
   */
  async reserveAll(
    cartId: string,
    items: Array<{ variantId: string; blankSku: string; quantity: number }>,
    referenceId?: string,
  ): Promise<BatchReserveResult> {
    const ttlSeconds = 15 * 60; // 15 minutes for checkout

    // One reserveGroup per unique blank_sku (one CAS per partition), but every variant keeps
    // its own reservation row — see groupItemsByBlankSku.
    const groups = groupItemsByBlankSku(cartId, items);

    const skuResults = await Promise.all(
      Array.from(groups.entries()).map(async ([blankSku, entries]) => ({
        blankSku,
        entries,
        result: await this.reserveGroup(
          blankSku,
          cartId,
          entries,
          referenceId ?? `checkout-${cartId}`,
          ttlSeconds,
        ),
      })),
    );

    const failures = skuResults.filter((r) => !r.result.success);
    if (failures.length > 0) {
      // Roll back the groups that succeeded
      const successfulIds = skuResults
        .filter((r) => r.result.success)
        .flatMap((r) => r.entries.map((e) => e.reservationId));
      await Promise.all(successfulIds.map((id) => this.release(id)));

      return {
        success: false,
        error: failures[0].result.error,
        contention: failures.some((r) => r.result.contention),
      };
    }

    return {
      success: true,
      reservations: items.map((item) => ({
        variantId: item.variantId,
        reservationId: buildReservationId(cartId, item.variantId),
      })),
    };
  },

  /**
   * Release all reservations for a cart.
   */
  async releaseAllForCart(cartId: string): Promise<void> {
    const rows = await executeCql<CartReservationRow>(
      `SELECT reservation_id FROM inventory_reservations_by_cart_w WHERE cart_id = ?`,
      [cartId],
    );
    if (rows.length === 0) return;
    await Promise.all(rows.map((r) => this.release(r.reservation_id)));
  },

  /**
   * Confirm all reservations for a cart.
   */
  async confirmAllForCart(cartId: string): Promise<void> {
    const rows = await executeCql<CartReservationRow>(
      `SELECT reservation_id FROM inventory_reservations_by_cart_w WHERE cart_id = ?`,
      [cartId],
    );
    if (rows.length === 0) return;
    await Promise.all(rows.map((r) => this.confirm(r.reservation_id)));
  },

  /**
   * Reconcile reservations after cart change: release removed, reserve new, adjust changed.
   */
  async reconcile(
    cartId: string,
    oldItems: Array<{ variantId: string; blankSku: string; quantity: number }>,
    newItems: Array<{ variantId: string; blankSku: string; quantity: number }>,
  ): Promise<BatchReserveResult> {
    const oldMap = new Map(oldItems.map((i) => [i.variantId, i]));
    const newMap = new Map(newItems.map((i) => [i.variantId, i]));

    // Items removed from cart
    const removed = oldItems.filter((i) => !newMap.has(i.variantId));
    // Items added to cart
    const added = newItems.filter((i) => !oldMap.has(i.variantId));
    // Items with changed quantity (release + re-reserve for simplicity)
    const changed = newItems.filter((i) => {
      const old = oldMap.get(i.variantId);
      return old && old.quantity !== i.quantity;
    });

    // Release removed + changed
    const toRelease = [...removed, ...changed];
    await Promise.all(
      toRelease.map((item) => this.release(buildReservationId(cartId, item.variantId))),
    );

    // Reserve added + changed (with new quantities)
    const toReserve = [...added, ...changed];
    if (toReserve.length > 0) {
      return this.reserveAll(cartId, toReserve);
    }

    return { success: true, reservations: [] };
  },

  // --- Write-Side Reads ---

  /**
   * Get a single reservation by ID.
   */
  async getReservation(reservationId: string): Promise<ReservationRecord | null> {
    const rows = await executeCql<ReservationRow>(
      `SELECT * FROM inventory_reservations_w WHERE reservation_id = ?`,
      [reservationId],
    );
    return rows.length > 0 ? rowToReservation(rows[0]) : null;
  },

  /**
   * Read a cart's full inventory history — single-partition read, already clustered
   * chronologically by (at, seq). Powers the order-trace Inventory section.
   */
  async getHistoryByCart(cartId: string): Promise<InventoryHistoryRecord[]> {
    const rows = await executeCql<InventoryHistoryRow>(
      `SELECT * FROM inventory_history WHERE cart_id = ?`,
      [cartId],
    );
    return rows.map(rowToHistoryRecord);
  },

  /**
   * Get all reservations for a cart.
   */
  async getReservationsByCart(cartId: string): Promise<ReservationRecord[]> {
    const cartRows = await executeCql<CartReservationRow>(
      `SELECT reservation_id FROM inventory_reservations_by_cart_w WHERE cart_id = ?`,
      [cartId],
    );
    if (cartRows.length === 0) return [];

    const reservations = await Promise.all(
      cartRows.map((r) =>
        executeCql<ReservationRow>(
          `SELECT * FROM inventory_reservations_w WHERE reservation_id = ?`,
          [r.reservation_id],
        ),
      ),
    );

    return reservations.filter((rows) => rows.length > 0).map((rows) => rowToReservation(rows[0]));
  },

  /**
   * Get all expired TEMPORARY reservations (for service workflow expiration).
   */
  async getExpiredReservations(): Promise<ReservationRecord[]> {
    // Partition read over active TEMPORARY reservations; expiry filtered in app code.
    const rows = await readActiveStatusPartition('TEMPORARY');
    const now = Date.now();
    return rows
      .filter((r) => r.expires_at != null && r.expires_at.getTime() < now)
      .map(rowToReservation);
  },

  /**
   * Raw active-registry rows (TEMPORARY + CONFIRMED) — the canonical accessor for
   * the active working set. Projections/ES sync delegate here so the registry's
   * table name and partition layout live in exactly one module.
   */
  async getActiveReservationRows(): Promise<ReservationRow[]> {
    const [temporary, confirmed] = await Promise.all([
      readActiveStatusPartition('TEMPORARY'),
      readActiveStatusPartition('CONFIRMED'),
    ]);
    return [...temporary, ...confirmed];
  },

  /**
   * Get all stock rows from write tables (for projection to read tables).
   */
  async getAllStockRows(): Promise<StockRow[]> {
    return executeCql<StockRow>(`SELECT * FROM inventory_stock_w`);
  },

  /**
   * Get all active reservations from write tables (for projection to read tables).
   */
  async getActiveReservations(): Promise<ReservationRecord[]> {
    return (await this.getActiveReservationRows()).map(rowToReservation);
  },

  /**
   * Drift reconciler: recompute reserved_stock per (blank_sku, fulfiller_id) from the active
   * reservation rows and CAS-correct any counter that disagrees.
   *
   * This is the backstop for every non-atomic pair in the write path: an LWT increment whose
   * record batch failed (phantom hold), a status flip whose decrement failed, a transfer
   * whose counter move half-applied. Runs in the periodic consistency sweep. Every
   * correction is logged at warn — drift is always a bug signal, never routine.
   *
   * Returns the number of counters corrected.
   */
  async reconcileStockCounters(): Promise<number> {
    const [activeRows, stockRows] = await Promise.all([
      this.getActiveReservationRows(),
      this.getAllStockRows(),
    ]);

    const unattributed = activeRows.filter((r) => !r.fulfiller_id);
    if (unattributed.length > 0) {
      logger.error(
        { reservationIds: unattributed.map((r) => r.reservation_id) },
        'Active reservations without fulfiller attribution — cannot reconcile these',
      );
    }

    const expected = computeExpectedReserved(activeRows);
    let corrections = 0;

    for (const stock of stockRows) {
      const key = `${stock.blank_sku}|${stock.fulfiller_id}`;
      const expectedReserved = expected.get(key) ?? 0;
      if (stock.reserved_stock === expectedReserved) continue;

      logger.warn(
        {
          blankSku: stock.blank_sku,
          fulfillerId: stock.fulfiller_id,
          actual: stock.reserved_stock,
          expected: expectedReserved,
        },
        'Stock counter drift detected — correcting',
      );
      // Single direct CAS to the expected value, conditioned on the value we computed the
      // expectation against. Not-applied means the counter moved (live traffic) — in that
      // case the expectation itself is stale, so skip and let the next sweep re-evaluate
      // rather than retrying against a moving target.
      const client = await getCassandraClient();
      const result = await client.execute(
        `UPDATE inventory_stock_w
         SET reserved_stock = ?, updated_at = toTimestamp(now())
         WHERE blank_sku = ? AND fulfiller_id = ?
         IF reserved_stock = ?`,
        [expectedReserved, stock.blank_sku, stock.fulfiller_id, stock.reserved_stock],
        { prepare: true },
      );
      if (result.rows[0]['[applied]']) {
        corrections++;
        // Journal under the platform partition — a correction has no owning cart.
        await recordHistoryBestEffort({
          cartId: PLATFORM_CART_ID,
          operation: 'DRIFT_CORRECTION',
          blankSku: stock.blank_sku,
          fulfillerId: stock.fulfiller_id,
          actor: 'reconciler',
          details: { actual: stock.reserved_stock, expected: expectedReserved },
        });
      } else {
        logger.warn(
          { blankSku: stock.blank_sku, fulfillerId: stock.fulfiller_id },
          'Drift correction skipped (counter moved under us) — next sweep re-evaluates',
        );
      }
    }

    return corrections;
  },
};
