/**
 * Unit tests for the transition-recorder Cassandra repository (ADR-0010): batch shape and
 * idempotent param mapping on the write side, row → timeline decoding on the read side.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TransitionPersistRecord } from '../framework';

const executeBatch = vi.hoisted(() => vi.fn());
const executeCql = vi.hoisted(() => vi.fn());

vi.mock('../../lib/cassandra-client', () => ({ executeBatch, executeCql }));

import { persistWorkflowTransitions, getWorkflowTransitions } from './repository';

const RECORD: TransitionPersistRecord = {
  tenantId: 'demo',
  workflowId: 'demo.cart.c-1',
  at: '2026-07-24T12:00:00.000Z',
  runId: 'run-1',
  seq: 3,
  workflowType: 'cartWorkflow',
  fromState: 'active',
  toState: 'checkout',
  triggerKind: 'update',
  triggerName: 'startCheckout',
  triggerPayload: '{"type":"startCheckout"}',
  contextSnapshot: '{"count":1}',
  tags: { Domain: 'cart', CorrelationId: 'corr-1', OrderId: 'o-1' },
};

beforeEach(() => {
  executeBatch.mockReset().mockResolvedValue(undefined);
  executeCql.mockReset().mockResolvedValue([]);
});

describe('persistWorkflowTransitions', () => {
  it('no-ops on an empty or missing batch', async () => {
    await persistWorkflowTransitions([]);
    await persistWorkflowTransitions(undefined as unknown as TransitionPersistRecord[]);
    expect(executeBatch).not.toHaveBeenCalled();
  });

  it('writes one unlogged-batch insert per record with positional params', async () => {
    await persistWorkflowTransitions([RECORD, { ...RECORD, seq: 4 }]);

    expect(executeBatch).toHaveBeenCalledTimes(1);
    const [queries, options] = executeBatch.mock.calls[0];
    expect(options).toEqual({ logged: false });
    expect(queries).toHaveLength(2);
    expect(queries[0].query).toContain('INSERT INTO workflow_state_transitions');
    expect(queries[0].params).toEqual([
      'demo',
      'demo.cart.c-1',
      new Date('2026-07-24T12:00:00.000Z'),
      'run-1',
      3,
      'cartWorkflow',
      'cart',
      'corr-1',
      'o-1',
      'active',
      'checkout',
      'update',
      'startCheckout',
      '{"type":"startCheckout"}',
      '{"count":1}',
      null,
      null,
      null,
    ]);
    expect(queries[1].params[4]).toBe(4);
  });

  it('nulls out absent tags and optional fields (idempotent re-writes stay stable)', async () => {
    await persistWorkflowTransitions([
      { ...RECORD, tags: undefined, triggerName: undefined, contextSnapshot: undefined },
    ]);
    const params = executeBatch.mock.calls[0][0][0].params;
    expect(params[6]).toBeNull(); // domain
    expect(params[7]).toBeNull(); // correlation_id
    expect(params[8]).toBeNull(); // order_id
    expect(params[12]).toBeNull(); // trigger_name
    expect(params[14]).toBeNull(); // context_snapshot
  });
});

describe('getWorkflowTransitions', () => {
  const ROW = {
    workflow_id: 'demo.cart.c-1',
    at: new Date('2026-07-24T12:00:00.000Z'),
    run_id: 'run-1',
    seq: 0,
    workflow_type: 'cartWorkflow',
    domain: 'cart',
    correlation_id: 'corr-1',
    order_id: null,
    from_state: '',
    to_state: 'active',
    trigger_kind: 'start',
    trigger_name: null,
    trigger_payload: '{"a":1}',
    context_snapshot: 'not json',
    prepare_activities: '[{"name":"reserve"},"junk",null]',
    finalize_activities: null,
    update_result: null,
  };

  it('scopes the query by the full (store_id, workflow_id) partition key', async () => {
    await getWorkflowTransitions('demo', 'demo.cart.c-1');
    const [cql, params] = executeCql.mock.calls[0];
    expect(cql).toContain('WHERE store_id = ? AND workflow_id = ?');
    expect(params).toEqual(['demo', 'demo.cart.c-1']);
  });

  it('decodes JSON payloads, falls back to raw strings, and filters activity junk', async () => {
    executeCql.mockResolvedValue([ROW]);
    const [t] = await getWorkflowTransitions('demo', 'demo.cart.c-1');

    expect(t).toMatchObject({
      workflowId: 'demo.cart.c-1',
      at: '2026-07-24T12:00:00.000Z',
      fromState: '',
      toState: 'active',
      triggerKind: 'start',
      domain: 'cart',
      correlationId: 'corr-1',
      orderId: null,
    });
    expect(t.triggerPayload).toEqual({ a: 1 });
    // Malformed JSON is preserved as the raw string rather than dropped.
    expect(t.contextSnapshot).toBe('not json');
    // Non-object entries in activity arrays are filtered out.
    expect(t.prepareActivities).toEqual([{ name: 'reserve' }]);
    expect(t.finalizeActivities).toEqual([]);
    expect(t.updateResult).toBeUndefined();
  });

  it('renders a missing timestamp as an empty string', async () => {
    executeCql.mockResolvedValue([{ ...ROW, at: null }]);
    const [t] = await getWorkflowTransitions('demo', 'demo.cart.c-1');
    expect(t.at).toBe('');
  });
});
