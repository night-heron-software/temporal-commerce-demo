/**
 * Tests for the Cassandra catalog seed route: insert fan-out per entity (including
 * products_by_collection and variants_by_product denormalizations), per-item error
 * accumulation without aborting the run, and the 500 path when the sample file
 * cannot be read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeCql: vi.fn(),
  uuidFromString: vi.fn((s: string) => `uuid:${s}`),
  readFile: vi.fn(),
}));

vi.mock('@/lib', () => ({
  executeCql: mocks.executeCql,
  cassandraTypes: { Uuid: { fromString: mocks.uuidFromString } },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('fs/promises', () => ({
  default: { readFile: mocks.readFile },
}));

import { POST } from './route';

const SAMPLE = {
  collections: [{ id: 'c-1', name: 'Basics', description: 'Everyday staples' }],
  products: [
    {
      id: 'p-1',
      type: 'SIMULATED',
      name: 'Classic Tee',
      base_price_amount: 1999,
      base_price_currency: 'USD',
      default_variant_id: 'v-1',
      collection_ids: ['c-1'],
      collection_names: ['Basics'],
    },
  ],
  variants: [
    {
      id: 'v-1',
      blank_sku: 'SKU-1',
      product_id: 'p-1',
      product_name: 'Classic Tee',
      product_type: 'SIMULATED',
      price_amount: 1999,
      price_currency: 'USD',
      available: true,
      images: { back: 'back.png' },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeCql.mockResolvedValue([]);
  mocks.readFile.mockResolvedValue(JSON.stringify(SAMPLE));
});

describe('POST /api/seed-cassandra', () => {
  it('seeds collections, products (plus by-collection rows) and variants', async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      message: 'Sample data loaded successfully',
      results: { reset: false, collections: 1, products: 1, variants: 1, errors: [] },
    });

    // 1 collection + 1 product + 1 products_by_collection + 1 variant + 1 variants_by_product
    expect(mocks.executeCql).toHaveBeenCalledTimes(5);
    const statements = mocks.executeCql.mock.calls.map(([cql]) => cql as string);
    expect(statements.some((s) => s.includes('INSERT INTO products_by_collection'))).toBe(true);
    expect(statements.some((s) => s.includes('INSERT INTO variants_by_product'))).toBe(true);
  });

  it('falls back through the image map for the variants_by_product primary image', async () => {
    await POST();

    const byProductCall = mocks.executeCql.mock.calls.find(([cql]) =>
      (cql as string).includes('variants_by_product'),
    );
    expect(byProductCall).toBeDefined();
    // No 'front' image in SAMPLE, so 'back' is chosen.
    const params = byProductCall![1] as unknown[];
    expect(params).toContain('back.png');
  });

  it('records a per-item error and keeps seeding the rest', async () => {
    // First insert (the collection) fails; everything after succeeds.
    mocks.executeCql.mockRejectedValueOnce(new Error('write timeout'));

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results.collections).toBe(0);
    expect(body.results.products).toBe(1);
    expect(body.results.variants).toBe(1);
    expect(body.results.errors).toEqual([expect.stringContaining('Collection c-1')]);
  });

  it('returns 500 when the sample-data file cannot be read', async () => {
    mocks.readFile.mockRejectedValueOnce(new Error('ENOENT: no such file'));

    const res = await POST();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Failed to seed database'),
    });
    expect(mocks.executeCql).not.toHaveBeenCalled();
  });
});
