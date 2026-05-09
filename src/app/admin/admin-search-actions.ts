'use server';

/**
 * Admin Search Actions — Server Actions for querying Elasticsearch indices.
 */

import { getElasticsearchClient } from '@/lib/es-client';

const ALL_INDICES = [
  'products',
  'collections',
  'orders',
  'customers',
  'suppliers',
  'inventory',
  'supplier_orders',
  'carts',
  'reservations',
  'fulfillments',
  'shipments'
] as const;

export type SearchableIndex = (typeof ALL_INDICES)[number];

export interface SearchResult {
  index: string;
  id: string;
  score: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: Record<string, any>;
}

export interface SearchResponse {
  success: boolean;
  results: SearchResult[];
  total: number;
  took: number;
  error?: string;
}

export interface IndexStats {
  index: string;
  docCount: number;
  status: 'green' | 'yellow' | 'red' | 'unknown';
}

export async function getIndexStats(): Promise<{ success: boolean; stats: IndexStats[]; error?: string }> {
  try {
    const client = getElasticsearchClient();
    const stats: IndexStats[] = [];

    for (const index of ALL_INDICES) {
      try {
        const exists = await client.indices.exists({ index });
        if (exists) {
          const count = await client.count({ index });
          stats.push({
            index,
            docCount: count.count,
            status: 'green'
          });
        } else {
          stats.push({ index, docCount: 0, status: 'unknown' });
        }
      } catch {
        stats.push({ index, docCount: 0, status: 'red' });
      }
    }

    return { success: true, stats };
  } catch (error) {
    return { success: true, stats: [], error: String(error) };
  }
}

export async function searchElasticsearch(
  query: string,
  indices: SearchableIndex[],
  size: number = 25
): Promise<SearchResponse> {
  try {
    const client = getElasticsearchClient();

    // Filter to only indices that exist
    const existingIndices: string[] = [];
    for (const idx of indices) {
      const exists = await client.indices.exists({ index: idx });
      if (exists) existingIndices.push(idx);
    }

    if (existingIndices.length === 0) {
      return { success: true, results: [], total: 0, took: 0 };
    }

    const indexPattern = existingIndices.join(',');
    const trimmed = query.trim();

    // UUID pattern for detection and extraction
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

    // Extract any UUIDs from the query
    const uuids = trimmed.match(UUID_RE) ?? [];
    // Remaining text after removing UUIDs
    const textPart = trimmed.replace(UUID_RE, '').replace(/\s+/g, ' ').trim();

    // Build query clauses
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shouldClauses: any[] = [];

    // For each UUID found: exact match on _id and keyword fields (never analyzed)
    for (const uuid of uuids) {
      const lower = uuid.toLowerCase();
      shouldClauses.push(
        { ids: { values: [lower] } },
        // Direct term matches on common UUID fields (keyword = no analysis)
        { term: { orderId: lower } },
        { term: { cartId: lower } },
        { term: { variantId: lower } },
        { term: { id: lower } },
        { term: { reservationId: lower } },
        { term: { supplierOrderId: lower } },
        { term: { shipmentId: lower } },
        { term: { supplierId: lower } },
        { term: { customerId: lower } },
        { term: { defaultVariantId: lower } },
        { term: { confirmationNumber: lower } },
        // Keyword sub-field sweep for any field we may have missed
        {
          multi_match: {
            query: lower,
            type: 'phrase',
            lenient: true,
            fields: ['*.keyword']
          }
        }
      );
    }

    // For remaining text: full-text search across analyzed fields
    if (textPart) {
      shouldClauses.push(
        {
          multi_match: {
            query: textPart,
            type: 'best_fields',
            fuzziness: 'AUTO',
            lenient: true,
            fields: ['*']
          }
        },
        {
          multi_match: {
            query: textPart,
            type: 'phrase',
            lenient: true,
            fields: ['*']
          }
        }
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let esQuery: any;
    if (shouldClauses.length === 0) {
      esQuery = { match_all: {} };
    } else {
      esQuery = {
        bool: {
          should: shouldClauses,
          minimum_should_match: 1
        }
      };
    }

    const response = await client.search({
      index: indexPattern,
      size: Math.min(size, 100),
      query: esQuery,
      highlight: {
        fields: { '*': {} },
        pre_tags: ['<mark>'],
        post_tags: ['</mark>']
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: SearchResult[] = (response.hits.hits as any[]).map((hit) => ({
      index: hit._index,
      id: hit._id,
      score: hit._score ?? 0,
      source: hit._source ?? {}
    }));

    const total = typeof response.hits.total === 'number'
      ? response.hits.total
      : response.hits.total?.value ?? 0;

    return {
      success: true,
      results,
      total,
      took: response.took
    };
  } catch (error) {
    console.error('Search failed:', error);
    return { success: false, results: [], total: 0, took: 0, error: String(error) };
  }
}

export async function getDocument(
  index: string,
  id: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ success: boolean; source?: Record<string, any>; error?: string }> {
  try {
    const client = getElasticsearchClient();
    const response = await client.get({ index, id });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { success: true, source: response._source as Record<string, any> };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
