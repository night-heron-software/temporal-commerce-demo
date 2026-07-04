import { describe, it, expect } from 'vitest';
import { decide, evolve, aggregateStatus } from './fulfillment-decider';
import type { FulfillmentCommand } from './fulfillment-decider';
import type { FulfillmentWorkflowState, FulfillmentSupplierOrderState } from './types';

function makeSupplierOrder(
  overrides: Partial<FulfillmentSupplierOrderState> = {},
): FulfillmentSupplierOrderState {
  return {
    supplierOrderId: 'so-1',
    supplierId: 'simulated',
    supplierType: 'simulated',
    status: 'in_production',
    items: [
      { sku: 'SKU-1', productId: 'p1', variantId: 'v1', quantity: 1, unitPrice: 10, title: 'T', status: 'in_production' },
    ],
    statusHistory: [],
    ...overrides,
  } as FulfillmentSupplierOrderState;
}

function makeState(overrides: Partial<FulfillmentWorkflowState> = {}): FulfillmentWorkflowState {
  return {
    orderId: 'o-1',
    cartId: 'c-1',
    customerId: 'cust-1',
    status: 'in_production',
    supplierOrders: [makeSupplierOrder()],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as FulfillmentWorkflowState;
}

const apply = (state: FulfillmentWorkflowState, cmd: FulfillmentCommand) =>
  decide(cmd, state).reduce(evolve, state);

describe('aggregateStatus', () => {
  const so = (status: FulfillmentSupplierOrderState['status']) => makeSupplierOrder({ status });

  it('aggregates across supplier orders', () => {
    expect(aggregateStatus(makeState({ supplierOrders: [so('delivered'), so('delivered')] }))).toBe('delivered');
    expect(aggregateStatus(makeState({ supplierOrders: [so('cancelled'), so('failed')] }))).toBe('failed');
    expect(aggregateStatus(makeState({ supplierOrders: [so('shipped'), so('delivered')] }))).toBe('shipped');
    expect(aggregateStatus(makeState({ supplierOrders: [so('shipped'), so('in_production')] }))).toBe('partially_shipped');
    expect(aggregateStatus(makeState({ supplierOrders: [so('in_production')] }))).toBe('in_production');
  });
});

describe('fulfillment decide/evolve', () => {
  it('cancel cascades to every supplier order and line item', () => {
    const state = apply(makeState(), { type: 'cancel', at: '2026-02-01T00:00:00Z' });
    expect(state.status).toBe('cancelled');
    expect(state.updatedAt).toBe('2026-02-01T00:00:00Z');
    expect(state.supplierOrders[0].status).toBe('cancelled');
    expect(state.supplierOrders[0].items[0].status).toBe('cancelled');
  });

  it('childStatusReported replaces the matching supplier order and re-aggregates', () => {
    const update = makeSupplierOrder({ status: 'delivered' });
    const state = apply(makeState(), {
      type: 'childStatusReported',
      update,
      at: '2026-02-01T00:00:00Z',
    });
    expect(state.supplierOrders[0].status).toBe('delivered');
    expect(state.status).toBe('delivered');
  });

  it('does not mutate the input state', () => {
    const state = makeState();
    apply(state, { type: 'cancel', at: 't' });
    expect(state.status).toBe('in_production');
    expect(state.supplierOrders[0].status).toBe('in_production');
  });
});
