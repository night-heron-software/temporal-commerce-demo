'use server';

import { executeCql } from '@/lib';

// ─── Stock Summary ───

export interface StockSummaryRow {
  blankSku: string;
  supplierId: string;
  supplierName: string;
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
      supplier_id: string;
      supplier_name: string;
      total_stock: number;
      reserved_stock: number;
      cost: number;
    }

    const rows = await executeCql<DbRow>(
      `SELECT blank_sku, supplier_id, supplier_name, total_stock, reserved_stock, cost
       FROM inventory_stock_w`
    );

    const data: StockSummaryRow[] = rows.map(r => ({
      blankSku: r.blank_sku,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
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
  supplierId: string | null;
  quantity: number;
  status: string;
  expiresAt: string | null;
  createdAt: string;
}

export async function getInventoryReservations(): Promise<{
  success: boolean;
  data: ReservationRow[];
  error?: string;
}> {
  try {
    interface DbRow {
      reservation_id: string;
      blank_sku: string;
      cart_id: string;
      variant_id: string;
      supplier_id: string | null;
      quantity: number;
      status: string;
      expires_at: Date | null;
      created_at: Date;
    }

    const rows = await executeCql<DbRow>(
      `SELECT reservation_id, blank_sku, cart_id, variant_id, supplier_id,
              quantity, status, expires_at, created_at
       FROM inventory_reservations_w`
    );

    const data: ReservationRow[] = rows.map(r => ({
      reservationId: r.reservation_id,
      blankSku: r.blank_sku,
      cartId: r.cart_id,
      variantId: r.variant_id,
      supplierId: r.supplier_id,
      quantity: r.quantity,
      status: r.status,
      expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
      createdAt: r.created_at.toISOString(),
    }));

    // Active first (TEMPORARY, CONFIRMED), then by created_at desc
    const statusOrder: Record<string, number> = { TEMPORARY: 0, CONFIRMED: 1, RELEASED: 2, CANCELLED: 3 };
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
    const [stockResult, reservationResult] = await Promise.all([
      getInventoryStock(),
      getInventoryReservations(),
    ]);

    if (!stockResult.success || !reservationResult.success) {
      return {
        success: false,
        data: { totalSkus: 0, totalStock: 0, totalReserved: 0, totalAvailable: 0, activeReservations: 0, lowStockSkus: 0 },
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
        activeReservations: reservations.filter(r => r.status === 'TEMPORARY' || r.status === 'CONFIRMED').length,
        lowStockSkus: stock.filter(r => r.availableStock < LOW_STOCK_THRESHOLD).length,
      },
    };
  } catch (error) {
    return {
      success: false,
      data: { totalSkus: 0, totalStock: 0, totalReserved: 0, totalAvailable: 0, activeReservations: 0, lowStockSkus: 0 },
      error: String(error),
    };
  }
}
