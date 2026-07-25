/**
 * Unit tests for admin ES search Server Actions: lifecycle filter composition
 * (live/completed/both), UUID-aware query building, per-index stats with
 * completedCount only on lifecycle indices, and the missing-index failure path.
 * The ES client is mocked; the real isIndexNotFoundError is kept via importOriginal.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const es = vi.hoisted(() => ({
  exists: vi.fn(),
  count: vi.fn(),
  search: vi.fn(),
  get: vi.fn(),
}));

vi.mock('@/lib/es-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/es-client')>();
  return {
    ...original,
    getElasticsearchClient: () => ({
      indices: { exists: es.exists },
      count: es.count,
      search: es.search,
      get: es.get,
    }),
  };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getIndexStats, searchElasticsearch, getDocument } from './admin-search-actions';

const EMPTY_SEARCH = { hits: { hits: [], total: { value: 0 } }, took: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  es.exists.mockResolvedValue(true);
  es.count.mockResolvedValue({ count: 0 });
  es.search.mockResolvedValue(EMPTY_SEARCH);
});

describe('getIndexStats', () => {
  it('adds completedCount only for lifecycle indices, via a workflowStatus term count', async () => {
    es.count.mockResolvedValue({ count: 7 });

    const { success, stats } = await getIndexStats();

    expect(success).toBe(true);
    const products = stats.find((s) => s.index === 'products');
    const orders = stats.find((s) => s.index === 'orders');
    expect(products).toEqual({ index: 'products', docCount: 7, status: 'green' });
    expect(products?.completedCount).toBeUndefined();
    expect(orders).toEqual({ index: 'orders', docCount: 7, completedCount: 7, status: 'green' });

    // The lifecycle count is a filtered term query on the same index.
    expect(es.count).toHaveBeenCalledWith({
      index: 'orders',
      query: { term: { workflowStatus: 'completed' } },
    });
    // 11 plain counts + 6 lifecycle counts.
    expect(es.count).toHaveBeenCalledTimes(17);
  });

  it("reports missing indices as 'unknown' and per-index failures as 'red'", async () => {
    es.exists.mockImplementation(async ({ index }: { index: string }) => index !== 'customers');
    es.count.mockImplementation(async ({ index }: { index: string }) => {
      if (index === 'products') throw new Error('shard trouble');
      return { count: 1 };
    });

    const { stats } = await getIndexStats();

    expect(stats.find((s) => s.index === 'customers')).toEqual({
      index: 'customers',
      docCount: 0,
      status: 'unknown',
    });
    expect(stats.find((s) => s.index === 'products')).toEqual({
      index: 'products',
      docCount: 0,
      status: 'red',
    });
    expect(stats.find((s) => s.index === 'collections')?.status).toBe('green');
  });
});

describe('searchElasticsearch lifecycle filter', () => {
  it("wraps the query in a must_not completed clause for 'live'", async () => {
    await searchElasticsearch('', ['orders'], 25, 'live');

    expect(es.search.mock.calls[0][0].query).toEqual({
      bool: {
        must: [{ match_all: {} }],
        must_not: [{ term: { workflowStatus: 'completed' } }],
      },
    });
  });

  it("adds a filter term clause for 'completed'", async () => {
    await searchElasticsearch('', ['orders'], 25, 'completed');

    expect(es.search.mock.calls[0][0].query).toEqual({
      bool: {
        must: [{ match_all: {} }],
        filter: [{ term: { workflowStatus: 'completed' } }],
      },
    });
  });

  it("leaves the query untouched for 'both' (default)", async () => {
    await searchElasticsearch('', ['orders']);

    expect(es.search.mock.calls[0][0].query).toEqual({ match_all: {} });
  });
});

describe('searchElasticsearch query building', () => {
  it('splits UUIDs from free text: term clauses for the UUID, multi_match for the rest', async () => {
    const uuid = 'DEADBEEF-0000-4000-8000-123456789abc';
    await searchElasticsearch(`refund ${uuid}`, ['orders', 'carts']);

    const query = es.search.mock.calls[0][0].query;
    const should = query.bool.should;
    // UUID clauses are lowercased and never analyzed.
    expect(should).toContainEqual({ ids: { values: [uuid.toLowerCase()] } });
    expect(should).toContainEqual({ term: { orderId: uuid.toLowerCase() } });
    expect(should).toContainEqual({ term: { cartId: uuid.toLowerCase() } });
    // The residual text still gets a fuzzy best_fields pass.
    expect(should).toContainEqual({
      multi_match: {
        query: 'refund',
        type: 'best_fields',
        fuzziness: 'AUTO',
        lenient: true,
        fields: ['*'],
      },
    });
    expect(query.bool.minimum_should_match).toBe(1);
  });

  it('searches only indices that exist, capping size at 100', async () => {
    es.exists.mockImplementation(async ({ index }: { index: string }) => index === 'orders');

    await searchElasticsearch('', ['orders', 'carts'], 5000);

    expect(es.search).toHaveBeenCalledWith(expect.objectContaining({ index: 'orders', size: 100 }));
  });

  it('short-circuits to an empty success when no target index exists', async () => {
    es.exists.mockResolvedValue(false);

    const response = await searchElasticsearch('anything', ['orders']);

    expect(response).toEqual({ success: true, results: [], total: 0, took: 0 });
    expect(es.search).not.toHaveBeenCalled();
  });

  it('maps hits and numeric totals from the ES response', async () => {
    es.search.mockResolvedValue({
      hits: {
        hits: [{ _index: 'orders', _id: 'o-1', _score: 1.5, _source: { orderId: 'o-1' } }],
        total: 1,
      },
      took: 9,
    });

    const response = await searchElasticsearch('o-1', ['orders']);

    expect(response).toEqual({
      success: true,
      results: [{ index: 'orders', id: 'o-1', score: 1.5, source: { orderId: 'o-1' } }],
      total: 1,
      took: 9,
    });
  });

  it('turns a vanished index (rebuild window) into a clean failure', async () => {
    es.search.mockRejectedValue(
      Object.assign(new Error('ResponseError'), {
        meta: { body: { error: { type: 'index_not_found_exception' } } },
      }),
    );

    const response = await searchElasticsearch('x', ['orders', 'carts']);

    expect(response.success).toBe(false);
    expect(response.error).toBe("index 'orders,carts' does not exist (it may be rebuilding)");
  });
});

describe('getDocument', () => {
  it('returns the document source, and a stringified error on failure', async () => {
    es.get.mockResolvedValueOnce({ _source: { orderId: 'o-1' } });
    await expect(getDocument('orders', 'o-1')).resolves.toEqual({
      success: true,
      source: { orderId: 'o-1' },
    });
    expect(es.get).toHaveBeenCalledWith({ index: 'orders', id: 'o-1' });

    es.get.mockRejectedValueOnce(new Error('missing'));
    await expect(getDocument('orders', 'o-2')).resolves.toEqual({
      success: false,
      error: 'Error: missing',
    });
  });
});
