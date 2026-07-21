/**
 * System-errors query service.
 *
 * Reads the `system_errors` Elasticsearch index that `src/lib/logger.ts` writes error/fatal log
 * lines into. Server-only — imported by the API route, never a client bundle.
 */
import { getElasticsearchClient } from '@/lib/es-client';

export const SYSTEM_ERRORS_INDEX = 'system_errors';

export type ErrorLevel = 'error' | 'fatal';

export interface SystemErrorHit {
  errorId: string;
  timestamp: string;
  level: ErrorLevel;
  message: string;
  component?: string;
  stack?: string;
  context: Record<string, unknown>;
}

export interface SystemErrorsResponse {
  hits: SystemErrorHit[];
  total: number;
  page: number;
  pageSize: number;
}

/** Relative windows offered by the viewer, in milliseconds. */
export const SINCE_OFFSETS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export const DEFAULT_SINCE = '24h';
export const DEFAULT_PAGE_SIZE = 50;

export interface QueryParams {
  /** Free-text match against the message. */
  q?: string;
  /** Filter to a single level; omit for both. */
  level?: ErrorLevel;
  /** Key of SINCE_OFFSETS; defaults to 24h. */
  since?: string;
  page?: number;
  pageSize?: number;
}

export async function querySystemErrors(params: QueryParams = {}): Promise<SystemErrorsResponse> {
  const { q, level } = params;
  const since = params.since && params.since in SINCE_OFFSETS ? params.since : DEFAULT_SINCE;
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, params.pageSize ?? DEFAULT_PAGE_SIZE));

  const filter: Record<string, unknown>[] = [
    { range: { timestamp: { gte: new Date(Date.now() - SINCE_OFFSETS[since]).toISOString() } } },
  ];
  // `match`, not `term`: if an error is logged before `ensureIndicesExist()` runs, Elasticsearch
  // auto-creates the index with a dynamic mapping where `level` is `text` rather than `keyword`.
  // `match` filters correctly under either mapping.
  if (level) filter.push({ match: { level } });

  const must: Record<string, unknown>[] = [];
  if (q) must.push({ match: { message: q } });

  const client = getElasticsearchClient();
  const res = await client.search({
    index: SYSTEM_ERRORS_INDEX,
    query: { bool: { filter, ...(must.length ? { must } : {}) } },
    sort: [{ timestamp: { order: 'desc' } }],
    from: (page - 1) * pageSize,
    size: pageSize,
    // The index is created lazily by the first error; an empty result beats a 404.
    ignore_unavailable: true,
  });

  const total = typeof res.hits.total === 'number' ? res.hits.total : (res.hits.total?.value ?? 0);

  return {
    hits: res.hits.hits.map((h) => h._source as SystemErrorHit),
    total,
    page,
    pageSize,
  };
}

/** Empty the index. Returns the number of documents removed. */
export async function clearSystemErrors(): Promise<number> {
  const client = getElasticsearchClient();
  const res = await client.deleteByQuery({
    index: SYSTEM_ERRORS_INDEX,
    query: { match_all: {} },
    refresh: true,
    ignore_unavailable: true,
  });
  return res.deleted ?? 0;
}
