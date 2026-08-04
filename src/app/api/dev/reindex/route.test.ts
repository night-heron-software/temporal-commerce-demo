/**
 * Regression guard for silent data loss.
 *
 * `/api/dev/reindex` deletes and recreates each target index. `system_errors` is the only index
 * with no Cassandra source to rebuild from — ES holds the only copy — so reindexing it destroys
 * the error log. These tests pin that it is excluded from both `all` and targeted requests.
 */
import { readFileSync } from 'node:fs';

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Must cover EVERY esClient.indices.* method the route calls. A missing one is not a
// missing assertion — it is `undefined`, so the call throws, and the route's own
// try/catch swallows it as a warning. That is how `exists` (added to the route on
// 2026-07-27) silently disabled the delete path these tests exist to guard: the
// suite went red claiming "expected 0 to be greater than 0" rather than naming the
// real cause. Route calls: create, delete, exists, putMapping, refresh.
const es = vi.hoisted(() => ({
  delete: vi.fn().mockResolvedValue({}),
  create: vi.fn().mockResolvedValue({}),
  refresh: vi.fn().mockResolvedValue({}),
  // The route deletes only `if (exists)`, so a falsy default would skip the delete
  // and quietly neuter the regression guard.
  exists: vi.fn().mockResolvedValue(true),
  putMapping: vi.fn().mockResolvedValue({}),
  index: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/es-client', () => ({
  getElasticsearchClient: () => ({
    indices: {
      delete: es.delete,
      create: es.create,
      refresh: es.refresh,
      exists: es.exists,
      putMapping: es.putMapping,
    },
    index: es.index,
  }),
}));

vi.mock('@/lib', () => ({
  executeCql: vi.fn().mockResolvedValue({ rows: [] }),
  executeCqlAll: vi.fn().mockResolvedValue([]),
}));

import { executeCql } from '@/lib';
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

describe('the mock keeps up with the route', () => {
  // The failure mode this prevents is nastier than a stale assertion. The route wraps its
  // index calls in try/catch, so an unmocked method is `undefined`, throws, and gets
  // swallowed as a warning — the guarded behaviour silently stops happening while the
  // error message points somewhere else entirely. Assert against the source so adding a
  // client call to the route fails HERE, naming the method, instead of over there.
  it('stubs every esClient.indices.* method the route calls', () => {
    const routeSrc = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    const used = [...routeSrc.matchAll(/indices\.([a-zA-Z]+)\(/g)].map((m) => m[1]);

    expect(used.length).toBeGreaterThan(0); // guard against a regex that matches nothing
    expect([...new Set(used)].sort()).toEqual(
      expect.arrayContaining(
        Object.keys(es)
          .filter((k) => k !== 'index')
          .sort(),
      ),
    );
    for (const method of new Set(used)) {
      expect(es, `route calls indices.${method}() but the mock does not stub it`).toHaveProperty(
        method,
      );
    }
  });
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

  it('rebuilds communications from the customer_communications source table', async () => {
    const sentAt = new Date('2026-07-01T00:00:00.000Z');
    vi.mocked(executeCql).mockResolvedValueOnce([
      {
        order_id: { toString: () => '7c9e6679-7425-40de-944b-e07fc1f90ae7' },
        sent_at: sentAt,
        seq: 4,
        correlation_id: 'corr-1',
        channel: 'email',
        comm_type: 'shipped',
        recipient: 'jane@example.com',
        subject: 'Your order #CONF-1 has shipped',
        body: 'On its way',
        actor: 'sendShippedEmail',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    const res = await POST(request({ index: 'communications' }));

    expect(res.status).toBe(200);
    expect(es.create).toHaveBeenCalledWith(
      expect.objectContaining({ index: 'communications', mappings: INDEX_MAPPINGS.communications }),
    );
    // Deterministic composite id (orderId:sentAtMs:seq) matches the live write-through.
    expect(es.index).toHaveBeenCalledWith({
      index: 'communications',
      id: `7c9e6679-7425-40de-944b-e07fc1f90ae7:${sentAt.getTime()}:4`,
      document: expect.objectContaining({
        orderId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        correlationId: 'corr-1',
        commType: 'shipped',
        recipient: 'jane@example.com',
        sentAt: sentAt.toISOString(),
      }),
    });

    const { results } = (await res.json()) as {
      results: Record<string, { indexed: number; errors: string[] }>;
    };
    expect(results.communications).toEqual({ indexed: 1, errors: [] });
  });
});
