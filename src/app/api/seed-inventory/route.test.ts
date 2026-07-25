/**
 * Tests for the inventory seed route: SKU dedupe from the variants table, the
 * guard when the catalog has not been seeded, fulfiller-location fallback, and
 * the 500 path when the command repository fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeCql: vi.fn(),
  executeCqlAll: vi.fn(),
  setFulfillerStock: vi.fn(),
}));

vi.mock('@/lib', () => ({
  executeCql: mocks.executeCql,
  executeCqlAll: mocks.executeCqlAll,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/temporal/inventory/db/inventory-command-repository', () => ({
  InventoryCommandRepository: { setFulfillerStock: mocks.setFulfillerStock },
}));

import { POST } from './route';

const WAREHOUSE_ROW = {
  address1: '9 Dock Rd',
  city: 'Springfield',
  state: 'IL',
  postal_code: '62701',
  country: 'US',
  cost: 250,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeCql.mockResolvedValue([WAREHOUSE_ROW]);
  mocks.executeCqlAll.mockResolvedValue([
    { blank_sku: 'SKU-1' },
    { blank_sku: 'SKU-2' },
    { blank_sku: 'SKU-1' }, // duplicate — must be deduped
    { blank_sku: '' }, // falsy — must be filtered
  ]);
  mocks.setFulfillerStock.mockResolvedValue({
    fulfillerId: 'default-fulfiller',
    previousStock: 0,
    newStock: 100,
    available: 100,
  });
});

describe('POST /api/seed-inventory', () => {
  it('seeds each unique SKU once through the command repository', async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(mocks.setFulfillerStock).toHaveBeenCalledTimes(2);
    expect(mocks.setFulfillerStock).toHaveBeenCalledWith('SKU-1', {
      fulfillerId: 'default-fulfiller',
      fulfillerName: 'Default Fulfiller',
      totalStock: 100,
      cost: 250,
      address1: '9 Dock Rd',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      country: 'US',
    });
    expect(mocks.setFulfillerStock).toHaveBeenCalledWith('SKU-2', expect.any(Object));

    await expect(res.json()).resolves.toEqual({
      success: true,
      message: 'Seeded inventory stock for 2 unique SKUs via inventory service',
      results: { uniqueSkus: 2, stockPerSku: 100, fulfiller: 'default-fulfiller' },
    });
  });

  it('returns 400 without seeding when the variants table is empty', async () => {
    mocks.executeCqlAll.mockResolvedValueOnce([]);

    const res = await POST();

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: 'No variants found — run catalog seed first',
    });
    expect(mocks.setFulfillerStock).not.toHaveBeenCalled();
  });

  it('falls back to the default warehouse address when no fulfiller location exists', async () => {
    mocks.executeCql.mockResolvedValueOnce([]);

    const res = await POST();

    expect(res.status).toBe(200);
    expect(mocks.setFulfillerStock).toHaveBeenCalledWith(
      'SKU-1',
      expect.objectContaining({
        address1: '123 Warehouse Ave',
        city: 'Warehouse City',
        state: 'WC',
        postalCode: '00000',
        country: 'US',
        cost: 0,
      }),
    );
  });

  it('returns 500 when a stock write fails', async () => {
    mocks.setFulfillerStock.mockRejectedValueOnce(new Error('cassandra unavailable'));

    const res = await POST();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: 'Error: cassandra unavailable',
    });
  });
});
