import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests for the AsyncTransitionRecorder (ADR-0010). The Temporal workflow runtime is
 * mocked so the recorder runs in-process: `condition` polls across microtasks, `proxyActivities`
 * captures the persisted batches, and `workflowInfo` is swappable per test.
 */
let persisted: Array<Record<string, unknown>> = [];
let info: {
  workflowId: string;
  runId: string;
  workflowType: string;
  searchAttributes: Record<string, string[]>;
};

vi.mock('@temporalio/workflow', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  condition: async (pred: () => boolean) => {
    for (let i = 0; i < 100_000; i++) {
      if (pred()) return true;
      await Promise.resolve();
    }
    throw new Error('test condition never satisfied');
  },
  proxyActivities: () => ({
    persistWorkflowTransitions: async (records: Array<Record<string, unknown>>) => {
      persisted.push(...records);
    },
  }),
  workflowInfo: () => info,
}));

import { createTransitionRecorder } from './transition-sink';
import type { TransitionSink } from './types';

const TAGGED = {
  workflowId: 'store-1.oms.order-1',
  runId: 'run-1',
  workflowType: 'orderWorkflow',
  searchAttributes: {
    StoreId: ['store-1'],
    CorrelationId: ['cart-9'],
    Domain: ['oms'],
    OrderId: ['order-1'],
  },
};

beforeEach(() => {
  persisted = [];
  info = JSON.parse(JSON.stringify(TAGGED));
});

async function drain<T>(rec: TransitionSink<T>): Promise<void> {
  const flusher = rec.runFlusher();
  rec.close();
  await rec.drain();
  await flusher;
}

describe('createTransitionRecorder', () => {
  it('returns undefined when disabled', () => {
    expect(createTransitionRecorder({ enabled: false })).toBeUndefined();
  });

  it('returns undefined for an untagged, unparseable workflow', () => {
    info = { workflowId: 'singleton', runId: 'r', workflowType: 'x', searchAttributes: {} };
    expect(createTransitionRecorder()).toBeUndefined();
  });

  it('falls back to a parseable workflow id when Search Attributes are absent', async () => {
    info = {
      workflowId: 'store-7.cart.cart-2',
      runId: 'r',
      workflowType: 'cartWorkflow',
      searchAttributes: {},
    };
    const rec = createTransitionRecorder<{ n: number }>()!;
    rec.record({ from: '', to: 'active', trigger: { kind: 'start' }, context: { n: 1 }, at: 'T' });
    await drain(rec);
    expect(persisted[0]).toMatchObject({ tenantId: 'store-7', tags: { Domain: 'cart' } });
  });

  it('resolves tenant/correlation from Search Attributes and applies serialize + redact hooks', async () => {
    const rec = createTransitionRecorder<{ secret: string; keep: number }>({
      serialize: (ctx) => ({ keep: ctx.keep }),
      redactPayload: () => ({ redacted: true }),
    })!;
    rec.record({
      from: 'a',
      to: 'b',
      trigger: { kind: 'update', name: 'setPayment' },
      triggerPayload: { token: 'secret-token' },
      context: { secret: 'nope', keep: 42 },
      at: '2026-06-21T00:00:00.000Z',
    });
    await drain(rec);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      tenantId: 'store-1',
      tags: { CorrelationId: 'cart-9', OrderId: 'order-1', Domain: 'oms' },
      fromState: 'a',
      toState: 'b',
      triggerKind: 'update',
      triggerName: 'setPayment',
    });
    expect(JSON.parse(persisted[0].contextSnapshot as string)).toEqual({ keep: 42 });
    expect(JSON.parse(persisted[0].triggerPayload as string)).toEqual({ redacted: true });
  });

  it('caps oversized snapshots with a truncation marker', async () => {
    const rec = createTransitionRecorder<{ big: string }>()!;
    rec.record({
      from: '',
      to: 's',
      trigger: { kind: 'start' },
      context: { big: 'x'.repeat(300_000) },
      at: 'T',
    });
    await drain(rec);
    expect(JSON.parse(persisted[0].contextSnapshot as string)).toMatchObject({ __truncated: true });
  });

  it('assigns a per-run monotonic seq', async () => {
    const rec = createTransitionRecorder<{ n: number }>()!;
    for (let i = 0; i < 3; i++) {
      rec.record({ from: 's', to: 's', trigger: { kind: 'timeout' }, context: { n: i }, at: 'T' });
    }
    await drain(rec);
    expect(persisted.map((r) => r.seq)).toEqual([0, 1, 2]);
  });
});
