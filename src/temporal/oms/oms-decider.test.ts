import { describe, it, expect } from 'vitest';
import { decide, evolve, aggregateShippingState, copyOrderState } from './oms-decider';
import type { OrderCommand } from './oms-decider';
import type { OrderState, FulfillerOrder, FulfillmentStatusUpdate } from './types';

function makeFulfillerOrder(overrides: Partial<FulfillerOrder> = {}): FulfillerOrder {
  return {
    fulfillerOrderId: 'so-1',
    orderId: 'o-1',
    fulfillerId: 'simulated',
    fulfillerName: 'Simulated',
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
    order: {
      orderId: 'o-1',
      cartId: 'c-1',
      customerEmail: 'a@b.c',
      items: [
        { lineItemId: 'li-1', variantId: 'v1', quantity: 2, price: 10 },
        { lineItemId: 'li-2', variantId: 'v2', quantity: 1, price: 5 },
      ],
      subtotal: 25,
      tax: 2.5,
    } as OrderState['order'],
    status: 'processing',
    statusHistory: [{ status: 'pending_assignment', timestamp: 't0', updatedBy: 'system' }],
    assignments: [
      {
        assignmentId: 'asg-1',
        lineItemId: 'li-1',
        variantId: 'v1',
        fulfillerId: 'simulated',
        quantity: 2,
        status: 'fulfilled',
        fulfillerOrderId: 'so-1',
      },
    ],
    fulfillerOrders: [makeFulfillerOrder()],
    ...overrides,
  };
}

const apply = (state: OrderState, cmd: OrderCommand): OrderState =>
  decide(cmd, state).reduce(evolve, state);

const fulfillmentUpdate = (over: Partial<FulfillmentStatusUpdate> = {}): FulfillmentStatusUpdate => ({
  fulfillerOrderId: 'so-1',
  status: 'shipped',
  carrier: 'UPS',
  trackingNumber: '1Z999',
  ...over,
});

describe('aggregateShippingState', () => {
  const so = (status: FulfillerOrder['status']) => makeFulfillerOrder({ status });

  it('aggregates across fulfiller orders (rejected counts as done)', () => {
    expect(aggregateShippingState([so('delivered'), so('delivered')])).toBe('delivered');
    expect(aggregateShippingState([so('delivered'), so('rejected')])).toBe('delivered');
    expect(aggregateShippingState([so('shipped'), so('delivered')])).toBe('shipped');
    expect(aggregateShippingState([so('shipped'), so('processing')])).toBe('partially_shipped');
    expect(aggregateShippingState([so('processing')])).toBe('processing');
  });
});

describe('lifecycle commands', () => {
  it('cancelOrder / updateStatus / submitFeedback fold statuses', () => {
    expect(apply(makeState(), { type: 'cancelOrder' }).status).toBe('cancelled');
    expect(apply(makeState(), { type: 'updateStatus', status: 'shipped' }).status).toBe('shipped');
    const fed = apply(makeState({ status: 'delivered' }), {
      type: 'submitFeedback',
      rating: 5,
      comment: 'great',
      at: 't1',
    });
    expect(fed.status).toBe('complete');
    expect(fed.customerFeedback).toMatchObject({ rating: 5, submittedAt: 't1' });
  });

  it('does not mutate the input state (copyOrderState fold)', () => {
    const state = makeState();
    apply(state, { type: 'cancelOrder' });
    expect(state.status).toBe('processing');
    const copy = copyOrderState(state);
    copy.fulfillerOrders[0].status = 'delivered';
    expect(state.fulfillerOrders[0].status).toBe('processing');
  });
});

describe('fulfillmentStatus aggregation', () => {
  it('mirrors the fulfiller order + assignments and stamps deliveredAt on full delivery', () => {
    const shipped = apply(makeState(), {
      type: 'fulfillmentStatus',
      update: fulfillmentUpdate(),
      at: 't1',
    });
    expect(shipped.fulfillerOrders[0].status).toBe('shipped');
    expect(shipped.fulfillerOrders[0].carrier).toBe('UPS');
    expect(shipped.assignments[0].status).toBe('shipped');
    expect(shipped.status).toBe('shipped'); // single fulfiller order → aggregate shipped

    const delivered = apply(shipped, {
      type: 'fulfillmentStatus',
      update: fulfillmentUpdate({ status: 'delivered' }),
      at: 't2',
    });
    expect(delivered.status).toBe('delivered');
    expect(delivered.deliveredAt).toBe('t2');
  });

  it('collapses duplicate consecutive statuses into one history entry', () => {
    const once = apply(makeState(), { type: 'fulfillmentStatus', update: fulfillmentUpdate(), at: 't1' });
    const twice = apply(once, { type: 'fulfillmentStatus', update: fulfillmentUpdate(), at: 't2' });
    const shippedEntries = twice.fulfillerOrders[0].statusHistory.filter((h) => h.status === 'shipped');
    expect(shippedEntries).toHaveLength(1);
    expect(shippedEntries[0].timestamp).toBe('t2');
  });

  it('an unknown fulfiller order emits no facts', () => {
    expect(
      decide(
        { type: 'fulfillmentStatus', update: fulfillmentUpdate({ fulfillerOrderId: 'nope' }), at: 't1' },
        makeState(),
      ),
    ).toEqual([]);
  });
});

describe('refunds', () => {
  it('partial refund records the line + pro-rated tax without changing status', () => {
    const state = apply(makeState({ status: 'delivered' }), {
      type: 'refundOrder',
      lines: [{ lineItemId: 'li-1', quantity: 1 }],
      reason: 'damaged',
      at: 't1',
    });
    expect(state.status).toBe('delivered');
    expect(state.refunds).toHaveLength(1);
    expect(state.refunds![0].refundAmount).toBe(10);
    expect(state.refunds![0].taxAmount).toBe(1); // 2.5 * (10/25)
  });

  it('full refund (omitted lines) marks the order refunded', () => {
    const state = apply(makeState({ status: 'delivered' }), {
      type: 'refundOrder',
      lines: undefined,
      reason: 'full',
      at: 't1',
    });
    expect(state.status).toBe('refunded');
    expect(state.refunds![0].refundAmount).toBe(25);
  });

  it('cumulative partials flip to refunded when everything is covered', () => {
    const first = apply(makeState({ status: 'delivered' }), {
      type: 'refundOrder',
      lines: [{ lineItemId: 'li-1', quantity: 2 }],
      at: 't1',
    });
    expect(first.status).toBe('delivered');
    const second = apply(first, {
      type: 'refundOrder',
      lines: [{ lineItemId: 'li-2', quantity: 1 }],
      at: 't2',
    });
    expect(second.status).toBe('refunded');
    expect(second.refunds).toHaveLength(2);
  });

  it('over-refund and unknown-line selections throw (update rejection)', () => {
    expect(() =>
      decide(
        { type: 'refundOrder', lines: [{ lineItemId: 'li-1', quantity: 3 }], at: 't1' },
        makeState(),
      ),
    ).toThrow(/exceeds remaining/);
    expect(() =>
      decide(
        { type: 'refundOrder', lines: [{ lineItemId: 'nope', quantity: 1 }], at: 't1' },
        makeState(),
      ),
    ).toThrow(/Unknown line item/);
  });
});

describe('returns', () => {
  it('requestReturn records the pending request; denyReturn clears it', () => {
    const requested = apply(makeState({ status: 'delivered' }), {
      type: 'requestReturn',
      lines: [{ lineItemId: 'li-1', quantity: 1 }],
      reason: 'wrong size',
      updatedBy: 'customer',
      at: 't1',
    });
    expect(requested.returnRequest).toMatchObject({ reason: 'wrong size', requestedAt: 't1' });

    const denied = apply(requested, { type: 'denyReturn' });
    expect(denied.returnRequest).toBeUndefined();
    expect(denied.status).toBe('delivered');
  });

  it('confirmReturn refunds the requested lines and marks the order returned', () => {
    const requested = apply(makeState({ status: 'delivered' }), {
      type: 'requestReturn',
      lines: [{ lineItemId: 'li-1', quantity: 2 }],
      reason: 'wrong size',
      at: 't1',
    });
    const returned = apply(requested, { type: 'confirmReturn', at: 't2' });
    expect(returned.status).toBe('returned');
    expect(returned.returnRequest).toBeUndefined();
    expect(returned.refunds![0].refundAmount).toBe(20);
    expect(returned.refunds![0].reason).toBe('wrong size'); // falls back to the request reason
  });
});
