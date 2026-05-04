import { Inventory } from '../../contracts';
/**
 * Inventory Query Repository (CQRS Read Side — Cassandra Only)
 *
 * Handles structured reads from Cassandra read tables (eventually consistent).
 * These tables are projected by the Inventory.inventoryServiceWorkflow from write tables.
 *
 * For search, filtering, and complex queries, consumers access Elasticsearch directly.
 */

import { executeCql } from '../../../lib';
import { types } from 'cassandra-driver';

// ============================================================
// Types
// ============================================================

export interface StockSummary {
  blankSku: string;
  totalStock: number;
  reservedStock: number;
  availableStock: number;
  supplierCount: number;
  lowStock: boolean;
  lastProjectedAt: Date | null;
}

export interface StockLevel {
  total: number;
  reserved: number;
  available: number;
}

export interface SupplierStock {
  supplierId: string;
  blankSku: string;
  supplierName: string;
  totalStock: number;
  reservedStock: number;
  availableStock: number;
  cost: number;
  city: string;
  state: string;
  country: string;
  lastProjectedAt: Date | null;
}

export interface SkuReservation {
  blankSku: string;
  reservationId: string;
  storeId: string;
  cartId: string;
  variantId: string;
  quantity: number;
  status: string;
  supplierId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface LowStockEntry {
  thresholdBucket: string;
  blankSku: string;
  availableStock: number;
  totalStock: number;
  lastProjectedAt: Date | null;
}

// ============================================================
// Cassandra Row Types
// ============================================================

interface StockSummaryRow {
  blank_sku: string;
  total_stock: number;
  reserved_stock: number;
  available_stock: number;
  supplier_count: number;
  low_stock: boolean;
  last_projected_at: Date | null;
}

interface SupplierStockRow {
  supplier_id: string;
  blank_sku: string;
  supplier_name: string;
  total_stock: number;
  reserved_stock: number;
  available_stock: number;
  cost: number;
  city: string;
  state: string;
  country: string;
  last_projected_at: Date | null;
}

interface SkuReservationRow {
  blank_sku: string;
  reservation_id: string;
  store_id: types.Uuid;
  cart_id: string;
  variant_id: string;
  quantity: number;
  status: string;
  supplier_id: string | null;
  expires_at: Date | null;
  created_at: Date;
}

interface LowStockRow {
  threshold_bucket: string;
  blank_sku: string;
  available_stock: number;
  total_stock: number;
  last_projected_at: Date | null;
}

// ============================================================
// Row Mappers
// ============================================================

function rowToStockSummary(row: StockSummaryRow): StockSummary {
  return {
    blankSku: row.blank_sku,
    totalStock: row.total_stock,
    reservedStock: row.reserved_stock,
    availableStock: row.available_stock,
    supplierCount: row.supplier_count,
    lowStock: row.low_stock,
    lastProjectedAt: row.last_projected_at,
  };
}

function rowToSupplierStock(row: SupplierStockRow): SupplierStock {
  return {
    supplierId: row.supplier_id,
    blankSku: row.blank_sku,
    supplierName: row.supplier_name,
    totalStock: row.total_stock,
    reservedStock: row.reserved_stock,
    availableStock: row.available_stock,
    cost: row.cost,
    city: row.city,
    state: row.state,
    country: row.country,
    lastProjectedAt: row.last_projected_at,
  };
}

function rowToSkuReservation(row: SkuReservationRow): SkuReservation {
  return {
    blankSku: row.blank_sku,
    reservationId: row.reservation_id,
    storeId: row.store_id.toString(),
    cartId: row.cart_id,
    variantId: row.variant_id,
    quantity: row.quantity,
    status: row.status,
    supplierId: row.supplier_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function rowToLowStockEntry(row: LowStockRow): LowStockEntry {
  return {
    thresholdBucket: row.threshold_bucket,
    blankSku: row.blank_sku,
    availableStock: row.available_stock,
    totalStock: row.total_stock,
    lastProjectedAt: row.last_projected_at,
  };
}

// ============================================================
// Repository
// ============================================================

export const InventoryQueryRepository = {

  /**
   * Get stock level for a single SKU.
   */
  async getStockLevel(blankSku: string): Promise<Inventory.StockLevel | null> {
    const rows = await executeCql<StockSummaryRow>(
      `SELECT total_stock, reserved_stock, available_stock
       FROM inventory_stock_summary WHERE blank_sku = ?`,
      [blankSku]
    );
    if (rows.length === 0) return null;

    return {
      total: rows[0].total_stock,
      reserved: rows[0].reserved_stock,
      available: rows[0].available_stock,
    };
  },

  /**
   * Get all stock summaries (one per SKU).
   */
  async getAllStock(): Promise<StockSummary[]> {
    const rows = await executeCql<StockSummaryRow>(
      `SELECT * FROM inventory_stock_summary`
    );
    return rows.map(rowToStockSummary);
  },

  /**
   * Get low stock entries.
   */
  async getLowStock(bucket: string = 'default'): Promise<LowStockEntry[]> {
    const rows = await executeCql<LowStockRow>(
      `SELECT * FROM inventory_low_stock WHERE threshold_bucket = ?`,
      [bucket]
    );
    return rows.map(rowToLowStockEntry);
  },

  /**
   * Get all stock for a specific supplier.
   */
  async getStockBySupplier(supplierId: string): Promise<SupplierStock[]> {
    const rows = await executeCql<SupplierStockRow>(
      `SELECT * FROM inventory_stock_by_supplier WHERE supplier_id = ?`,
      [supplierId]
    );
    return rows.map(rowToSupplierStock);
  },

  /**
   * Get stock for a specific SKU from a specific supplier.
   */
  async getSupplierForSku(
    supplierId: string,
    blankSku: string
  ): Promise<SupplierStock | null> {
    const rows = await executeCql<SupplierStockRow>(
      `SELECT * FROM inventory_stock_by_supplier
       WHERE supplier_id = ? AND blank_sku = ?`,
      [supplierId, blankSku]
    );
    return rows.length > 0 ? rowToSupplierStock(rows[0]) : null;
  },

  /**
   * Get all reservations for a SKU (ordered by most recent).
   */
  async getReservationsBySku(blankSku: string, storeId?: string): Promise<SkuReservation[]> {
    const rows = await executeCql<SkuReservationRow>(
      `SELECT * FROM inventory_reservations_by_sku WHERE blank_sku = ?`,
      [blankSku]
    );
    let reservations = rows.map(rowToSkuReservation);
    if (storeId) {
      reservations = reservations.filter((r) => r.storeId === storeId);
    }
    return reservations;
  },
};
