import { describe, it, expect } from 'vitest';
import { decide, evolve, aggregateStatus } from './fulfillment-decider';
import type { FulfillmentCommand } from './fulfillment-decider';
import type { FulfillmentWorkflowState, FulfillmentFulfillerOrderState } from './types';

function makeFulfillerOrder(
  overrides: Partial<FulfillmentFulfillerOrderState> = {},
): FulfillmentFulfillerOrderState {
  return {
    fulfillerOrderId: 'so-1',
    fulfillerId: 'simulated',
    fulfillerType: 'simulated',
    status: 'in_production',
    items: [
      {
        sku: 'SKU-1',
        productId: 'p1',
        variantId: 'v1',
        quantity: 1,
        unitPrice: 10,
        title: 'T',
        status: 'in_production',
      },
    ],
    statusHistory: [],
    ...overrides,
  } as FulfillmentFulfillerOrderState;
}

function makeState(overrides: Partial<FulfillmentWorkflowState> = {}): FulfillmentWorkflowState {
  return {
    orderId: 'o-1',
    cartId: 'c-1',
    customerId: 'cust-1',
    status: 'in_production',
    fulfillerOrders: [makeFulfillerOrder()],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as FulfillmentWorkflowState;
}

const apply = (state: FulfillmentWorkflowState, cmd: FulfillmentCommand) =>
  decide(cmd, state).reduce(evolve, state);

describe('aggregateStatus', () => {
  const so = (status: FulfillmentFulfillerOrderState['status']) => makeFulfillerOrder({ status });

  it('aggregates across fulfiller orders', () => {
    expect(
      aggregateStatus(makeState({ fulfillerOrders: [so('delivered'), so('delivered')] })),
    ).toBe('delivered');
    expect(aggregateStatus(makeState({ fulfillerOrders: [so('cancelled'), so('failed')] }))).toBe(
      'failed',
    );
    expect(aggregateStatus(makeState({ fulfillerOrders: [so('shipped'), so('delivered')] }))).toBe(
      'shipped',
    );
    expect(
      aggregateStatus(makeState({ fulfillerOrders: [so('shipped'), so('in_production')] })),
    ).toBe('partially_shipped');
    expect(aggregateStatus(makeState({ fulfillerOrders: [so('in_production')] }))).toBe(
      'in_production',
    );
  });
});

describe('fulfillment decide/evolve', () => {
  it('cancel cascades to every fulfiller order and line item', () => {
    const state = apply(makeState(), { type: 'cancel', at: '2026-02-01T00:00:00Z' });
    expect(state.status).toBe('cancelled');
    expect(state.updatedAt).toBe('2026-02-01T00:00:00Z');
    expect(state.fulfillerOrders[0].status).toBe('cancelled');
    expect(state.fulfillerOrders[0].items[0].status).toBe('cancelled');
  });

  it('childStatus replaces the matching fulfiller order and re-aggregates', () => {
    const update = makeFulfillerOrder({ status: 'delivered' });
    const state = apply(makeState(), {
      type: 'childStatus',
      update,
      at: '2026-02-01T00:00:00Z',
    });
    expect(state.fulfillerOrders[0].status).toBe('delivered');
    expect(state.status).toBe('delivered');
  });

  it('does not mutate the input state', () => {
    const state = makeState();
    apply(state, { type: 'cancel', at: 't' });
    expect(state.status).toBe('in_production');
    expect(state.fulfillerOrders[0].status).toBe('in_production');
  });
});
