'use server';

/**
 * Admin Search Actions — Server Actions for querying Elasticsearch indices.
 */

import { getElasticsearchClient, isIndexNotFoundError } from '@/lib/es-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('admin-search-actions');

const ALL_INDICES = [
  'products',
  'collections',
  'orders',
  'customers',
  'fulfillers',
  'inventory',
  'fulfiller_orders',
  'carts',
  'reservations',
  'fulfillments',
  'shipments',
] as const;

export type SearchableIndex = (typeof ALL_INDICES)[number];

/**
 * Lifecycle filter over the workflow-owned indices. Docs are marked
 * `workflowStatus: 'completed'` when their owning workflow closes; a missing field
 * means live — so docs in non-lifecycle indices (products, customers, …) count as
 * live and simply return nothing under `completed`.
 */
export type LifecycleFilter = 'live' | 'completed' | 'both';

/** Indices whose docs carry the workflow lifecycle fields. */
const LIFECYCLE_INDICES: ReadonlySet<string> = new Set([
  'orders',
  'fulfiller_orders',
  'carts',
  'reservations',
  'fulfillments',
  'shipments',
]);

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
  /** Docs marked completed by workflow close; only set for lifecycle indices. */
  completedCount?: number;
  status: 'green' | 'yellow' | 'red' | 'unknown';
}

export async function getIndexStats(): Promise<{
  success: boolean;
  stats: IndexStats[];
  error?: string;
}> {
  try {
    const client = getElasticsearchClient();
    const stats: IndexStats[] = [];

    for (const index of ALL_INDICES) {
      try {
        const exists = await client.indices.exists({ index });
        if (exists) {
          const count = await client.count({ index });
          let completedCount: number | undefined;
          if (LIFECYCLE_INDICES.has(index)) {
            const completed = await client.count({
              index,
              query: { term: { workflowStatus: 'completed' } },
            });
            completedCount = completed.count;
          }
          stats.push({
            index,
            docCount: count.count,
            completedCount,
            status: 'green',
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
    return { success: false, stats: [], error: String(error) };
  }
}

export async function searchElasticsearch(
  query: string,
  indices: SearchableIndex[],
  size: number = 25,
  lifecycle: LifecycleFilter = 'both',
): Promise<SearchResponse> {
  // Hoisted so the catch block can attribute failures to the index set actually queried.
  let indexPattern = indices.join(',');
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

    indexPattern = existingIndices.join(',');
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
        // Top-level keyword field (ADR-0011 journey UUID) — the '*.keyword' sweep below
        // only reaches text sub-fields, so it must be matched here explicitly.
        { term: { correlationId: lower } },
        { term: { variantId: lower } },
        { term: { id: lower } },
        { term: { reservationId: lower } },
        { term: { fulfillerOrderId: lower } },
        { term: { shipmentId: lower } },
        { term: { fulfillerId: lower } },
        { term: { customerId: lower } },
        { term: { defaultVariantId: lower } },
        { term: { confirmationNumber: lower } },
        // Keyword sub-field sweep for any field we may have missed
        {
          multi_match: {
            query: lower,
            type: 'phrase',
            lenient: true,
            fields: ['*.keyword'],
          },
        },
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
            fields: ['*'],
          },
        },
        {
          multi_match: {
            query: textPart,
            type: 'phrase',
            lenient: true,
            fields: ['*'],
          },
        },
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
          minimum_should_match: 1,
        },
      };
    }

    // Lifecycle filter: a missing workflowStatus counts as live, so non-lifecycle
    // indices pass `live`/`both` untouched and return nothing under `completed`.
    if (lifecycle === 'live') {
      esQuery = {
        bool: { must: [esQuery], must_not: [{ term: { workflowStatus: 'completed' } }] },
      };
    } else if (lifecycle === 'completed') {
      esQuery = {
        bool: { must: [esQuery], filter: [{ term: { workflowStatus: 'completed' } }] },
      };
    }

    const response = await client.search({
      index: indexPattern,
      size: Math.min(size, 100),
      query: esQuery,
      highlight: {
        fields: { '*': {} },
        pre_tags: ['<mark>'],
        post_tags: ['</mark>'],
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: SearchResult[] = (response.hits.hits as any[]).map((hit) => ({
      index: hit._index,
      id: hit._id,
      score: hit._score ?? 0,
      source: hit._source ?? {},
    }));

    const total =
      typeof response.hits.total === 'number'
        ? response.hits.total
        : (response.hits.total?.value ?? 0);

    return {
      success: true,
      results,
      total,
      took: response.took,
    };
  } catch (error) {
    if (isIndexNotFoundError(error)) {
      // A target index vanished between the exists() pre-check and the search — a
      // transient delete-and-recreate reindexing window. Clean client-facing failure,
      // logged at warn so rebuild windows don't spam system_errors.
      log.warn({ index: indexPattern, err: error }, 'Search index missing — it may be rebuilding');
      return {
        success: false,
        results: [],
        total: 0,
        took: 0,
        error: `index '${indexPattern}' does not exist (it may be rebuilding)`,
      };
    }
    log.error({ index: indexPattern, err: error }, 'Search failed');
    return { success: false, results: [], total: 0, took: 0, error: String(error) };
  }
}

export async function getDocument(
  index: string,
  id: string,
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
