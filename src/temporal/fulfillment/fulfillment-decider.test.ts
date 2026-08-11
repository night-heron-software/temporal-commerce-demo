import { describe, it, expect } from 'vitest';

// Pure Functional Core: no Temporal sandbox, no mocks. The per-command blocks are
// exported structures, so each command's decide / evolve entries are exercised directly
// in addition to the assembled dispatchers.
import {
  decide,
  evolve,
  aggregateStatus,
  fulfillmentDecider,
  beginProductionBlock,
  cancelBlock,
  childStatusBlock,
} from './states';
import type { FulfillmentEvent } from './states';
import type {
  FulfillmentWorkflowState,
  FulfillmentFulfillerOrderState,
  FulfillmentOrderStatus,
} from './types';

const AT = '2026-02-01T00:00:00.000Z';

function makeSO(
  over: Partial<FulfillmentFulfillerOrderState> = {},
): FulfillmentFulfillerOrderState {
  return {
    fulfillerOrderId: 'so-1',
    fulfillerId: 'simulated',
    fulfillerType: 'simulated',
    status: 'in_production',
    items: [
      { sku: 'SKU-1', productId: 'p1', variantId: 'v1', quantity: 1, status: 'in_production' },
    ],
    ...over,
  };
}

function state(over: Partial<FulfillmentWorkflowState> = {}): FulfillmentWorkflowState {
  return {
    orderId: 'o-1',
    cartId: 'c-1',
    customerId: 'cust-1',
    status: 'in_production',
    fulfillerOrders: [makeSO()],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const so = (status: FulfillmentOrderStatus, id = 'so-1') =>
  makeSO({ fulfillerOrderId: id, status });

describe('fulfillment decide() — events emitted', () => {
  it('beginProduction from received → ProductionStarted (and nothing once in production)', () => {
    expect(decide({ type: 'beginProduction', at: AT }, state({ status: 'received' }))).toEqual([
      { type: 'ProductionStarted', at: AT },
    ]);
    expect(decide({ type: 'beginProduction', at: AT }, state())).toEqual([]);
  });

  it('cancel → OrderCancelled', () => {
    expect(decide({ type: 'cancel', at: AT }, state())).toEqual([
      { type: 'OrderCancelled', at: AT },
    ]);
  });

  it('childStatus → ChildStatusApplied; a completing update ALSO decides the outcome', () => {
    // Work outstanding: just the applied update.
    const shippedUpdate = so('shipped');
    expect(
      decide(
        { type: 'childStatus', update: shippedUpdate, at: AT },
        state({ fulfillerOrders: [makeSO(), makeSO({ fulfillerOrderId: 'so-2' })] }),
      ),
    ).toEqual([{ type: 'ChildStatusApplied', update: shippedUpdate, at: AT }]);

    // The last child delivering emits the aggregate outcome as an event — routing
    // reads it instead of re-inspecting the folded status (ADR-0024).
    expect(
      decide({ type: 'childStatus', update: so('delivered'), at: AT }, state()).map((e) => e.type),
    ).toEqual(['ChildStatusApplied', 'FulfillmentDelivered']);
    expect(
      decide({ type: 'childStatus', update: so('cancelled'), at: AT }, state()).map((e) => e.type),
    ).toEqual(['ChildStatusApplied', 'FulfillmentFailed']);
  });

  it('decide never mutates the input state', () => {
    const s = state();
    const snapshot = structuredClone(s);
    decide({ type: 'childStatus', update: so('delivered'), at: AT }, s);
    expect(s).toEqual(snapshot);
  });
});

describe('fulfillment evolve() — folding one event', () => {
  it('OrderCancelled cancels the order and every fulfiller order + line item', () => {
    const next = evolve(state(), { type: 'OrderCancelled', at: AT });
    expect(next.status).toBe('cancelled');
    expect(next.fulfillerOrders.every((f) => f.status === 'cancelled')).toBe(true);
    expect(next.fulfillerOrders[0].items.every((i) => i.status === 'cancelled')).toBe(true);
    expect(next.updatedAt).toBe(AT);
  });

  it('ChildStatusApplied replaces the matching fulfiller order and re-aggregates', () => {
    const next = evolve(state(), { type: 'ChildStatusApplied', update: so('delivered'), at: AT });
    expect(next.fulfillerOrders[0].status).toBe('delivered');
    expect(next.status).toBe('delivered');
    expect(next.updatedAt).toBe(AT);
  });

  it('does not mutate the input state', () => {
    const s = state();
    const snapshot = structuredClone(s);
    evolve(s, { type: 'ChildStatusApplied', update: so('shipped'), at: AT });
    expect(s).toEqual(snapshot);
  });
});

describe('aggregateStatus', () => {
  it('reflects the mix of fulfiller-order statuses', () => {
    expect(aggregateStatus(state({ fulfillerOrders: [so('in_production', 'a')] }))).toBe(
      'in_production',
    );
    expect(
      aggregateStatus(state({ fulfillerOrders: [so('shipped', 'a'), so('in_production', 'b')] })),
    ).toBe('partially_shipped');
    expect(
      aggregateStatus(state({ fulfillerOrders: [so('shipped', 'a'), so('shipped', 'b')] })),
    ).toBe('shipped');
    expect(
      aggregateStatus(state({ fulfillerOrders: [so('delivered', 'a'), so('delivered', 'b')] })),
    ).toBe('delivered');
    expect(
      aggregateStatus(state({ fulfillerOrders: [so('cancelled', 'a'), so('failed', 'b')] })),
    ).toBe('failed');
  });
});

describe('fulfillmentDecider — the assembled decider', () => {
  it("has no isTerminal — terminality is the route tables' job (ADR-0024)", () => {
    expect('isTerminal' in fulfillmentDecider).toBe(false);
  });

  it('exposes decide and evolve', () => {
    expect(fulfillmentDecider.decide).toBe(decide);
    expect(fulfillmentDecider.evolve).toBe(evolve);
  });
});

// ── The regression net the purity refactor buys: apply EVERY FulfillmentEvent type and
// prove the input context is untouched. The mapped-type table makes a missing event a
// compile-time hole; the length pin keeps the net growing with the union.
const eventSamples: { [E in FulfillmentEvent['type']]: Extract<FulfillmentEvent, { type: E }> } = {
  ProductionStarted: { type: 'ProductionStarted', at: AT },
  OrderCancelled: { type: 'OrderCancelled', at: AT },
  ChildStatusApplied: { type: 'ChildStatusApplied', update: so('delivered'), at: AT },
  FulfillmentDelivered: { type: 'FulfillmentDelivered', at: AT },
  FulfillmentFailed: { type: 'FulfillmentFailed', at: AT },
};

describe('evolve never mutates its input — every FulfillmentEvent type', () => {
  it('the table covers the whole event union', () => {
    expect(Object.keys(eventSamples)).toHaveLength(5);
  });

  it.each(Object.entries(eventSamples))('%s leaves the input context untouched', (_type, event) => {
    const s = state({ fulfillerOrders: [makeSO(), makeSO({ fulfillerOrderId: 'so-2' })] });
    const snapshot = structuredClone(s);
    const next = evolve(s, event as FulfillmentEvent);
    expect(s).toEqual(snapshot);
    expect(next).not.toBe(s); // a NEW context every time — stamping alone rebuilds it
  });
});

// ── Per-command blocks: each command is packaged as ONE exported structure, so its pure
// fields are exercised directly here.
describe('command blocks — one structure per command', () => {
  it('beginProductionBlock.decide is idempotent — only a freshly-received order starts', () => {
    expect(beginProductionBlock.decide({ type: 'beginProduction', at: AT }, state())).toEqual([]);
    expect(
      beginProductionBlock.decide(
        { type: 'beginProduction', at: AT },
        state({ status: 'received' }),
      ),
    ).toEqual([{ type: 'ProductionStarted', at: AT }]);
  });

  it('cancelBlock.evolve.OrderCancelled cascades immutably to every order and line', () => {
    const s = state();
    const next = cancelBlock.evolve!.OrderCancelled!(s, eventSamples.OrderCancelled);
    expect(next).not.toBe(s);
    expect(next.fulfillerOrders[0].items[0].status).toBe('cancelled');
    expect(s.fulfillerOrders[0].items[0].status).toBe('in_production'); // input untouched
  });

  it('childStatusBlock.decide projects the aggregate outcome onto the current set', () => {
    expect(
      childStatusBlock
        .decide({ type: 'childStatus', update: so('delivered'), at: AT }, state())
        .map((e) => e.type),
    ).toEqual(['ChildStatusApplied', 'FulfillmentDelivered']);
  });
});
