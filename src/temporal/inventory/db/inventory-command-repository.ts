import { Inventory } from '../../contracts';
/**
 * Inventory Command Repository (CQRS Write Side)
 *
 * Handles all inventory mutations using Cassandra write tables with
 * Lightweight Transactions (LWT) for atomicity on critical operations.
 */

import { executeCql, executeBatch, getCassandraClient } from '../../../lib';
import { types } from 'cassandra-driver';
import { logger } from '../../../lib';
import { signalInventoryChanged } from '../inventory-signal';

// ============================================================
// Types
// ============================================================

export const UNLIMITED_STOCK = -1;

function isUnlimited(totalStock: number): boolean {
  return totalStock === UNLIMITED_STOCK;
}

export interface StockLevel {
  total: number;
  reserved: number;
  available: number;
}

export interface SetSupplierStockArgs {
  supplierId: string;
  supplierName: string;
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

export interface SetSupplierStockResult {
  supplierId: string;
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
}

export interface BatchReserveResult {
  success: boolean;
  reservations?: Array<{ variantId: string; reservationId: string }>;
  error?: string;
}

export interface ReservationRecord {
  reservationId: string;
  blankSku: string;
  cartId: string;
  variantId: string;
  supplierId: string | null;
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
  supplier_id: string;
  supplier_name: string;
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
  supplier_id: string | null;
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

function rowToReservation(row: ReservationRow): ReservationRecord {
  return {
    reservationId: row.reservation_id,
    blankSku: row.blank_sku,
    cartId: row.cart_id,
    variantId: row.variant_id,
    supplierId: row.supplier_id,
    quantity: row.quantity,
    referenceId: row.reference_id,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================
// Repository
// ============================================================

export const InventoryCommandRepository = {

  // --- Stock Operations ---

  /**
   * Set (upsert) supplier stock for a SKU.
   */
  async setSupplierStock(
    blankSku: string,
    args: SetSupplierStockArgs
  ): Promise<SetSupplierStockResult> {
    // Read current stock for the return value
    const existing = await executeCql<StockRow>(
      `SELECT total_stock, reserved_stock FROM inventory_stock_w
       WHERE blank_sku = ? AND supplier_id = ?`,
      [blankSku, args.supplierId]
    );
    const previousStock = existing.length > 0 ? existing[0].total_stock : 0;

    await executeCql(
      `INSERT INTO inventory_stock_w (
        blank_sku, supplier_id, supplier_name, total_stock, reserved_stock,
        ordered_stock, cost, address1, address2, city, state, postal_code,
        country, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, toTimestamp(now()))`,
      [
        blankSku,
        args.supplierId,
        args.supplierName,
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
      ]
    );

    const reservedStock = existing.length > 0 ? existing[0].reserved_stock : 0;
    const result = {
      supplierId: args.supplierId,
      previousStock,
      newStock: args.totalStock,
      available: args.totalStock - reservedStock,
    };

    await signalInventoryChanged([blankSku]);
    return result;
  },

  /**
   * Get stock level for a SKU across all suppliers (from write tables).
   * Used internally by mutations that need current state.
   */
  async getStockLevel(blankSku: string): Promise<Inventory.StockLevel> {
    const rows = await executeCql<StockRow>(
      `SELECT total_stock, reserved_stock FROM inventory_stock_w WHERE blank_sku = ?`,
      [blankSku]
    );
    const hasUnlimited = rows.some(r => isUnlimited(r.total_stock));
    const reserved = rows.reduce((sum, r) => sum + r.reserved_stock, 0);
    if (hasUnlimited) {
      return { total: UNLIMITED_STOCK, reserved, available: Number.MAX_SAFE_INTEGER };
    }
    const total = rows.reduce((sum, r) => sum + r.total_stock, 0);
    return { total, reserved, available: total - reserved };
  },

  // --- Reservation Lifecycle ---

  /**
   * Reserve inventory for a single item using LWT for atomicity.
   * Atomically increments reserved_stock IFF available stock is sufficient.
   *
   * PREEMPTION: If available stock is insufficient, checks for TEMPORARY
   * reservations older than MIN_HOLD_TIME on this SKU. Preempts them FIFO
   * (oldest first) until enough stock is freed, then reserves.
   */
  async reserve(args: ReserveArgs): Promise<ReserveResult> {
    const MIN_HOLD_MS = 15 * 60 * 1000; // 15 minutes

    // Find the supplier with the most available stock for this SKU
    const stockRows = await executeCql<StockRow>(
      `SELECT supplier_id, total_stock, reserved_stock FROM inventory_stock_w
       WHERE blank_sku = ?`,
      [args.blankSku]
    );

    if (stockRows.length === 0) {
      return { success: false, error: `No stock found for SKU: ${args.blankSku}` };
    }

    const hasUnlimited = stockRows.some(r => isUnlimited(r.total_stock));

    // Calculate total available across all suppliers
    let totalAvailable = hasUnlimited
      ? Number.MAX_SAFE_INTEGER
      : stockRows.reduce(
          (sum, r) => sum + (r.total_stock - r.reserved_stock), 0
        );

    // If not enough available, attempt preemption of stale TEMPORARY reservations
    if (totalAvailable < args.quantity) {
      const now = Date.now();
      const preemptable = await executeCql<ReservationRow>(
        `SELECT * FROM inventory_reservations_w
         WHERE blank_sku = ? AND status = 'TEMPORARY' ALLOW FILTERING`,
        [args.blankSku]
      );

      // Filter to reservations past MIN_HOLD_TIME, sorted oldest first (FIFO)
      const stale = preemptable
        .filter(r => r.expires_at && (now > r.created_at.getTime() + MIN_HOLD_MS))
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

      let freedStock = 0;
      const toPreempt: ReservationRow[] = [];

      for (const r of stale) {
        if (totalAvailable + freedStock >= args.quantity) break;
        // Don't preempt the same cart's reservation
        if (r.cart_id === args.cartId) continue;
        freedStock += r.quantity;
        toPreempt.push(r);
      }

      if (totalAvailable + freedStock >= args.quantity) {
        // Preempt the stale reservations
        for (const r of toPreempt) {
          logger.info(
            { preemptedReservation: r.reservation_id, blankSku: args.blankSku, forCart: args.cartId },
            'Preempting stale TEMPORARY reservation'
          );
          await this.release(r.reservation_id);
        }

        // Re-read stock after preemption
        const freshRows = await executeCql<StockRow>(
          `SELECT supplier_id, total_stock, reserved_stock FROM inventory_stock_w
           WHERE blank_sku = ?`,
          [args.blankSku]
        );
        stockRows.length = 0;
        stockRows.push(...freshRows);
        totalAvailable = freshRows.reduce(
          (sum, r) => sum + (r.total_stock - r.reserved_stock), 0
        );
      }
    }

    // Find a supplier with enough available stock
    const supplier = stockRows.find(
      r => isUnlimited(r.total_stock) || (r.total_stock - r.reserved_stock) >= args.quantity
    );

    if (!supplier) {
      return {
        success: false,
        error: `Insufficient stock. Requested: ${args.quantity}, Available: ${totalAvailable}`,
      };
    }

    // LWT: atomically increment reserved_stock only if stock is sufficient
    const client = await getCassandraClient();
    const newReserved = supplier.reserved_stock + args.quantity;
    const result = await client.execute(
      `UPDATE inventory_stock_w
       SET reserved_stock = ?, updated_at = toTimestamp(now())
       WHERE blank_sku = ? AND supplier_id = ?
       IF reserved_stock = ?`,
      [newReserved, args.blankSku, supplier.supplier_id, supplier.reserved_stock],
      { prepare: true }
    );

    // Check if LWT was applied
    const applied = result.rows[0]['[applied]'];
    if (!applied) {
      logger.warn(
        { blankSku: args.blankSku, supplierId: supplier.supplier_id },
        'LWT not applied for reserve, concurrent modification detected'
      );
      return { success: false, error: 'Concurrent modification, retry needed' };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + args.ttlSeconds * 1000);

    // Insert reservation record + by-cart lookup (batch for cross-partition atomicity)
    await executeBatch([
      {
        query: `INSERT INTO inventory_reservations_w (
          reservation_id, blank_sku, cart_id, variant_id, supplier_id,
          quantity, reference_id, status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'TEMPORARY', ?, ?, ?)`,
        params: [
          args.reservationId, args.blankSku, args.cartId, args.variantId,
          null, args.quantity, args.referenceId, expiresAt, now, now,
        ],
      },
      {
        query: `INSERT INTO inventory_reservations_by_cart_w (
          cart_id, reservation_id, blank_sku, variant_id, quantity, status
        ) VALUES (?, ?, ?, ?, ?, 'TEMPORARY')`,
        params: [
          args.cartId, args.reservationId, args.blankSku,
          args.variantId, args.quantity,
        ],
      },
    ]);

    logger.info(
      { reservationId: args.reservationId, blankSku: args.blankSku, quantity: args.quantity },
      'Reserved inventory'
    );

    await signalInventoryChanged([args.blankSku]);
    return { success: true, reservationId: args.reservationId };
  },

  /**
   * Release a reservation (checkout cancel, timeout, or failure).
   * Decrements reserved_stock and removes reservation records.
   */
  async release(reservationId: string): Promise<void> {
    const rows = await executeCql<ReservationRow>(
      `SELECT * FROM inventory_reservations_w WHERE reservation_id = ?`,
      [reservationId]
    );

    if (rows.length === 0) {
      logger.warn({ reservationId }, 'Reservation not found for release');
      return;
    }

    const reservation = rows[0];

    if (reservation.status === 'RELEASED' || reservation.status === 'FULFILLED') {
      logger.warn({ reservationId, status: reservation.status }, 'Reservation already terminal');
      return;
    }

    // Decrement reserved_stock via LWT
    const stockRows = await executeCql<StockRow>(
      `SELECT supplier_id, reserved_stock FROM inventory_stock_w WHERE blank_sku = ?`,
      [reservation.blank_sku]
    );

    // Find which supplier holds this reservation's stock
    // For now, decrement from the first supplier (pre-assignment reservations)
    if (stockRows.length > 0) {
      const supplier = stockRows[0];
      const newReserved = Math.max(0, supplier.reserved_stock - reservation.quantity);
      await executeCql(
        `UPDATE inventory_stock_w
         SET reserved_stock = ?, updated_at = toTimestamp(now())
         WHERE blank_sku = ? AND supplier_id = ?`,
        [newReserved, reservation.blank_sku, supplier.supplier_id]
      );
    }

    // Update reservation status and remove from cart lookup
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
    ]);

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
      [reservationId]
    );

    if (rows.length === 0) {
      logger.warn({ reservationId }, 'Reservation not found for renewal');
      return false;
    }

    const reservation = rows[0];
    if (reservation.status !== 'TEMPORARY') {
      logger.warn({ reservationId, status: reservation.status }, 'Cannot renew non-TEMPORARY reservation');
      return false;
    }

    const newExpiresAt = new Date(Date.now() + newTtlSeconds * 1000);
    await executeCql(
      `UPDATE inventory_reservations_w
       SET expires_at = ?, updated_at = toTimestamp(now())
       WHERE reservation_id = ?`,
      [newExpiresAt, reservationId]
    );

    logger.info({ reservationId, newTtlSeconds }, 'Renewed reservation');
    await signalInventoryChanged([reservation.blank_sku]);
    return true;
  },

  /**
   * Cancel a CONFIRMED reservation (order cancelled).
   * Decrements reserved_stock from the assigned supplier and sets status to CANCELLED.
   */
  async cancel(reservationId: string): Promise<void> {
    const rows = await executeCql<ReservationRow>(
      `SELECT * FROM inventory_reservations_w WHERE reservation_id = ?`,
      [reservationId]
    );

    if (rows.length === 0) {
      logger.warn({ reservationId }, 'Reservation not found for cancel');
      return;
    }

    const reservation = rows[0];
    if (reservation.status !== 'CONFIRMED') {
      logger.warn({ reservationId, status: reservation.status }, 'Can only cancel CONFIRMED reservations');
      return;
    }

    // Decrement reserved_stock from the assigned supplier
    const supplierId = reservation.supplier_id;
    if (supplierId) {
      const stockRows = await executeCql<StockRow>(
        `SELECT reserved_stock FROM inventory_stock_w
         WHERE blank_sku = ? AND supplier_id = ?`,
        [reservation.blank_sku, supplierId]
      );

      if (stockRows.length > 0) {
        const newReserved = Math.max(0, stockRows[0].reserved_stock - reservation.quantity);
        await executeCql(
          `UPDATE inventory_stock_w
           SET reserved_stock = ?, updated_at = toTimestamp(now())
           WHERE blank_sku = ? AND supplier_id = ?`,
          [newReserved, reservation.blank_sku, supplierId]
        );
      }
    }

    // Update reservation status and remove from cart lookup
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
    ]);

    logger.info({ reservationId, blankSku: reservation.blank_sku, supplierId }, 'Cancelled reservation');
    await signalInventoryChanged([reservation.blank_sku]);
  },

  /**
   * Confirm a reservation (payment succeeded).
   * Removes TTL expiration so the reservation persists until fulfillment.
   */
  async confirm(reservationId: string): Promise<void> {
    const rows = await executeCql<ReservationRow>(
      `SELECT * FROM inventory_reservations_w WHERE reservation_id = ?`,
      [reservationId]
    );

    if (rows.length === 0) {
      logger.warn({ reservationId }, 'Reservation not found for confirm');
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
      [reservationId]
    );

    if (rows.length === 0) {
      logger.warn({ reservationId }, 'Reservation not found for fulfill');
      return;
    }

    const reservation = rows[0];
    const supplierId = reservation.supplier_id;

    if (supplierId) {
      // Decrement both total_stock and reserved_stock from the assigned supplier
      const stockRows = await executeCql<StockRow>(
        `SELECT total_stock, reserved_stock FROM inventory_stock_w
         WHERE blank_sku = ? AND supplier_id = ?`,
        [reservation.blank_sku, supplierId]
      );

      if (stockRows.length > 0) {
        const stock = stockRows[0];
        const newTotal = isUnlimited(stock.total_stock)
          ? UNLIMITED_STOCK
          : stock.total_stock - reservation.quantity;
        await executeCql(
          `UPDATE inventory_stock_w
           SET total_stock = ?, reserved_stock = ?, updated_at = toTimestamp(now())
           WHERE blank_sku = ? AND supplier_id = ?`,
          [
            newTotal,
            stock.reserved_stock - reservation.quantity,
            reservation.blank_sku,
            supplierId,
          ]
        );
      }
    }

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
    ]);

    logger.info({ reservationId, supplierId }, 'Fulfilled reservation');
    await signalInventoryChanged([reservation.blank_sku]);
  },

  /**
   * Transfer a reservation to a specific supplier (for fulfillment routing).
   */
  async transferToSupplier(
    reservationId: string,
    supplierId: string,
    quantity: number
  ): Promise<void> {
    await executeCql(
      `UPDATE inventory_reservations_w
       SET supplier_id = ?, quantity = ?, updated_at = toTimestamp(now())
       WHERE reservation_id = ?`,
      [supplierId, quantity, reservationId]
    );

    // Look up blank_sku for the signal
    const transferRows = await executeCql<ReservationRow>(
      `SELECT blank_sku FROM inventory_reservations_w WHERE reservation_id = ?`,
      [reservationId]
    );
    logger.info({ reservationId, supplierId, quantity }, 'Transferred reservation to supplier');
    if (transferRows.length > 0) {
      await signalInventoryChanged([transferRows[0].blank_sku]);
    }
  },

  // --- Batch Operations ---

  /**
   * Reserve all items for a cart in parallel.
   * Rolls back on any failure.
   */
  async reserveAll(
    cartId: string,
    items: Array<{ variantId: string; blankSku: string; quantity: number }>,
    referenceId?: string
  ): Promise<BatchReserveResult> {
    const ttlSeconds = 15 * 60; // 15 minutes for checkout
    const results = await Promise.all(
      items.map(item =>
        this.reserve({
          reservationId: `${cartId}-${item.variantId}`,
          cartId,
          blankSku: item.blankSku,
          variantId: item.variantId,
          quantity: item.quantity,
          referenceId: referenceId ?? `checkout-${cartId}`,
          ttlSeconds,
        })
      )
    );

    const failures = results.filter(r => !r.success);
    if (failures.length > 0) {
      // Roll back successful reservations
      const successfulIds = results
        .filter(r => r.success && r.reservationId)
        .map(r => r.reservationId!);
      await Promise.all(successfulIds.map(id => this.release(id)));

      return { success: false, error: failures[0].error };
    }

    return {
      success: true,
      reservations: results.map((r, i) => ({
        variantId: items[i].variantId,
        reservationId: r.reservationId!,
      })),
    };
  },

  /**
   * Release all reservations for a cart.
   */
  async releaseAllForCart(cartId: string): Promise<void> {
    const rows = await executeCql<CartReservationRow>(
      `SELECT reservation_id FROM inventory_reservations_by_cart_w WHERE cart_id = ?`,
      [cartId]
    );
    if (rows.length === 0) return;
    await Promise.all(rows.map(r => this.release(r.reservation_id)));
  },

  /**
   * Confirm all reservations for a cart.
   */
  async confirmAllForCart(cartId: string): Promise<void> {
    const rows = await executeCql<CartReservationRow>(
      `SELECT reservation_id FROM inventory_reservations_by_cart_w WHERE cart_id = ?`,
      [cartId]
    );
    if (rows.length === 0) return;
    await Promise.all(rows.map(r => this.confirm(r.reservation_id)));
  },

  /**
   * Reconcile reservations after cart change: release removed, reserve new, adjust changed.
   */
  async reconcile(
    cartId: string,
    oldItems: Array<{ variantId: string; blankSku: string; quantity: number }>,
    newItems: Array<{ variantId: string; blankSku: string; quantity: number }>
  ): Promise<BatchReserveResult> {
    const oldMap = new Map(oldItems.map(i => [i.variantId, i]));
    const newMap = new Map(newItems.map(i => [i.variantId, i]));

    // Items removed from cart
    const removed = oldItems.filter(i => !newMap.has(i.variantId));
    // Items added to cart
    const added = newItems.filter(i => !oldMap.has(i.variantId));
    // Items with changed quantity (release + re-reserve for simplicity)
    const changed = newItems.filter(i => {
      const old = oldMap.get(i.variantId);
      return old && old.quantity !== i.quantity;
    });

    // Release removed + changed
    const toRelease = [...removed, ...changed];
    await Promise.all(
      toRelease.map(item => this.release(`${cartId}-${item.variantId}`))
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
      [reservationId]
    );
    return rows.length > 0 ? rowToReservation(rows[0]) : null;
  },

  /**
   * Get all reservations for a cart.
   */
  async getReservationsByCart(cartId: string): Promise<ReservationRecord[]> {
    const cartRows = await executeCql<CartReservationRow>(
      `SELECT reservation_id FROM inventory_reservations_by_cart_w WHERE cart_id = ?`,
      [cartId]
    );
    if (cartRows.length === 0) return [];

    const reservations = await Promise.all(
      cartRows.map(r =>
        executeCql<ReservationRow>(
          `SELECT * FROM inventory_reservations_w WHERE reservation_id = ?`,
          [r.reservation_id]
        )
      )
    );

    return reservations
      .filter(rows => rows.length > 0)
      .map(rows => rowToReservation(rows[0]));
  },

  /**
   * Get all expired TEMPORARY reservations (for service workflow expiration).
   */
  async getExpiredReservations(): Promise<ReservationRecord[]> {
    // Note: Uses secondary index on status (idx_reservations_status).
    const rows = await executeCql<ReservationRow>(
      `SELECT * FROM inventory_reservations_w
       WHERE status = 'TEMPORARY' AND expires_at < toTimestamp(now()) ALLOW FILTERING`
    );
    return rows.map(rowToReservation);
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
    const rows = await executeCql<ReservationRow>(
      `SELECT * FROM inventory_reservations_w
       WHERE status IN ('TEMPORARY', 'CONFIRMED') ALLOW FILTERING`
    );
    return rows.map(rowToReservation);
  },
};
