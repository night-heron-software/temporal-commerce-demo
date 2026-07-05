/**
 * Tests for GET /api/health — service checks are mocked at the client-module boundary
 * (Cassandra and Temporal via vi.mock, Elasticsearch via a stubbed global fetch since the
 * route probes `/_cluster/health` directly).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cassandra = vi.hoisted(() => ({
  execute: vi.fn(),
}));
const temporal = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock('@/lib/cassandra-client', () => ({
  getCassandraClient: () => ({ execute: cassandra.execute }),
}));
vi.mock('@/lib/temporal-client', () => ({
  getTemporalClient: async () => ({ workflow: { list: temporal.list } }),
}));

import { GET } from './route';

function esUp() {
  return {
    ok: true,
    json: async () => ({ status: 'green', number_of_nodes: 1, active_shards: 5 }),
  } as Response;
}

/** Async iterable of one running workflow, as `client.workflow.list` returns. */
function workflowList() {
  return (async function* () {
    yield { workflowId: 'wf-1' };
  })();
}

describe('GET /api/health', () => {
  beforeEach(() => {
    cassandra.execute.mockResolvedValue({ rowLength: 3 });
    temporal.list.mockImplementation(() => workflowList());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => esUp()),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('reports healthy with latencies and details when all services are up', async () => {
    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body.services.app).toEqual({ status: 'up' });
    expect(body.services.cassandra.status).toBe('up');
    expect(body.services.cassandra.latencyMs).toBeTypeOf('number');
    expect(body.services.cassandra.details).toMatchObject({
      keyspaceVerified: true,
      tableCount: 3,
    });
    expect(body.services.temporal.status).toBe('up');
    expect(body.services.elasticsearch.status).toBe('up');
    expect(body.services.elasticsearch.details).toMatchObject({
      clusterStatus: 'green',
      numberOfNodes: 1,
      activeShards: 5,
    });
  });

  it('reports degraded when Cassandra is down but the rest are up', async () => {
    cassandra.execute.mockRejectedValue(new Error('no host available'));

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.services.cassandra).toMatchObject({ status: 'down', error: 'no host available' });
    expect(body.services.temporal.status).toBe('up');
  });

  it('reports degraded with an HTTP error when Elasticsearch responds non-OK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 }) as Response),
    );

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.services.elasticsearch).toMatchObject({ status: 'down', error: 'HTTP 500' });
  });

  it('reports degraded when the Temporal list call throws', async () => {
    temporal.list.mockImplementation(() => {
      throw new Error('gRPC unavailable');
    });

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.services.temporal).toMatchObject({ status: 'down', error: 'gRPC unavailable' });
  });

  it('returns 503 unhealthy when every service is down', async () => {
    cassandra.execute.mockRejectedValue(new Error('cassandra down'));
    temporal.list.mockImplementation(() => {
      throw new Error('temporal down');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('es down');
      }),
    );

    const res = await GET();
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe('unhealthy');
    expect(body.services.cassandra.status).toBe('down');
    expect(body.services.temporal.status).toBe('down');
    expect(body.services.elasticsearch.status).toBe('down');
  });
});
