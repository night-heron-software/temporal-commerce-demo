import { describe, it, expect } from 'vitest';
import { decide, evolve } from './oms-decider';
import type { OmsCommand } from './oms-decider';
import type { OrderState, SupplierOrder, FulfillmentStatusUpdate } from './types';

function makeSupplierOrder(overrides: Partial<SupplierOrder> = {}): SupplierOrder {
  return {
    supplierOrderId: 'so-1',
    orderId: 'o-1',
    supplierId: 'simulated',
    supplierName: 'Simulated',
    status: 'processing',
    items: [{ assignmentId: 'asg-1', variantId: 'v1', quantity: 1 }],
    createdAt: 't0',
    updatedAt: 't0',
    statusHistory: [{ status: 'pending', timestamp: 't0' }],
    ...overrides,
  };
}

function makeState(overrides: Partial<OrderState> = {}): OrderState {
  return {
    order: { orderId: 'o-1', cartId: 'c-1' } as OrderState['order'],
    status: 'processing',
    statusHistory: [{ status: 'pending_assignment', timestamp: 't0', updatedBy: 'system' }],
    assignments: [
      {
        assignmentId: 'asg-1',
        lineItemId: 'li-1',
        variantId: 'v1',
        supplierId: 'simulated',
        quantity: 1,
        status: 'fulfilled',
        supplierOrderId: 'so-1',
      },
    ],
    supplierOrders: [makeSupplierOrder()],
    ...overrides,
  };
}

const apply = (state: OrderState, cmd: OmsCommand): OrderState =>
  decide(cmd, state).reduce(evolve, state);

const fulfillmentUpdate = (over: Partial<FulfillmentStatusUpdate> = {}): FulfillmentStatusUpdate => ({
  supplierOrderId: 'so-1',
  status: 'shipped',
  carrier: 'UPS',
  trackingNumber: '1Z999',
  ...over,
});

describe('oms decide/evolve — admin/customer commands', () => {
  it('statusUpdated appends a history entry and stamps deliveredAt on delivered', () => {
    const state = apply(makeState(), {
      type: 'statusUpdated',
      status: 'delivered',
      note: 'manual',
      updatedBy: 'admin',
      at: 't1',
    });
    expect(state.status).toBe('delivered');
    expect(state.deliveredAt).toBe('t1');
    expect(state.statusHistory.at(-1)).toMatchObject({ status: 'delivered', note: 'manual', updatedBy: 'admin' });
  });

  it('orderCancelled records an admin cancellation with the reason', () => {
    const state = apply(makeState(), { type: 'orderCancelled', reason: 'customer request', at: 't1' });
    expect(state.status).toBe('cancelled');
    expect(state.statusHistory.at(-1)).toMatchObject({ status: 'cancelled', note: 'customer request' });
  });

  it('feedbackSubmitted records feedback and completes the order', () => {
    const state = apply(makeState(), { type: 'feedbackSubmitted', rating: 5, comment: 'great', at: 't1' });
    expect(state.customerFeedback).toMatchObject({ rating: 5, comment: 'great', submittedAt: 't1' });
    expect(state.status).toBe('complete');
  });

  it('does not mutate the input state', () => {
    const state = makeState();
    apply(state, { type: 'orderCancelled', at: 't1' });
    expect(state.status).toBe('processing');
    expect(state.statusHistory).toHaveLength(1);
  });
});

describe('oms decide/evolve — fulfillment status aggregation', () => {
  it('mirrors the supplier order and its assignments', () => {
    const state = apply(makeState(), {
      type: 'fulfillmentStatusReported',
      update: fulfillmentUpdate(),
      at: 't1',
    });
    const so = state.supplierOrders[0];
    expect(so.status).toBe('shipped');
    expect(so.carrier).toBe('UPS');
    expect(so.trackingNumber).toBe('1Z999');
    expect(so.statusHistory.at(-1)?.status).toBe('shipped');
    expect(state.assignments[0].status).toBe('shipped');
    expect(state.assignments[0].carrier).toBe('UPS');
  });

  it('an unknown supplier order produces no facts', () => {
    expect(
      decide(
        { type: 'fulfillmentStatusReported', update: fulfillmentUpdate({ supplierOrderId: 'nope' }), at: 't1' },
        makeState(),
      ),
    ).toEqual([]);
  });

  it('all supplier orders shipped promotes the order to shipped', () => {
    const state = apply(makeState(), {
      type: 'fulfillmentStatusReported',
      update: fulfillmentUpdate({ status: 'shipped' }),
      at: 't1',
    });
    expect(state.status).toBe('shipped');
    expect(state.statusHistory.at(-1)).toMatchObject({ status: 'shipped', note: 'All supplier orders shipped' });
  });

  it('a shipped supplier order does NOT promote while another is still processing', () => {
    const state = apply(
      makeState({
        supplierOrders: [makeSupplierOrder(), makeSupplierOrder({ supplierOrderId: 'so-2', status: 'processing' })],
      }),
      { type: 'fulfillmentStatusReported', update: fulfillmentUpdate({ status: 'shipped' }), at: 't1' },
    );
    expect(state.status).toBe('processing');
  });

  it('all supplier orders delivered promotes the order to delivered', () => {
    const state = apply(
      makeState({ status: 'shipped', supplierOrders: [makeSupplierOrder({ status: 'shipped' })] }),
      { type: 'fulfillmentStatusReported', update: fulfillmentUpdate({ status: 'delivered' }), at: 't2' },
    );
    expect(state.status).toBe('delivered');
    expect(state.deliveredAt).toBe('t2');
    expect(state.supplierOrders[0].status).toBe('delivered');
    expect(state.assignments[0].status).toBe('delivered');
  });
});
