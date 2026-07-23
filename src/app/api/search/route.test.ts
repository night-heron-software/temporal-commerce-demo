/**
 * Tests for GET /api/search — the Elasticsearch client is mocked; assertions inspect the
 * query DSL the route builds (filters, paging, sort) and how it parses hits/aggregations.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const es = vi.hoisted(() => ({
  search: vi.fn(),
}));

vi.mock('@/lib/es-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/es-client')>();
  return {
    ...actual, // keep the real isIndexNotFoundError
    getElasticsearchClient: () => ({ search: es.search }),
  };
});

import { GET } from './route';

/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect the untyped ES query DSL */

interface EsResponseOptions {
  hits?: any[];
  total?: number;
  aggregations?: Record<string, any>;
}

function makeEsResponse({
  hits = [],
  total = hits.length,
  aggregations = {},
}: EsResponseOptions = {}) {
  return {
    took: 3,
    hits: { total: { value: total }, hits },
    aggregations,
  };
}

function request(query: string = ''): NextRequest {
  return new NextRequest(`http://localhost/api/search${query}`);
}

/** The single argument the route passed to `client.search`. */
function searchArg(): any {
  expect(es.search).toHaveBeenCalledTimes(1);
  return es.search.mock.calls[0][0];
}

describe('GET /api/search', () => {
  beforeEach(() => {
    es.search.mockResolvedValue(makeEsResponse());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to match_all, page size 24, and name sort with no params', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);

    const arg = searchArg();
    expect(arg.index).toBe('products');
    expect(arg.from).toBe(0);
    expect(arg.size).toBe(24);
    expect(arg.query.bool.must).toEqual([{ match_all: {} }]);
    expect(arg.query.bool.filter).toEqual([]);
    expect(arg.sort).toEqual([{ 'name.keyword': 'asc' }]);

    const body = await res.json();
    expect(body).toMatchObject({ hits: [], total: 0, page: 1, pageSize: 24 });
  });

  it('uses a fuzzy multi_match and relevance sort when q is set', async () => {
    await GET(request('?q=shirt'));

    const arg = searchArg();
    expect(arg.query.bool.must).toEqual([
      {
        multi_match: {
          query: 'shirt',
          fields: ['name^3', 'description', 'collectionNames'],
          fuzziness: 'AUTO',
        },
      },
    ]);
    expect(arg.sort).toEqual(['_score']);
  });

  it('adds term and range filters for collection, type, and price bounds', async () => {
    await GET(request('?collection=Tees&type=apparel&priceMin=1000&priceMax=5000'));

    const filter = searchArg().query.bool.filter;
    expect(filter).toContainEqual({ term: { 'collectionNames.keyword': 'Tees' } });
    expect(filter).toContainEqual({ term: { type: 'apparel' } });
    expect(filter).toContainEqual({ range: { 'price.amount': { gte: 1000, lte: 5000 } } });
  });

  it('combines color and size into one nested variants filter with inner_hits', async () => {
    await GET(request('?color=Black&size=M'));

    const filter = searchArg().query.bool.filter;
    expect(filter).toHaveLength(1);
    const nested = filter[0].nested;
    expect(nested.path).toBe('variants');
    // Both option filters must match the SAME variant.
    expect(nested.query.bool.must).toHaveLength(2);
    // Color is active, so the matching variant comes back for the image swap.
    expect(nested.inner_hits).toMatchObject({ name: 'color_variants', size: 1 });
  });

  it('swaps the display image from the color inner hit', async () => {
    es.search.mockResolvedValue(
      makeEsResponse({
        hits: [
          {
            _source: {
              id: 'p1',
              name: 'Tee',
              type: 'apparel',
              price: { amount: 2500, currency: 'USD' },
              defaultVariantImageUrl: 'default.png',
            },
            inner_hits: {
              color_variants: {
                hits: { hits: [{ _source: { id: 'v-black', frontImageUrl: 'black.png' } }] },
              },
            },
          },
        ],
      }),
    );

    const res = await GET(request('?color=Black'));
    const body = await res.json();

    expect(body.hits[0]).toMatchObject({
      id: 'p1',
      defaultVariantImageUrl: 'black.png',
      displayVariantId: 'v-black',
    });
  });

  it('caps pageSize at 100 and computes the from offset', async () => {
    await GET(request('?page=3&pageSize=500'));

    const arg = searchArg();
    expect(arg.size).toBe(100);
    expect(arg.from).toBe(200);
  });

  it('parses facet aggregations including nested color hex buckets', async () => {
    es.search.mockResolvedValue(
      makeEsResponse({
        aggregations: {
          collections: { buckets: [{ key: 'Tees', doc_count: 4 }] },
          types: { buckets: [{ key: 'apparel', doc_count: 7 }] },
          price_ranges: {
            buckets: [{ key: 'Under $25', to: 2500, doc_count: 2 }],
          },
          color_facets: {
            scoped_variants: {
              variant_options: {
                color_filter: {
                  color_values: {
                    buckets: [
                      { key: 'Black', doc_count: 3, hex: { buckets: [{ key: '#000000' }] } },
                    ],
                  },
                },
              },
            },
          },
          size_facets: {
            scoped_variants: {
              variant_options: {
                size_filter: { size_values: { buckets: [{ key: 'M', doc_count: 5 }] } },
              },
            },
          },
        },
      }),
    );

    const res = await GET(request());
    const body = await res.json();

    expect(body.facets.collections).toEqual([{ name: 'Tees', count: 4 }]);
    expect(body.facets.types).toEqual([{ name: 'apparel', count: 7 }]);
    expect(body.facets.priceRanges).toEqual([{ label: 'Under $25', min: 0, max: 2500, count: 2 }]);
    expect(body.facets.colors).toEqual([{ name: 'Black', hex: '#000000', count: 3 }]);
    expect(body.facets.sizes).toEqual([{ name: 'M', count: 5 }]);
  });

  it('returns a 500 with a correlationId when Elasticsearch fails', async () => {
    es.search.mockRejectedValue(new Error('es exploded'));

    const res = await GET(request('?q=shirt'));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toBe('Search failed');
    expect(body.correlationId).toBeTypeOf('string');
  });

  it('returns a clean 400 when the products index does not exist (rebuild window)', async () => {
    // Shape of an @elastic/elasticsearch ResponseError for a missing index.
    es.search.mockRejectedValue(
      Object.assign(new Error('index_not_found_exception'), {
        meta: { body: { error: { type: 'index_not_found_exception' } } },
      }),
    );

    const res = await GET(request('?q=shirt'));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("index 'products' does not exist (it may be rebuilding)");
    expect(body.correlationId).toBeTypeOf('string');
  });
});
