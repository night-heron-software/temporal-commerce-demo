'use server';

import { executeCql } from '@/lib';
import { InventoryCommandRepository } from '@/temporal/inventory/db/inventory-command-repository';

// ─── Stock Summary ───

export interface StockSummaryRow {
  blankSku: string;
  fulfillerId: string;
  fulfillerName: string;
  totalStock: number;
  reservedStock: number;
  availableStock: number;
  cost: number;
}

export async function getInventoryStock(): Promise<{
  success: boolean;
  data: StockSummaryRow[];
  error?: string;
}> {
  try {
    interface DbRow {
      blank_sku: string;
      fulfiller_id: string;
      fulfiller_name: string;
      total_stock: number;
      reserved_stock: number;
      cost: number;
    }

    const rows = await executeCql<DbRow>(
      `SELECT blank_sku, fulfiller_id, fulfiller_name, total_stock, reserved_stock, cost
       FROM inventory_stock_w`,
    );

    const data: StockSummaryRow[] = rows.map((r) => ({
      blankSku: r.blank_sku,
      fulfillerId: r.fulfiller_id,
      fulfillerName: r.fulfiller_name,
      totalStock: r.total_stock,
      reservedStock: r.reserved_stock,
      availableStock: r.total_stock - r.reserved_stock,
      cost: r.cost,
    }));

    // Sort by reserved_stock desc (active reservations first), then by sku
    data.sort((a, b) => b.reservedStock - a.reservedStock || a.blankSku.localeCompare(b.blankSku));

    return { success: true, data };
  } catch (error) {
    return { success: false, data: [], error: String(error) };
  }
}

// ─── Reservations ───

export interface ReservationRow {
  reservationId: string;
  blankSku: string;
  cartId: string;
  variantId: string;
  fulfillerId: string | null;
  quantity: number;
  status: string;
  expiresAt: string | null;
  createdAt: string;
}

export async function getInventoryReservations(scope: 'active' | 'all' = 'active'): Promise<{
  success: boolean;
  data: ReservationRow[];
  error?: string;
}> {
  try {
    let data: ReservationRow[];

    if (scope === 'active') {
      // Partition read of the by_status active registry (TEMPORARY + CONFIRMED) —
      // no full-table scan for the default view.
      const records = await InventoryCommandRepository.getActiveReservations();
      data = records.map((r) => ({
        reservationId: r.reservationId,
        blankSku: r.blankSku,
        cartId: r.cartId,
        variantId: r.variantId,
        fulfillerId: r.fulfillerId,
        quantity: r.quantity,
        status: r.status,
        expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      }));
    } else {
      // 'all' is the explicit historical view: a full-table scan over every reservation
      // ever written (RELEASED/CANCELLED debris included). Dev tool — opt-in only.
      interface DbRow {
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

      const rows = await executeCql<DbRow>(
        `SELECT reservation_id, blank_sku, cart_id, variant_id, fulfiller_id,
                quantity, status, expires_at, created_at
         FROM inventory_reservations_w`,
      );

      data = rows.map((r) => ({
        reservationId: r.reservation_id,
        blankSku: r.blank_sku,
        cartId: r.cart_id,
        variantId: r.variant_id,
        fulfillerId: r.fulfiller_id,
        quantity: r.quantity,
        status: r.status,
        expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
        createdAt: r.created_at.toISOString(),
      }));
    }

    // Active first (TEMPORARY, CONFIRMED), then by created_at desc
    const statusOrder: Record<string, number> = {
      TEMPORARY: 0,
      CONFIRMED: 1,
      RELEASED: 2,
      CANCELLED: 3,
    };
    data.sort((a, b) => {
      const sa = statusOrder[a.status] ?? 9;
      const sb = statusOrder[b.status] ?? 9;
      if (sa !== sb) return sa - sb;
      return b.createdAt.localeCompare(a.createdAt);
    });

    return { success: true, data };
  } catch (error) {
    return { success: false, data: [], error: String(error) };
  }
}

// ─── Summary Stats ───

export interface InventoryStats {
  totalSkus: number;
  totalStock: number;
  totalReserved: number;
  totalAvailable: number;
  activeReservations: number;
  lowStockSkus: number;
}

export async function getInventoryStats(): Promise<{
  success: boolean;
  data: InventoryStats;
  error?: string;
}> {
  try {
    // Active-registry partition read — stats only need the active count, never the scan.
    const [stockResult, reservationResult] = await Promise.all([
      getInventoryStock(),
      getInventoryReservations('active'),
    ]);

    if (!stockResult.success || !reservationResult.success) {
      return {
        success: false,
        data: {
          totalSkus: 0,
          totalStock: 0,
          totalReserved: 0,
          totalAvailable: 0,
          activeReservations: 0,
          lowStockSkus: 0,
        },
        error: stockResult.error || reservationResult.error,
      };
    }

    const LOW_STOCK_THRESHOLD = 10;
    const stock = stockResult.data;
    const reservations = reservationResult.data;

    return {
      success: true,
      data: {
        totalSkus: stock.length,
        totalStock: stock.reduce((s, r) => s + r.totalStock, 0),
        totalReserved: stock.reduce((s, r) => s + r.reservedStock, 0),
        totalAvailable: stock.reduce((s, r) => s + r.availableStock, 0),
        // The active read already returns only TEMPORARY + CONFIRMED rows.
        activeReservations: reservations.length,
        lowStockSkus: stock.filter((r) => r.availableStock < LOW_STOCK_THRESHOLD).length,
      },
    };
  } catch (error) {
    return {
      success: false,
      data: {
        totalSkus: 0,
        totalStock: 0,
        totalReserved: 0,
        totalAvailable: 0,
        activeReservations: 0,
        lowStockSkus: 0,
      },
      error: String(error),
    };
  }
}
