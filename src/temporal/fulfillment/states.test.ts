import { describe, it, expect, vi } from 'vitest';

// ── Mock the workflow sandbox — the parent fulfillment machine is pure (no activities);
// the stub is only for the framework modules that load with '../framework'. The decider
// units are covered in fulfillment-decider.test.ts; these assert the states wiring:
// command → terminal routing from the decided aggregate outcome.
vi.mock('@temporalio/workflow', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  defineSignal: vi.fn((name: string) => ({ type: 'signal', name })),
  defineQuery: vi.fn((name: string) => ({ type: 'query', name })),
  getExternalWorkflowHandle: vi.fn(() => ({ signal: vi.fn(), cancel: vi.fn() })),
  proxyActivities: vi.fn(() => ({ persistWorkflowTransitions: vi.fn(async () => undefined) })),
  workflowInfo: vi.fn(() => ({
    workflowId: 'demo.fulfillment.o-1',
    runId: 'run-1',
    searchAttributes: {},
    workflowType: 'fulfillmentWorkflow',
  })),
  condition: vi.fn(async () => true),
  uuid4: () => 'uuid-fixed',
}));

import { FULFILLMENT_STATES } from './states';
import { terminal } from '../framework';
import type {
  FulfillmentWorkflowState,
  FulfillmentFulfillerOrderState,
  FulfillmentCommand,
} from './types';

// ── Builders ────────────────────────────────────────────────────────────────
function makeSO(
  id: string,
  status: FulfillmentFulfillerOrderState['status'] = 'in_production',
): FulfillmentFulfillerOrderState {
  return {
    fulfillerOrderId: id,
    fulfillerId: 'simulated',
    fulfillerType: 'simulated',
    items: [{ sku: 'SKU-1', productId: 'p1', variantId: 'v1', quantity: 1, status: 'pending' }],
    status,
  };
}

function makeCtx(fulfillerOrders: FulfillmentFulfillerOrderState[]): FulfillmentWorkflowState {
  return {
    orderId: 'o-1',
    cartId: 'cart-1',
    customerId: 'a@b.c',
    status: 'in_production',
    fulfillerOrders,
    createdAt: 't0',
    updatedAt: 't0',
  };
}

// Signals arrive at the state fn already mapped to commands (toSignal in workflows.ts).
const sig = (result: FulfillmentCommand) => ({ kind: 'signal' as const, result, timestamp: 't' });
const timeout = { kind: 'timeout' as const, timestamp: 't' };

describe('received (transitional)', () => {
  it('hops straight to in_production (onStart already spawned the children)', async () => {
    const ctx = { ...makeCtx([makeSO('so-1')]), status: 'received' as const };
    const out = await FULFILLMENT_STATES.received.fn(ctx, timeout);
    expect(out.next).toBe('in_production');
    expect(out.context.status).toBe('in_production');
  });
});

describe('in_production — signal-driven aggregation', () => {
  it('cancel cascades cancelled to every fulfiller order and terminates', async () => {
    const out = await FULFILLMENT_STATES.in_production.fn(
      makeCtx([makeSO('so-1'), makeSO('so-2')]),
      sig({ type: 'cancel' }),
    );
    expect(out.next).toBe(terminal('cancelled'));
    expect(out.context.status).toBe('cancelled');
    for (const so of out.context.fulfillerOrders) {
      expect(so.status).toBe('cancelled');
      expect(so.items.every((i) => i.status === 'cancelled')).toBe(true);
    }
  });

  it('a childStatus that leaves siblings in flight stays in_production (partially_shipped)', async () => {
    const out = await FULFILLMENT_STATES.in_production.fn(
      makeCtx([makeSO('so-1'), makeSO('so-2')]),
      sig({ type: 'childStatus', update: makeSO('so-1', 'shipped') }),
    );
    expect(out.next).toBe('in_production');
    expect(out.context.status).toBe('partially_shipped');
    expect(out.context.fulfillerOrders[0].status).toBe('shipped');
    expect(out.context.updatedAt).toBe('t');
  });

  it('the last child delivering terminates the parent as delivered', async () => {
    const out = await FULFILLMENT_STATES.in_production.fn(
      makeCtx([makeSO('so-1', 'delivered'), makeSO('so-2', 'shipped')]),
      sig({ type: 'childStatus', update: makeSO('so-2', 'delivered') }),
    );
    expect(out.next).toBe(terminal('delivered'));
    expect(out.context.status).toBe('delivered');
  });

  it('all children failed/cancelled terminates the parent as failed', async () => {
    const out = await FULFILLMENT_STATES.in_production.fn(
      makeCtx([makeSO('so-1', 'cancelled'), makeSO('so-2', 'in_production')]),
      sig({ type: 'childStatus', update: makeSO('so-2', 'failed') }),
    );
    expect(out.next).toBe(terminal('failed'));
    expect(out.context.status).toBe('failed');
  });

  it('a command with no entry (fulfillerStatus belongs to the child) is REJECTED in place', async () => {
    const ctx = makeCtx([makeSO('so-1')]);
    const out = await FULFILLMENT_STATES.in_production.fn(
      ctx,
      sig({ type: 'fulfillerStatus' } as never),
    );
    expect(out.next).toBe('in_production');
    expect(out.rejected).toBe(true);
    expect(out.error).toMatch(/does not accept command 'fulfillerStatus'/);
    expect(out.context).toEqual(ctx);
  });

  it('timeout stays put — the parent waits on its children indefinitely', async () => {
    const ctx = makeCtx([makeSO('so-1')]);
    const out = await FULFILLMENT_STATES.in_production.fn(ctx, timeout);
    expect(out.next).toBe('in_production');
    expect(out.context).toEqual(ctx);
  });
});
