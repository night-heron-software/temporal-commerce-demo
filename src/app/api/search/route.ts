import { NextRequest, NextResponse } from 'next/server';
import { getElasticsearchClient } from '@/lib/es-client';

// Option type names can be inconsistent across suppliers.
// Group them by semantic category for search/faceting.
// 'Color'/'Size' are normalized names used in the demo catalog.json.
const COLOR_OPTION_TYPES = ['Color', 'Colors', 'Bella + Canvas Colors', 'AS Color colors', 'Comfort Colors® Colors'];
const SIZE_OPTION_TYPES = ['Size', 'Sizes', 'Clothing sizes'];

interface SearchParams {
  q?: string;
  collection?: string;
  priceMin?: number;
  priceMax?: number;
  type?: string;
  color?: string;
  size?: string;
  page?: number;
  pageSize?: number;
}

interface ProductHit {
  id: string;
  name: string;
  description?: string;
  type: string;
  price: { amount: number; currency: string };
  collectionId?: string;
  collectionName?: string;
  defaultVariantId?: string;
  defaultVariantImageUrl?: string;
  /** When set, the displayed image came from this specific variant (e.g. color filter match) */
  displayVariantId?: string;
}

/**
 * Build variant-scoped facet aggregations.
 * Each facet is filtered by the OPPOSITE active variant filter so that
 * only valid combinations appear in the sidebar.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildVariantFacetAggs(params: SearchParams): Record<string, any> {
  // Helper: build a nested option-level filter clause
  function optionFilter(optionTypes: string[], label: string) {
    return {
      nested: {
        path: 'variants.options',
        query: {
          bool: {
            must: [
              { terms: { 'variants.options.optionType': optionTypes } },
              { term: { 'variants.options.value.label': label } }
            ]
          }
        }
      }
    };
  }

  // Color facet: scope to variants matching the active SIZE filter (if any)
  const colorVariantFilter = params.size
    ? { bool: { must: [optionFilter(SIZE_OPTION_TYPES, params.size)] } }
    : { match_all: {} };

  // Size facet: scope to variants matching the active COLOR filter (if any)
  const sizeVariantFilter = params.color
    ? { bool: { must: [optionFilter(COLOR_OPTION_TYPES, params.color)] } }
    : { match_all: {} };

  return {
    color_facets: {
      nested: { path: 'variants' },
      aggs: {
        scoped_variants: {
          filter: colorVariantFilter,
          aggs: {
            variant_options: {
              nested: { path: 'variants.options' },
              aggs: {
                color_filter: {
                  filter: { terms: { 'variants.options.optionType': COLOR_OPTION_TYPES } },
                  aggs: {
                    color_values: {
                      terms: { field: 'variants.options.value.label', size: 50 },
                      aggs: {
                        hex: {
                          terms: { field: 'variants.options.value.hex', size: 1 }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    size_facets: {
      nested: { path: 'variants' },
      aggs: {
        scoped_variants: {
          filter: sizeVariantFilter,
          aggs: {
            variant_options: {
              nested: { path: 'variants.options' },
              aggs: {
                size_filter: {
                  filter: { terms: { 'variants.options.optionType': SIZE_OPTION_TYPES } },
                  aggs: {
                    size_values: {
                      terms: { field: 'variants.options.value.label', size: 50 }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}

export async function GET(
  request: NextRequest
): Promise<NextResponse> {
  try {
    const searchParams = request.nextUrl.searchParams;

    const params: SearchParams = {
      q: searchParams.get('q') || undefined,
      collection: searchParams.get('collection') || undefined,
      priceMin: searchParams.get('priceMin') ? parseInt(searchParams.get('priceMin')!) : undefined,
      priceMax: searchParams.get('priceMax') ? parseInt(searchParams.get('priceMax')!) : undefined,
      type: searchParams.get('type') || undefined,
      color: searchParams.get('color') || undefined,
      size: searchParams.get('size') || undefined,
      page: parseInt(searchParams.get('page') || '1'),
      pageSize: Math.min(parseInt(searchParams.get('pageSize') || '24'), 100)
    };

    // Build ES query
    const must: object[] = [];
    const filter: object[] = [];

    if (params.q) {
      must.push({
        multi_match: {
          query: params.q,
          fields: ['name^3', 'description', 'collectionNames'],
          fuzziness: 'AUTO'
        }
      });
    }

    if (params.collection) {
      filter.push({ term: { 'collectionNames.keyword': params.collection } });
    }
    if (params.type) {
      filter.push({ term: { type: params.type } });
    }
    if (params.priceMin !== undefined || params.priceMax !== undefined) {
      const range: { gte?: number; lte?: number } = {};
      if (params.priceMin !== undefined) range.gte = params.priceMin;
      if (params.priceMax !== undefined) range.lte = params.priceMax;
      filter.push({ range: { 'price.amount': range } });
    }

    // Color and size filters must match the SAME variant, so combine them
    // into a single nested query when both are active.
    const variantOptionFilters: object[] = [];

    if (params.color) {
      variantOptionFilters.push({
        nested: {
          path: 'variants.options',
          query: {
            bool: {
              must: [
                { terms: { 'variants.options.optionType': COLOR_OPTION_TYPES } },
                { term: { 'variants.options.value.label': params.color } }
              ]
            }
          }
        }
      });
    }

    if (params.size) {
      variantOptionFilters.push({
        nested: {
          path: 'variants.options',
          query: {
            bool: {
              must: [
                { terms: { 'variants.options.optionType': SIZE_OPTION_TYPES } },
                { term: { 'variants.options.value.label': params.size } }
              ]
            }
          }
        }
      });
    }

    if (variantOptionFilters.length > 0) {
      filter.push({
        nested: {
          path: 'variants',
          query: {
            bool: {
              must: variantOptionFilters
            }
          },
          // Return the matching variant for display image swap
          ...(params.color ? {
            inner_hits: {
              name: 'color_variants',
              size: 1,
              _source: ['variants.id', 'variants.frontImageUrl']
            }
          } : {})
        }
      });
    }

    const from = ((params.page || 1) - 1) * (params.pageSize || 24);

    const client = getElasticsearchClient();

    const response = await client.search({
      index: 'products',
      from,
      size: params.pageSize || 24,
      query: {
        bool: {
          must: must.length > 0 ? must : [{ match_all: {} }],
          filter
        }
      },
      aggs: {
        collections: {
          terms: { field: 'collectionNames.keyword', size: 50 }
        },
        types: {
          terms: { field: 'type', size: 10 }
        },
        price_ranges: {
          range: {
            field: 'price.amount',
            ranges: [
              { key: 'Under $25', to: 2500 },
              { key: '$25 - $50', from: 2500, to: 5000 },
              { key: '$50 - $100', from: 5000, to: 10000 },
              { key: 'Over $100', from: 10000 }
            ]
          }
        },
        // Build variant-scoped facet aggregations.
        // When a color is active, size facets only count sizes on variants with that color.
        // When a size is active, color facets only count colors on variants with that size.
        ...buildVariantFacetAggs(params)
      },
      sort: params.q ? ['_score'] : [{ 'name.keyword': 'asc' }]
    });

    // Parse response
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hits: ProductHit[] = response.hits.hits.map((hit: any) => {
      const product = hit._source as ProductHit;
      if (params.color && hit.inner_hits?.color_variants) {
        const innerHits = hit.inner_hits.color_variants.hits.hits;
        if (innerHits.length > 0) {
          const variantSource = innerHits[0]._source as { id?: string; frontImageUrl?: string };
          if (variantSource?.frontImageUrl) {
            return {
              ...product,
              defaultVariantImageUrl: variantSource.frontImageUrl,
              displayVariantId: variantSource.id,
            };
          }
        }
      }
      return product;
    });

    const total =
      typeof response.hits.total === 'number'
        ? response.hits.total
        : response.hits.total?.value || 0;

    // Parse aggregations
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aggs = response.aggregations as Record<string, any>;

    const collectionBuckets = aggs?.collections?.buckets || [];
    const typeBuckets = aggs?.types?.buckets || [];
    const priceBuckets = aggs?.price_ranges?.buckets || [];
    const colorBuckets = aggs?.color_facets?.scoped_variants?.variant_options?.color_filter?.color_values?.buckets || [];
    const sizeBuckets = aggs?.size_facets?.scoped_variants?.variant_options?.size_filter?.size_values?.buckets || [];

    const facets = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      collections: collectionBuckets.map((b: any) => ({ name: b.key, count: b.doc_count })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      types: typeBuckets.map((b: any) => ({ name: b.key, count: b.doc_count })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      priceRanges: priceBuckets.map((b: any) => ({
        label: b.key, min: b.from || 0, max: b.to || Infinity, count: b.doc_count
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      colors: colorBuckets.map((b: any) => ({
        name: b.key, hex: b.hex?.buckets?.[0]?.key, count: b.doc_count
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sizes: sizeBuckets.map((b: any) => ({ name: b.key, count: b.doc_count }))
    };

    return NextResponse.json({
      hits,
      total,
      page: params.page || 1,
      pageSize: params.pageSize || 24,
      facets
    });
  } catch (error) {
    console.error('Search error:', error);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
