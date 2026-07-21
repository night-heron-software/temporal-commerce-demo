/**
 * Regression guard for silent data loss.
 *
 * `/api/dev/reindex` deletes and recreates each target index. `system_errors` is the only index
 * with no Cassandra source to rebuild from — ES holds the only copy — so reindexing it destroys
 * the error log. These tests pin that it is excluded from both `all` and targeted requests.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const es = vi.hoisted(() => ({
  delete: vi.fn().mockResolvedValue({}),
  create: vi.fn().mockResolvedValue({}),
  refresh: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/es-client', () => ({
  getElasticsearchClient: () => ({
    indices: { delete: es.delete, create: es.create, refresh: es.refresh },
  }),
}));

vi.mock('@/lib', () => ({
  executeCql: vi.fn().mockResolvedValue({ rows: [] }),
  executeCqlAll: vi.fn().mockResolvedValue([]),
}));

import { INDEX_MAPPINGS, NEVER_REINDEX, REINDEXABLE_INDICES } from '@/lib/es-index-mappings';

import { POST } from './route';

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/dev/reindex', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('system_errors is never reindexed', () => {
  it('is a real index that ensureIndicesExist will create', () => {
    expect(INDEX_MAPPINGS).toHaveProperty('system_errors');
  });

  it('is excluded from the reindexable set', () => {
    expect(NEVER_REINDEX.has('system_errors')).toBe(true);
    expect(REINDEXABLE_INDICES).not.toContain('system_errors');
  });

  it('rejects a targeted request with an explanation, without deleting', async () => {
    const res = await POST(request({ index: 'system_errors' }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('no Cassandra source'),
    });
    expect(es.delete).not.toHaveBeenCalled();
    expect(es.create).not.toHaveBeenCalled();
  });

  it('is skipped by a reindex-all', async () => {
    const res = await POST(request({ index: 'all' }));
    expect(res.status).toBe(200);

    const deleted = es.delete.mock.calls.map(([arg]) => arg.index);
    expect(deleted).not.toContain('system_errors');
    expect(deleted.length).toBeGreaterThan(0);

    const { results } = (await res.json()) as { results: Record<string, unknown> };
    expect(results).not.toHaveProperty('system_errors');
  });
});

describe('ordinary indices still reindex', () => {
  it('deletes and recreates a targeted index', async () => {
    const res = await POST(request({ index: 'products' }));

    expect(res.status).toBe(200);
    expect(es.delete).toHaveBeenCalledWith({ index: 'products' });
    expect(es.create).toHaveBeenCalledWith(
      expect.objectContaining({ index: 'products', mappings: INDEX_MAPPINGS.products }),
    );
  });

  it('still rejects an unknown index', async () => {
    const res = await POST(request({ index: 'nope' }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('Unknown index'),
    });
    expect(es.delete).not.toHaveBeenCalled();
  });

  it('recreates source-less but rebuildable indices (carts) empty', async () => {
    const res = await POST(request({ index: 'carts' }));

    expect(res.status).toBe(200);
    expect(es.create).toHaveBeenCalledWith(expect.objectContaining({ index: 'carts' }));
  });
});
