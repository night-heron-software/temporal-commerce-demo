/**
 * Inventory Service Activities
 *
 * Activities for the inventoryServiceWorkflow:
 * - Expire TEMPORARY reservations past TTL
 * - Project write tables → Cassandra read tables
 * - Sync inventory to Elasticsearch
 */

import { InventoryCommandRepository } from './db/inventory-command-repository';
import { executeCql, executeBatch } from '../../lib';
import { getElasticsearchClient } from '../../lib';
import { Elasticsearch } from '../contracts';
const { ES_INDICES } = Elasticsearch;
type InventoryDocument = Elasticsearch.InventoryDocument;
type InventoryFulfillerLocationDocument = Elasticsearch.InventoryFulfillerLocationDocument;
type InventoryReservationDocument = Elasticsearch.InventoryReservationDocument;
import { logger } from '../../lib';

// ============================================================
// Expire Reservations
// ============================================================

/**
 * Find and release all TEMPORARY reservations past their expiry time.
 */
export async function expireReservations(): Promise<number> {
  const expired = await InventoryCommandRepository.getExpiredReservations();
  if (expired.length === 0) return 0;

  await Promise.all(
    expired.map((r) => InventoryCommandRepository.release(r.reservationId, 'expiry-sweep')),
  );

  logger.info({ count: expired.length }, 'Expired reservations released');
  return expired.length;
}

// ============================================================
// Drift Reconciliation
// ============================================================

/**
 * Recompute reserved_stock from active reservations and CAS-correct drifted counters.
 * The backstop for every non-atomic pair in the write path — see
 * InventoryCommandRepository.reconcileStockCounters. Returns the number corrected.
 */
export async function reconcileStockCounters(): Promise<number> {
  return InventoryCommandRepository.reconcileStockCounters();
}

// ============================================================
// CQRS Projections: Write Tables → Read Tables
// ============================================================

interface StockWriteRow {
  blank_sku: string;
  fulfiller_id: string;
  fulfiller_name: string;
  total_stock: number;
  reserved_stock: number;
  ordered_stock: number;
  cost: number;
  address1: string;
  address2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

interface ReservationWriteRow {
  reservation_id: string;
  blank_sku: string;
  cart_id: string;
  variant_id: string;
  fulfiller_id: string | null;
  quantity: number;
  status: string;
  expires_at: Date | null;
  created_at: Date;
}

const LOW_STOCK_THRESHOLD = 10;

/**
 * Active (TEMPORARY + CONFIRMED) reservations, optionally narrowed to a set of SKUs
 * in application code. Delegates to the repository's canonical registry accessor so
 * the registry's table name and partition layout live in exactly one module.
 */
async function fetchActiveReservations(blankSkus?: string[]): Promise<ReservationWriteRow[]> {
  const all: ReservationWriteRow[] = await InventoryCommandRepository.getActiveReservationRows();
  if (!blankSkus) return all;
  const wanted = new Set(blankSkus);
  return all.filter((r) => wanted.has(r.blank_sku));
}

/**
 * Read all stock from write tables, aggregate per SKU, and upsert into read tables.
 */
export async function projectStockSummaries(): Promise<void> {
  const stockRows = await executeCql<StockWriteRow>(`SELECT * FROM inventory_stock_w`);

  if (stockRows.length === 0) return;

  // Group by blank_sku
  const bySkuMap = new Map<string, StockWriteRow[]>();
  for (const row of stockRows) {
    const existing = bySkuMap.get(row.blank_sku) ?? [];
    existing.push(row);
    bySkuMap.set(row.blank_sku, existing);
  }

  const now = new Date();
  const summaryBatch: Array<{ query: string; params: unknown[] }> = [];
  const fulfillerBatch: Array<{ query: string; params: unknown[] }> = [];

  for (const [blankSku, fulfillers] of bySkuMap) {
    const totalStock = fulfillers.reduce((s, r) => s + r.total_stock, 0);
    const reservedStock = fulfillers.reduce((s, r) => s + r.reserved_stock, 0);
    const availableStock = totalStock - reservedStock;
    const lowStock = availableStock < LOW_STOCK_THRESHOLD;

    // Upsert into inventory_stock_summary
    summaryBatch.push({
      query: `INSERT INTO inventory_stock_summary (
        blank_sku, total_stock, reserved_stock, available_stock,
        fulfiller_count, low_stock, last_projected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        blankSku,
        totalStock,
        reservedStock,
        availableStock,
        fulfillers.length,
        lowStock,
        now,
      ],
    });

    // Upsert each fulfiller into inventory_stock_by_fulfiller
    for (const sup of fulfillers) {
      const supAvailable = sup.total_stock - sup.reserved_stock;
      fulfillerBatch.push({
        query: `INSERT INTO inventory_stock_by_fulfiller (
          fulfiller_id, blank_sku, fulfiller_name, total_stock,
          reserved_stock, available_stock, cost, city, state,
          country, last_projected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          sup.fulfiller_id,
          blankSku,
          sup.fulfiller_name,
          sup.total_stock,
          sup.reserved_stock,
          supAvailable,
          sup.cost,
          sup.city,
          sup.state,
          sup.country,
          now,
        ],
      });
    }
  }

  // Execute in batches (Cassandra batches should stay small)
  const BATCH_SIZE = 20;
  for (let i = 0; i < summaryBatch.length; i += BATCH_SIZE) {
    await executeBatch(summaryBatch.slice(i, i + BATCH_SIZE));
  }
  for (let i = 0; i < fulfillerBatch.length; i += BATCH_SIZE) {
    await executeBatch(fulfillerBatch.slice(i, i + BATCH_SIZE));
  }

  logger.info(
    { skuCount: bySkuMap.size, fulfillerRows: fulfillerBatch.length },
    'Projected stock summaries',
  );
}

/**
 * Read active reservations from write tables and project to inventory_reservations_by_sku.
 */
export async function projectReservationViews(): Promise<void> {
  const activeReservations = await fetchActiveReservations();

  if (activeReservations.length === 0) return;

  // We truncate + re-insert rather than diff, since volume is bounded
  // and this avoids orphaned rows from released reservations
  // Note: TRUNCATE is safe here because the read table is only written by this projection
  await executeCql(`TRUNCATE inventory_reservations_by_sku`);

  const batch: Array<{ query: string; params: unknown[] }> = [];
  for (const r of activeReservations) {
    batch.push({
      query: `INSERT INTO inventory_reservations_by_sku (
        blank_sku, reservation_id, cart_id, variant_id, quantity,
        status, fulfiller_id, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        r.blank_sku,
        r.reservation_id,
        r.cart_id,
        r.variant_id,
        r.quantity,
        r.status,
        r.fulfiller_id,
        r.expires_at,
        r.created_at,
      ],
    });
  }

  const BATCH_SIZE = 20;
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    await executeBatch(batch.slice(i, i + BATCH_SIZE));
  }

  logger.info({ reservationCount: activeReservations.length }, 'Projected reservation views');
}

/**
 * Identify low-stock SKUs and populate the inventory_low_stock table.
 */
export async function projectLowStockAlerts(): Promise<void> {
  // Read from the just-projected summary table
  interface SummaryRow {
    blank_sku: string;
    available_stock: number;
    total_stock: number;
  }

  const summaries = await executeCql<SummaryRow>(
    `SELECT blank_sku, available_stock, total_stock FROM inventory_stock_summary`,
  );

  // Truncate and repopulate
  await executeCql(`TRUNCATE inventory_low_stock`);

  const lowStockSkus = summaries.filter((s) => s.available_stock < LOW_STOCK_THRESHOLD);
  if (lowStockSkus.length === 0) return;

  const now = new Date();
  const batch: Array<{ query: string; params: unknown[] }> = [];
  for (const sku of lowStockSkus) {
    batch.push({
      query: `INSERT INTO inventory_low_stock (
        threshold_bucket, blank_sku, available_stock, total_stock, last_projected_at
      ) VALUES ('default', ?, ?, ?, ?)`,
      params: [sku.blank_sku, sku.available_stock, sku.total_stock, now],
    });
  }

  const BATCH_SIZE = 20;
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    await executeBatch(batch.slice(i, i + BATCH_SIZE));
  }

  logger.info(
    { lowStockCount: lowStockSkus.length, threshold: LOW_STOCK_THRESHOLD },
    'Projected low stock alerts',
  );
}

// ============================================================
// Elasticsearch Sync
// ============================================================

/** Build one SKU's ES inventory document from its fulfiller stock rows + active reservations. */
function buildInventoryDoc(
  blankSku: string,
  fulfillers: StockWriteRow[],
  reservations: ReservationWriteRow[],
): InventoryDocument {
  const totalStock = fulfillers.reduce((s, r) => s + r.total_stock, 0);
  const reservedStock = fulfillers.reduce((s, r) => s + r.reserved_stock, 0);

  const toReservationDoc = (r: ReservationWriteRow): InventoryReservationDocument => ({
    reservationId: r.reservation_id,
    cartId: r.cart_id,
    quantity: r.quantity,
    status: r.status,
    createdAt: r.created_at.getTime(),
    expiresAt: r.expires_at ? r.expires_at.getTime() : null,
  });

  const fulfillerLocations: InventoryFulfillerLocationDocument[] = fulfillers.map((sup) => ({
    fulfillerId: sup.fulfiller_id,
    fulfillerName: sup.fulfiller_name,
    totalStock: sup.total_stock,
    reservedStock: sup.reserved_stock,
    orderedStock: sup.ordered_stock,
    city: sup.city,
    state: sup.state,
    country: sup.country,
    reservations: reservations
      .filter((r) => r.fulfiller_id === sup.fulfiller_id)
      .map(toReservationDoc),
  }));

  return {
    variantId: blankSku,
    totalStock,
    reservedStock,
    availableStock: totalStock - reservedStock,
    fulfillerCount: fulfillers.length,
    fulfillerLocations,
    reservations: reservations.filter((r) => !r.fulfiller_id).map(toReservationDoc),
    reservationIds: reservations.map((r) => r.reservation_id),
    cartIds: [...new Set(reservations.map((r) => r.cart_id))],
  };
}

/**
 * Sync all inventory stock to Elasticsearch (bulk index).
 * Reads from write tables and builds ES documents.
 */
export async function syncInventoryToES(): Promise<void> {
  const stockRows = await executeCql<StockWriteRow>(`SELECT * FROM inventory_stock_w`);
  const reservationRows = await fetchActiveReservations();

  if (stockRows.length === 0) return;

  // Group stock by blank_sku
  const stockBySku = new Map<string, StockWriteRow[]>();
  for (const row of stockRows) {
    const existing = stockBySku.get(row.blank_sku) ?? [];
    existing.push(row);
    stockBySku.set(row.blank_sku, existing);
  }

  // Group reservations by blank_sku
  const resBySkuMap = new Map<string, ReservationWriteRow[]>();
  for (const row of reservationRows) {
    const existing = resBySkuMap.get(row.blank_sku) ?? [];
    existing.push(row);
    resBySkuMap.set(row.blank_sku, existing);
  }

  const client = getElasticsearchClient();
  const operations: unknown[] = [];

  for (const [blankSku, fulfillers] of stockBySku) {
    const reservations = resBySkuMap.get(blankSku) ?? [];
    operations.push({ index: { _index: ES_INDICES.inventory, _id: blankSku } });
    operations.push(buildInventoryDoc(blankSku, fulfillers, reservations));
  }

  if (operations.length > 0) {
    await client.bulk({ operations, refresh: false });
    logger.info({ documentCount: stockBySku.size }, 'Synced inventory to Elasticsearch');
  }
}

// ============================================================
// Targeted Projections (Signal-Driven)
// ============================================================

/**
 * Project stock summaries for specific SKUs only.
 * Reads write tables for the given SKUs and upserts into read tables.
 */
export async function projectStockForSkus(blankSkus: string[]): Promise<void> {
  if (blankSkus.length === 0) return;

  const now = new Date();
  const summaryBatch: Array<{ query: string; params: unknown[] }> = [];
  const fulfillerBatch: Array<{ query: string; params: unknown[] }> = [];
  const lowStockBatch: Array<{ query: string; params: unknown[] }> = [];

  // One partition read of the low-stock alert rows (bounded: low-stock SKUs only),
  // grouped in app code so per-SKU cleanup below needs no per-row filtering query.
  const lowStockRows = await executeCql<{ available_stock: number; blank_sku: string }>(
    `SELECT available_stock, blank_sku FROM inventory_low_stock
     WHERE threshold_bucket = 'default'`,
  );
  const lowStockBySku = new Map<string, number[]>();
  for (const row of lowStockRows) {
    const list = lowStockBySku.get(row.blank_sku) ?? [];
    list.push(row.available_stock);
    lowStockBySku.set(row.blank_sku, list);
  }

  for (const blankSku of blankSkus) {
    const fulfillers = await executeCql<StockWriteRow>(
      `SELECT * FROM inventory_stock_w WHERE blank_sku = ?`,
      [blankSku],
    );

    if (fulfillers.length === 0) {
      // SKU deleted — remove from read tables
      summaryBatch.push({
        query: `DELETE FROM inventory_stock_summary WHERE blank_sku = ?`,
        params: [blankSku],
      });
      continue;
    }

    const totalStock = fulfillers.reduce((s, r) => s + r.total_stock, 0);
    const reservedStock = fulfillers.reduce((s, r) => s + r.reserved_stock, 0);
    const availableStock = totalStock - reservedStock;
    const lowStock = availableStock < LOW_STOCK_THRESHOLD;

    summaryBatch.push({
      query: `INSERT INTO inventory_stock_summary (
        blank_sku, total_stock, reserved_stock, available_stock,
        fulfiller_count, low_stock, last_projected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        blankSku,
        totalStock,
        reservedStock,
        availableStock,
        fulfillers.length,
        lowStock,
        now,
      ],
    });

    for (const sup of fulfillers) {
      const supAvailable = sup.total_stock - sup.reserved_stock;
      fulfillerBatch.push({
        query: `INSERT INTO inventory_stock_by_fulfiller (
          fulfiller_id, blank_sku, fulfiller_name, total_stock,
          reserved_stock, available_stock, cost, city, state,
          country, last_projected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          sup.fulfiller_id,
          blankSku,
          sup.fulfiller_name,
          sup.total_stock,
          sup.reserved_stock,
          supAvailable,
          sup.cost,
          sup.city,
          sup.state,
          sup.country,
          now,
        ],
      });
    }

    // Low stock alert
    if (lowStock) {
      lowStockBatch.push({
        query: `INSERT INTO inventory_low_stock (
          threshold_bucket, blank_sku, available_stock, total_stock, last_projected_at
        ) VALUES ('default', ?, ?, ?, ?)`,
        params: [blankSku, availableStock, totalStock, now],
      });
    } else {
      // Must delete all possible available_stock values for this SKU. The clustering
      // column can't be skipped in a DELETE, so use the partition read taken above.
      for (const availableValue of lowStockBySku.get(blankSku) ?? []) {
        lowStockBatch.push({
          query: `DELETE FROM inventory_low_stock
                  WHERE threshold_bucket = 'default' AND available_stock = ? AND blank_sku = ?`,
          params: [availableValue, blankSku],
        });
      }
    }
  }

  const BATCH_SIZE = 20;
  for (const batch of [summaryBatch, fulfillerBatch, lowStockBatch]) {
    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
      await executeBatch(batch.slice(i, i + BATCH_SIZE));
    }
  }

  logger.info({ skuCount: blankSkus.length }, 'Projected stock for targeted SKUs');
}

/**
 * Project reservations for specific SKUs only.
 * Deletes existing rows for the SKUs and re-inserts active ones.
 */
export async function projectReservationsForSkus(blankSkus: string[]): Promise<void> {
  if (blankSkus.length === 0) return;

  const batch: Array<{ query: string; params: unknown[] }> = [];

  // One registry read for all target SKUs, grouped in app code
  const activeForSkus = await fetchActiveReservations(blankSkus);

  for (const blankSku of blankSkus) {
    // Delete existing rows for this SKU (partition key delete)
    batch.push({
      query: `DELETE FROM inventory_reservations_by_sku WHERE blank_sku = ?`,
      params: [blankSku],
    });

    // Re-insert active reservations
    const activeReservations = activeForSkus.filter((r) => r.blank_sku === blankSku);

    for (const r of activeReservations) {
      batch.push({
        query: `INSERT INTO inventory_reservations_by_sku (
          blank_sku, reservation_id, cart_id, variant_id, quantity,
          status, fulfiller_id, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          r.blank_sku,
          r.reservation_id,
          r.cart_id,
          r.variant_id,
          r.quantity,
          r.status,
          r.fulfiller_id,
          r.expires_at,
          r.created_at,
        ],
      });
    }
  }

  const BATCH_SIZE = 20;
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    await executeBatch(batch.slice(i, i + BATCH_SIZE));
  }

  logger.info({ skuCount: blankSkus.length }, 'Projected reservations for targeted SKUs');
}

/**
 * Sync specific SKUs to Elasticsearch.
 */
export async function syncInventoryToESForSkus(blankSkus: string[]): Promise<void> {
  if (blankSkus.length === 0) return;

  const client = getElasticsearchClient();
  const operations: unknown[] = [];

  // One registry read for all target SKUs, grouped in app code
  const activeForSkus = await fetchActiveReservations(blankSkus);

  for (const blankSku of blankSkus) {
    const fulfillers = await executeCql<StockWriteRow>(
      `SELECT * FROM inventory_stock_w WHERE blank_sku = ?`,
      [blankSku],
    );

    if (fulfillers.length === 0) {
      // SKU deleted — remove from ES
      operations.push({ delete: { _index: ES_INDICES.inventory, _id: blankSku } });
      continue;
    }

    const reservations = activeForSkus.filter((r) => r.blank_sku === blankSku);

    operations.push({ index: { _index: ES_INDICES.inventory, _id: blankSku } });
    operations.push(buildInventoryDoc(blankSku, fulfillers, reservations));
  }

  if (operations.length > 0) {
    await client.bulk({ operations, refresh: false });
    logger.info({ skuCount: blankSkus.length }, 'Synced targeted SKUs to Elasticsearch');
  }
}
