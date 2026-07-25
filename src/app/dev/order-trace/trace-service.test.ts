/**
 * Unit tests for the order-trace assembly service: lookup resolution against ES,
 * cross-domain node assembly (visibility query + deterministic safety net, de-duplicated),
 * journey ordering, correlation fallback for legacy orders, and the merged
 * dual-partition inventory journal.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  esSearch: vi.fn(),
  executeCql: vi.fn(),
  getWorkflowTransitions: vi.fn(),
  getHistoryByCorrelation: vi.fn(),
  workflowList: vi.fn(),
  getHandle: vi.fn(),
}));

vi.mock('@/lib/es-client', () => ({
  getElasticsearchClient: () => ({ search: mocks.esSearch }),
  isIndexNotFoundError: () => false,
}));
vi.mock('@/lib/cassandra-client', () => ({
  executeCql: mocks.executeCql,
  cassandraTypes: { Uuid: { fromString: (s: string) => ({ toString: () => s }) } },
}));
vi.mock('@/lib/temporal-client', () => ({
  TEMPORAL_NAMESPACE: 'default',
  getTemporalClient: async () => ({
    workflow: { list: mocks.workflowList, getHandle: mocks.getHandle },
  }),
}));
vi.mock('@/temporal/transition-recorder', () => ({
  getWorkflowTransitions: mocks.getWorkflowTransitions,
}));
vi.mock('@/temporal/inventory/db/inventory-command-repository', () => ({
  InventoryCommandRepository: { getHistoryByCorrelation: mocks.getHistoryByCorrelation },
}));

import { buildWorkflowId } from '@/temporal/contracts/constants';
import { resolveOrderId, buildOrderTrace } from './trace-service';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const CART_ID = 'cart-1';
const CORR_ID = 'corr-1';
const CART_WF = buildWorkflowId('demo', 'cart', CART_ID);
const ORDER_WF = buildWorkflowId('demo', 'order', ORDER_ID);
const FULFILLMENT_WF = buildWorkflowId('demo', 'fulfillment', ORDER_ID);

function esHits(sources: unknown[]) {
  return { hits: { hits: sources.map((s) => ({ _source: s })) } };
}

/** Async iterable of workflow executions, as client.workflow.list returns. */
function executions(ids: string[]) {
  return (async function* () {
    for (const workflowId of ids) yield { workflowId };
  })();
}

function defaultHandle(workflowId: string) {
  return {
    describe: async () => ({
      runId: `run-${workflowId}`,
      status: { name: 'COMPLETED' },
      startTime: new Date('2026-07-24T10:00:00Z'),
      closeTime: new Date('2026-07-24T11:00:00Z'),
      historyLength: 42,
    }),
    query: async () => ({ some: 'state' }),
  };
}

beforeEach(() => {
  mocks.esSearch.mockReset();
  mocks.executeCql.mockReset().mockImplementation(async (cql: string) => {
    if (cql.includes('FROM orders')) {
      return [{ cart_id: CART_ID, correlation_id: CORR_ID, confirmation_number: 'CONF123' }];
    }
    return []; // order_status_history
  });
  mocks.getWorkflowTransitions.mockReset().mockResolvedValue([]);
  mocks.getHistoryByCorrelation.mockReset().mockResolvedValue([]);
  mocks.workflowList.mockReset().mockReturnValue(executions([]));
  mocks.getHandle.mockReset().mockImplementation(defaultHandle);
});

describe('resolveOrderId', () => {
  it('resolves an exact orderId term match', async () => {
    mocks.esSearch.mockResolvedValue(esHits([{ orderId: ORDER_ID }]));
    const result = await resolveOrderId({ orderId: ` ${ORDER_ID} ` });

    expect(result.orderId).toBe(ORDER_ID);
    expect(mocks.esSearch.mock.calls[0][0].query).toEqual({
      term: { orderId: ORDER_ID },
    });
  });

  it('returns empty when nothing matches', async () => {
    mocks.esSearch.mockResolvedValue(esHits([]));
    expect(await resolveOrderId({ orderId: ORDER_ID })).toEqual({});
  });

  it('resolves by confirmation number', async () => {
    mocks.esSearch.mockResolvedValue(esHits([{ orderId: ORDER_ID }]));
    const result = await resolveOrderId({ confirmation: 'CONF123' });
    expect(result.orderId).toBe(ORDER_ID);
    expect(mocks.esSearch.mock.calls[0][0].query).toEqual({
      term: { confirmationNumber: 'CONF123' },
    });
  });

  it('returns candidates for an email matching multiple orders', async () => {
    const mk = (id: string) => ({
      orderId: id,
      confirmationNumber: `C-${id}`,
      total: 100,
      currency: 'USD',
      status: 'complete',
      createdAt: '2026-07-24T00:00:00Z',
    });
    mocks.esSearch.mockResolvedValue(esHits([mk('a'), mk('b')]));

    const result = await resolveOrderId({ email: 'x@y.z' });
    expect(result.orderId).toBeUndefined();
    expect(result.candidates?.map((c) => c.orderId)).toEqual(['a', 'b']);
  });

  it('resolves directly when an email matches exactly one order', async () => {
    mocks.esSearch.mockResolvedValue(
      esHits([
        {
          orderId: ORDER_ID,
          confirmationNumber: 'C-1',
          total: 100,
          currency: 'USD',
          status: 'complete',
          createdAt: '2026-07-24T00:00:00Z',
        },
      ]),
    );
    expect((await resolveOrderId({ email: 'x@y.z' })).orderId).toBe(ORDER_ID);
  });
});

describe('buildOrderTrace', () => {
  it('assembles nodes from the visibility query, de-duplicates the safety net, and sorts by journey order', async () => {
    // Visibility returns the whole journey (unordered) including the OMS workflow the
    // safety net will probe again, plus a non-journey workflow to be skipped.
    mocks.workflowList.mockReturnValue(
      executions([FULFILLMENT_WF, ORDER_WF, CART_WF, 'demo.inventory.service']),
    );

    const trace = await buildOrderTrace('demo', ORDER_ID);

    expect(trace).toMatchObject({
      orderId: ORDER_ID,
      cartId: CART_ID,
      correlationId: CORR_ID,
      confirmationNumber: 'CONF123',
    });
    // cart → oms → fulfillment (journey order), one node each despite safety-net re-probes.
    expect(trace.nodes.map((n) => n.domain)).toEqual(['cart', 'oms', 'fulfillment']);
    expect(trace.nodes.map((n) => n.workflowId)).toEqual([CART_WF, ORDER_WF, FULFILLMENT_WF]);
    // The visibility query used the journey correlationId.
    expect(mocks.workflowList.mock.calls[0][0].query).toContain(`'${CORR_ID}'`);
  });

  it('omits nodes whose workflows do not exist and still renders closed workflows without state', async () => {
    mocks.workflowList.mockReturnValue(executions([]));
    mocks.getHandle.mockImplementation((workflowId: string) => {
      if (workflowId.includes('.fulfillment.')) {
        return { describe: async () => Promise.reject(new Error('not found')) };
      }
      return {
        ...defaultHandle(workflowId),
        query: async () => Promise.reject(new Error('workflow closed')),
      };
    });

    const trace = await buildOrderTrace('demo', ORDER_ID);

    // fulfillment missing → skipped; order + cart render with null state.
    expect(trace.nodes.map((n) => n.domain)).toEqual(['cart', 'oms']);
    expect(trace.nodes[0].state).toBeNull();
    expect(trace.nodes[0].status).toBe('COMPLETED');
  });

  it('falls back to cartId as correlationId for legacy orders', async () => {
    mocks.executeCql.mockImplementation(async (cql: string) =>
      cql.includes('FROM orders')
        ? [{ cart_id: CART_ID, correlation_id: null, confirmation_number: 'CONF123' }]
        : [],
    );

    const trace = await buildOrderTrace('demo', ORDER_ID);
    expect(trace.correlationId).toBe(CART_ID);
  });

  it('merges the inventory journal from both correlation partitions in time order', async () => {
    const row = (at: string, seq: number, actor: string) => ({
      at: new Date(at),
      seq,
      operation: 'RELEASE',
      reservationId: 'r-1',
      blankSku: 'sku-1',
      variantId: 'v-1',
      fulfillerId: null,
      quantity: 1,
      priorStatus: 'TEMPORARY',
      newStatus: 'RELEASED',
      referenceId: 'ref',
      actor,
      details: null,
    });
    mocks.getHistoryByCorrelation.mockImplementation(async (key: string) =>
      key === CORR_ID
        ? [row('2026-07-24T10:05:00Z', 1, 'checkout')]
        : [row('2026-07-24T10:01:00Z', 0, 'expiry-sweep')],
    );

    const trace = await buildOrderTrace('demo', ORDER_ID);

    // Both partitions queried: the journey UUID and the cartId (system actors journal there).
    expect(mocks.getHistoryByCorrelation.mock.calls.map((c) => c[0]).sort()).toEqual(
      [CART_ID, CORR_ID].sort(),
    );
    expect(trace.inventory.history.map((h) => h.actor)).toEqual(['expiry-sweep', 'checkout']);
  });

  it('degrades gracefully when visibility, Cassandra, and the journal all fail', async () => {
    mocks.executeCql.mockRejectedValue(new Error('cassandra down'));
    mocks.workflowList.mockImplementation(() => {
      throw new Error('visibility unavailable');
    });
    mocks.getHandle.mockImplementation(() => ({
      describe: async () => Promise.reject(new Error('not found')),
    }));

    const trace = await buildOrderTrace('demo', ORDER_ID);

    expect(trace.nodes).toEqual([]);
    expect(trace.statusHistory).toEqual([]);
    expect(trace.inventory.history).toEqual([]);
    expect(trace.correlationId).toBeUndefined();
  });
});
