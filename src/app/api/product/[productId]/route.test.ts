/**
 * Tests for the product detail route: ES term lookup by id, variant mapping,
 * synthetic-variant fallback for docs without variants, defaultVariant selection,
 * 404 for a miss, and the 500 envelope when ES fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const search = vi.hoisted(() => vi.fn());

vi.mock('@/lib/es-client', () => ({
  getElasticsearchClient: () => ({ search }),
}));

import { GET } from './route';

function invoke(productId: string) {
  return GET(new Request(`http://localhost/api/product/${productId}`), {
    params: Promise.resolve({ productId }),
  });
}

function esHit(source: Record<string, unknown>) {
  return { hits: { hits: [{ _source: source }] } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/product/[productId]', () => {
  it('returns the mapped product, variants and first available defaultVariant', async () => {
    search.mockResolvedValueOnce(
      esHit({
        id: 'p-1',
        name: 'Classic Tee',
        brand: 'Acme',
        model: 'CT-100',
        price: { amount: 1999, currency: 'USD' },
        variants: [
          { variantId: 'v-1', blankSku: 'SKU-1', available: false, options: [{ size: 'S' }] },
          {
            variantId: 'v-2',
            blankSku: 'SKU-2',
            price: { amount: 2199, currency: 'USD' },
            images: { front: 'front.png' },
          },
        ],
      }),
    );

    const res = await invoke('p-1');

    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledExactlyOnceWith({
      index: 'products',
      query: { bool: { must: [{ term: { id: 'p-1' } }] } },
      size: 1,
    });

    const body = await res.json();
    expect(body.product).toEqual({
      id: 'p-1',
      type: 'SIMULATED',
      name: 'Classic Tee',
      description: '',
      collectionIds: [],
      collectionNames: [],
      brand: 'Acme',
      model: 'CT-100',
    });
    expect(body.variants).toEqual([
      {
        id: 'v-1',
        blankSku: 'SKU-1',
        price: { amount: 1999, currency: 'USD' },
        available: false,
        variantImageUrl: '',
        options: [{ size: 'S' }],
        images: {},
      },
      {
        id: 'v-2',
        blankSku: 'SKU-2',
        price: { amount: 2199, currency: 'USD' },
        available: true,
        variantImageUrl: 'front.png',
        options: [],
        images: { front: 'front.png' },
      },
    ]);
    // v-1 is unavailable, so the first *available* variant wins.
    expect(body.defaultVariant.id).toBe('v-2');
  });

  it('synthesizes a single variant when the ES doc has none', async () => {
    search.mockResolvedValueOnce(
      esHit({
        id: 'p-2',
        name: 'No-Variant Product',
        price: { amount: 500, currency: 'USD' },
        defaultVariantId: 'dv-1',
        defaultVariantImageUrl: 'default.png',
      }),
    );

    const res = await invoke('p-2');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.variants).toEqual([
      {
        id: 'dv-1',
        blankSku: 'dv-1',
        price: { amount: 500, currency: 'USD' },
        available: true,
        variantImageUrl: 'default.png',
        options: [],
        images: { front: 'default.png' },
      },
    ]);
    expect(body.defaultVariant).toEqual(body.variants[0]);
  });

  it('returns 404 when no product matches', async () => {
    search.mockResolvedValueOnce({ hits: { hits: [] } });

    const res = await invoke('missing');

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: 'Product not found',
      correlationId: expect.any(String),
    });
  });

  it('returns a 500 envelope when the ES search throws', async () => {
    search.mockRejectedValueOnce(new Error('es exploded'));

    const res = await invoke('p-1');

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'Failed to fetch product',
      correlationId: expect.any(String),
    });
  });
});
