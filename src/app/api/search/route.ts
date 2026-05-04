import { NextRequest, NextResponse } from 'next/server';
import { Client } from '@elastic/elasticsearch';
import { DEMO_STORE_ID } from '@/lib/constants';

const ES_URL = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
const client = new Client({ node: ES_URL });

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
    const filter: object[] = [
      { term: { storeId: DEMO_STORE_ID } }
    ];

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

    if (params.color) {
      filter.push({
        nested: {
          path: 'variants',
          query: {
            nested: {
              path: 'variants.options',
              query: {
                bool: {
                  must: [
                    { term: { 'variants.options.optionType': 'Color' } },
                    { term: { 'variants.options.value.label': params.color } }
                  ]
                }
              }
            }
          },
          inner_hits: {
            name: 'color_variants',
            size: 1,
            _source: ['variants.frontImageUrl']
          }
        }
      });
    }

    if (params.size) {
      filter.push({
        nested: {
          path: 'variants',
          query: {
            nested: {
              path: 'variants.options',
              query: {
                bool: {
                  must: [
                    { term: { 'variants.options.optionType': 'Size' } },
                    { term: { 'variants.options.value.label': params.size } }
                  ]
                }
              }
            }
          }
        }
      });
    }

    const from = ((params.page || 1) - 1) * (params.pageSize || 24);

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
        color_facets: {
          nested: { path: 'variants' },
          aggs: {
            variant_options: {
              nested: { path: 'variants.options' },
              aggs: {
                color_filter: {
                  filter: { term: { 'variants.options.optionType': 'Color' } },
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
        },
        size_facets: {
          nested: { path: 'variants' },
          aggs: {
            variant_options: {
              nested: { path: 'variants.options' },
              aggs: {
                size_filter: {
                  filter: { term: { 'variants.options.optionType': 'Size' } },
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
          const variantSource = innerHits[0]._source as { frontImageUrl?: string };
          if (variantSource?.frontImageUrl) {
            return { ...product, defaultVariantImageUrl: variantSource.frontImageUrl };
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
    const colorBuckets = aggs?.color_facets?.variant_options?.color_filter?.color_values?.buckets || [];
    const sizeBuckets = aggs?.size_facets?.variant_options?.size_filter?.size_values?.buckets || [];

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
