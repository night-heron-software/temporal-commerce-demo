/**
 * Unit tests for admin inventory Server Actions: snake_case→camelCase row mapping,
 * availableStock derivation, sort orders, the active-registry vs. full-scan split,
 * and stats aggregation. Cassandra access is mocked at the lib/repository boundary.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const executeCql = vi.hoisted(() => vi.fn());
const getActiveReservations = vi.hoisted(() => vi.fn());

vi.mock('@/lib', () => ({ executeCql }));
vi.mock('@/temporal/inventory/db/inventory-command-repository', () => ({
  InventoryCommandRepository: { getActiveReservations },
}));

import {
  getInventoryStock,
  getInventoryReservations,
  getInventoryStats,
} from './admin-inventory-actions';

function stockRow(overrides: Record<string, unknown> = {}) {
  return {
    blank_sku: 'TEE-BLK-M',
    fulfiller_id: 'ful-1',
    fulfiller_name: 'Printful',
    total_stock: 100,
    reserved_stock: 5,
    cost: 7.5,
    ...overrides,
  };
}

function reservationRecord(overrides: Record<string, unknown> = {}) {
  return {
    reservationId: 'res-1',
    blankSku: 'TEE-BLK-M',
    cartId: 'cart-1',
    variantId: 'var-1',
    fulfillerId: 'ful-1',
    quantity: 2,
    status: 'TEMPORARY',
    expiresAt: new Date('2026-07-24T12:00:00Z'),
    createdAt: new Date('2026-07-24T11:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getInventoryStock', () => {
  it('maps rows to camelCase, derives availableStock, and sorts by reserved desc then sku', async () => {
    executeCql.mockResolvedValue([
      stockRow({ blank_sku: 'ZZZ', reserved_stock: 0, total_stock: 30 }),
      stockRow({ blank_sku: 'BBB', reserved_stock: 8, total_stock: 20 }),
      stockRow({ blank_sku: 'AAA', reserved_stock: 8, total_stock: 50 }),
    ]);

    const result = await getInventoryStock();

    expect(executeCql.mock.calls[0][0]).toContain('FROM inventory_stock_w');
    expect(result.success).toBe(true);
    expect(result.data.map((r) => r.blankSku)).toEqual(['AAA', 'BBB', 'ZZZ']);
    expect(result.data[0]).toEqual({
      blankSku: 'AAA',
      fulfillerId: 'ful-1',
      fulfillerName: 'Printful',
      totalStock: 50,
      reservedStock: 8,
      availableStock: 42,
      cost: 7.5,
    });
  });

  it('returns a stringified error with empty data on failure', async () => {
    executeCql.mockRejectedValue(new Error('cassandra down'));

    const result = await getInventoryStock();

    expect(result).toEqual({ success: false, data: [], error: 'Error: cassandra down' });
  });
});

describe('getInventoryReservations', () => {
  it("reads the active registry (no CQL scan) for the default 'active' scope", async () => {
    getActiveReservations.mockResolvedValue([
      reservationRecord(),
      reservationRecord({ reservationId: 'res-2', status: 'CONFIRMED', expiresAt: null }),
    ]);

    const result = await getInventoryReservations();

    expect(executeCql).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data[0]).toEqual({
      reservationId: 'res-1',
      blankSku: 'TEE-BLK-M',
      cartId: 'cart-1',
      variantId: 'var-1',
      fulfillerId: 'ful-1',
      quantity: 2,
      status: 'TEMPORARY',
      expiresAt: '2026-07-24T12:00:00.000Z',
      createdAt: '2026-07-24T11:00:00.000Z',
    });
    expect(result.data[1].expiresAt).toBeNull();
  });

  it("scans the full reservations table for 'all' and sorts active-first, newest-first", async () => {
    executeCql.mockResolvedValue([
      {
        reservation_id: 'r-released',
        blank_sku: 's',
        cart_id: 'c',
        variant_id: 'v',
        fulfiller_id: null,
        quantity: 1,
        status: 'RELEASED',
        expires_at: null,
        created_at: new Date('2026-07-24T10:00:00Z'),
      },
      {
        reservation_id: 'r-temp-old',
        blank_sku: 's',
        cart_id: 'c',
        variant_id: 'v',
        fulfiller_id: 'f',
        quantity: 1,
        status: 'TEMPORARY',
        expires_at: new Date('2026-07-24T12:00:00Z'),
        created_at: new Date('2026-07-24T08:00:00Z'),
      },
      {
        reservation_id: 'r-temp-new',
        blank_sku: 's',
        cart_id: 'c',
        variant_id: 'v',
        fulfiller_id: 'f',
        quantity: 1,
        status: 'TEMPORARY',
        expires_at: null,
        created_at: new Date('2026-07-24T09:00:00Z'),
      },
      {
        reservation_id: 'r-weird',
        blank_sku: 's',
        cart_id: 'c',
        variant_id: 'v',
        fulfiller_id: null,
        quantity: 1,
        status: 'SOMETHING_ELSE',
        expires_at: null,
        created_at: new Date('2026-07-24T23:00:00Z'),
      },
    ]);

    const result = await getInventoryReservations('all');

    expect(getActiveReservations).not.toHaveBeenCalled();
    expect(executeCql.mock.calls[0][0]).toContain('FROM inventory_reservations_w');
    // TEMPORARY first (newest first within the tier), then RELEASED, then unknown statuses last.
    expect(result.data.map((r) => r.reservationId)).toEqual([
      'r-temp-new',
      'r-temp-old',
      'r-released',
      'r-weird',
    ]);
    expect(result.data[0].fulfillerId).toBe('f');
  });

  it('returns a failure envelope when the active-registry read throws', async () => {
    getActiveReservations.mockRejectedValue(new Error('partition gone'));

    const result = await getInventoryReservations('active');

    expect(result).toEqual({ success: false, data: [], error: 'Error: partition gone' });
  });
});

describe('getInventoryStats', () => {
  it('aggregates totals, active reservation count, and low-stock SKUs (<10 available)', async () => {
    executeCql.mockResolvedValue([
      stockRow({ blank_sku: 'A', total_stock: 100, reserved_stock: 95 }), // available 5 → low
      stockRow({ blank_sku: 'B', total_stock: 50, reserved_stock: 10 }), // available 40
    ]);
    getActiveReservations.mockResolvedValue([reservationRecord(), reservationRecord()]);

    const result = await getInventoryStats();

    expect(result).toEqual({
      success: true,
      data: {
        totalSkus: 2,
        totalStock: 150,
        totalReserved: 105,
        totalAvailable: 45,
        activeReservations: 2,
        lowStockSkus: 1,
      },
    });
  });

  it('propagates a sub-query failure as zeroed stats with the underlying error', async () => {
    executeCql.mockRejectedValue(new Error('stock scan failed'));
    getActiveReservations.mockResolvedValue([]);

    const result = await getInventoryStats();

    expect(result.success).toBe(false);
    expect(result.error).toBe('Error: stock scan failed');
    expect(result.data).toEqual({
      totalSkus: 0,
      totalStock: 0,
      totalReserved: 0,
      totalAvailable: 0,
      activeReservations: 0,
      lowStockSkus: 0,
    });
  });
});
