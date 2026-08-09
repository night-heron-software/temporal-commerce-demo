/**
 * Pure Functional Core tests — no Temporal sandbox, no activity mocks. `decide` is
 * asserted on the events it emits; `evolve` on the fold. (Demo divergences from the
 * mono's suite: plain numbers instead of Money, the demo's own refund math — pro-rated
 * tax, no accounting breakdown — no capture numbers, and no deadline checks.)
 */
import { describe, it, expect } from 'vitest';
import {
  decide,
  evolve,
  aggregateShippingState,
  buildFulfillment,
  copyOrderState,
  refundSelectionProblem,
  omsDecider,
} from './oms-decider';
import type { EnrichedOrderCommand, OrderEvent, ResolvedAssignment } from './oms-decider';
import type {
  OrderState,
  OrderAssignment,
  FulfillerOrder,
  FulfillmentStatusUpdate,
  RefundRecord,
} from './types';

const AT = '2026-07-02T00:00:00.000Z';

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

function makeAssignment(over: Partial<OrderAssignment> = {}): OrderAssignment {
  return {
    assignmentId: 'asg-1',
    lineItemId: 'li-1',
    variantId: 'v1',
    fulfillerId: 'f1',
    fulfillerName: 'F1',
    fulfillerType: 'simulated',
    quantity: 2,
    status: 'assigned',
    sku: 'SKU-1',
    ...over,
  };
}

function refundRecord(over: Partial<RefundRecord> = {}): RefundRecord {
  return {
    refundId: 'refund-1',
    timestamp: AT,
    lines: [],
    refundAmount: 25,
    taxAmount: 2.5,
    ...over,
  };
}

const apply = (state: OrderState, cmd: EnrichedOrderCommand): OrderState =>
  decide(cmd, state).reduce(evolve, state);

const fulfillmentUpdate = (
  over: Partial<FulfillmentStatusUpdate> = {},
): FulfillmentStatusUpdate => ({
  fulfillerOrderId: 'so-1',
  status: 'shipped',
  carrier: 'UPS',
  trackingNumber: '1Z999',
  ...over,
});

describe('oms decide() — intake', () => {
  it('capturePayment → a bare PaymentCaptured (demo: no ledger numbers to decide)', () => {
    expect(decide({ type: 'capturePayment', at: AT }, makeState())).toEqual([
      { type: 'PaymentCaptured', at: AT },
    ]);
  });

  it('assignFulfillers with resolutions → FulfillersAssigned (line-scoped assignments)', () => {
    const resolved: ResolvedAssignment[] = [
      {
        fulfillerId: 'f1',
        fulfillerName: 'F1',
        fulfillerType: 'simulated',
        sku: 'SKU-1',
        assignmentId: 'asg-9',
      },
    ];
    const events = decide({ type: 'assignFulfillers', resolved, at: AT }, makeState());
    expect(events[0]).toMatchObject({
      type: 'FulfillersAssigned',
      assignments: [
        {
          assignmentId: 'asg-9',
          lineItemId: 'li-1',
          variantId: 'v1',
          fulfillerId: 'f1',
          quantity: 2,
          status: 'assigned',
          sku: 'SKU-1',
        },
      ],
    });
  });

  it('assignFulfillers with nothing resolved → NoFulfillersResolved (manual path)', () => {
    const events = decide(
      { type: 'assignFulfillers', resolved: [null, null], at: AT },
      makeState(),
    );
    expect(events).toEqual([{ type: 'NoFulfillersResolved', at: AT }]);
  });

  it('requestFulfillment → FulfillmentRequested with grouped fulfiller orders', () => {
    const s = makeState({ assignments: [makeAssignment()], fulfillerOrders: [] });
    const events = decide(
      { type: 'requestFulfillment', fulfillerOrderIds: { f1: 'so-abc' }, at: AT },
      s,
    );
    expect(events).toHaveLength(1);
    const e = events[0] as Extract<OrderEvent, { type: 'FulfillmentRequested' }>;
    expect(e.fulfillerOrders[0]).toMatchObject({
      fulfillerOrderId: 'so-abc',
      fulfillerId: 'f1',
      status: 'pending',
      items: [{ assignmentId: 'asg-1', variantId: 'v1', quantity: 2 }],
    });
    expect(e.fulfillmentInputs[0].items[0]).toMatchObject({ sku: 'SKU-1', unitPrice: 10 });
    // decide does not mutate — the assignment updates are evolve's job
    expect(s.assignments[0].fulfillerOrderId).toBeUndefined();
  });
});

describe('oms decide() — lifecycle events emitted', () => {
  it('cancelOrder → OrderCancelled', () => {
    expect(decide({ type: 'cancelOrder', at: AT }, makeState())).toEqual([
      { type: 'OrderCancelled', at: AT },
    ]);
  });

  it('updateStatus decides one event per target (route tables key on TYPE)', () => {
    const cases: Array<[string, string]> = [
      ['processing', 'OrderProcessing'],
      ['partially_shipped', 'OrderPartiallyShipped'],
      ['shipped', 'OrderShipped'],
      ['delivered', 'OrderDelivered'],
      ['return_requested', 'OrderReturnRequested'],
      ['cancelled', 'OrderCancelled'],
      ['refunded', 'OrderRefunded'],
      ['returned', 'OrderReturned'],
      ['complete', 'OrderCompleted'],
    ];
    for (const [status, eventType] of cases) {
      expect(
        decide(
          {
            type: 'updateStatus',
            status: status as OrderState['status'],
            updatedBy: 'admin',
            at: AT,
          },
          makeState(),
        ),
      ).toEqual([{ type: eventType, at: AT }]);
    }
  });

  it('updateStatus to an unforceable status decides nothing (the guard rejects first)', () => {
    expect(
      decide(
        { type: 'updateStatus', status: 'pending_assignment', updatedBy: 'admin', at: AT },
        makeState(),
      ),
    ).toEqual([]);
  });

  it('submitFeedback → FeedbackSubmitted', () => {
    expect(
      decide({ type: 'submitFeedback', rating: 5, comment: 'Great', at: AT }, makeState()),
    ).toEqual([{ type: 'FeedbackSubmitted', rating: 5, comment: 'Great', at: AT }]);
  });

  it('refundOrder (full) → Refunded + OrderRefunded (the terminal move is decided, not re-read)', () => {
    const events = decide({ type: 'refundOrder', at: AT }, makeState());
    expect(events).toHaveLength(2);
    const e = events[0] as Extract<OrderEvent, { type: 'Refunded' }>;
    expect(e.type).toBe('Refunded');
    expect(e.fullyRefunded).toBe(true);
    expect(e.record).toMatchObject({ refundAmount: 25, taxAmount: 2.5, timestamp: AT });
    expect(events[1]).toEqual({ type: 'OrderRefunded', at: AT });
  });

  it('refundOrder (partial) → Refunded only, with the line + pro-rated tax', () => {
    const events = decide(
      { type: 'refundOrder', lines: [{ lineItemId: 'li-1', quantity: 1 }], at: AT },
      makeState(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'Refunded',
      fullyRefunded: false,
      record: { refundAmount: 10, taxAmount: 1 }, // 2.5 * (10/25)
    });
  });

  it('requestReturn → ReturnRequested', () => {
    const events = decide(
      {
        type: 'requestReturn',
        lines: [{ lineItemId: 'li-1', quantity: 1 }],
        reason: 'wrong size',
        updatedBy: 'customer',
        at: AT,
      },
      makeState({ status: 'delivered' }),
    );
    expect(events[0]).toMatchObject({
      type: 'ReturnRequested',
      record: { reason: 'wrong size', requestedBy: 'customer', requestedAt: AT },
    });
  });

  it('confirmReturn → ReturnConfirmed with a refund record (falls back to the request reason)', () => {
    const s = makeState({
      status: 'return_requested',
      returnRequest: {
        lines: [{ lineItemId: 'li-1', quantity: 2 }],
        reason: 'wrong size',
        requestedAt: AT,
      },
    });
    const events = decide({ type: 'confirmReturn', at: AT }, s);
    expect(events[0]).toMatchObject({
      type: 'ReturnConfirmed',
      record: { refundAmount: 20, reason: 'wrong size' },
    });
  });

  it('denyReturn → ReturnDenied', () => {
    expect(decide({ type: 'denyReturn', at: AT }, makeState())).toEqual([
      { type: 'ReturnDenied', at: AT },
    ]);
  });

  it('fulfillmentStatus decides the aggregate OUTCOME alongside FulfillmentApplied', () => {
    const s = makeState({
      fulfillerOrders: [
        makeFulfillerOrder({ fulfillerOrderId: 'so-1', status: 'pending' }),
        makeFulfillerOrder({ fulfillerOrderId: 'so-2', status: 'pending' }),
      ],
    });
    expect(
      decide(
        { type: 'fulfillmentStatus', update: fulfillmentUpdate({ carrier: undefined }), at: AT },
        s,
      ),
    ).toEqual([
      {
        type: 'FulfillmentApplied',
        update: fulfillmentUpdate({ carrier: undefined }),
        at: AT,
      },
      { type: 'FulfillmentPartiallyShipped', at: AT },
    ]);

    const allShipped = makeState({
      fulfillerOrders: [
        makeFulfillerOrder({ fulfillerOrderId: 'so-1', status: 'shipped' }),
        makeFulfillerOrder({ fulfillerOrderId: 'so-2', status: 'pending' }),
      ],
    });
    expect(
      decide(
        {
          type: 'fulfillmentStatus',
          update: fulfillmentUpdate({ fulfillerOrderId: 'so-2' }),
          at: AT,
        },
        allShipped,
      )[1],
    ).toEqual({ type: 'FulfillmentShipped', at: AT });

    const allDelivered = makeState({
      fulfillerOrders: [
        makeFulfillerOrder({ fulfillerOrderId: 'so-1', status: 'delivered' }),
        makeFulfillerOrder({ fulfillerOrderId: 'so-2', status: 'shipped' }),
      ],
    });
    expect(
      decide(
        {
          type: 'fulfillmentStatus',
          update: fulfillmentUpdate({ fulfillerOrderId: 'so-2', status: 'delivered' }),
          at: AT,
        },
        allDelivered,
      )[1],
    ).toEqual({ type: 'FulfillmentDelivered', at: AT });
  });

  it('fulfillmentStatus for an unknown fulfiller order → nothing (stay put)', () => {
    expect(
      decide(
        {
          type: 'fulfillmentStatus',
          update: fulfillmentUpdate({ fulfillerOrderId: 'nope' }),
          at: AT,
        },
        makeState(),
      ),
    ).toEqual([]);
  });

  it('decide never mutates the input state', () => {
    const s = makeState();
    const snapshot = structuredClone(s);
    decide({ type: 'fulfillmentStatus', update: fulfillmentUpdate(), at: AT }, s);
    expect(s).toEqual(snapshot);
  });
});

describe('refund folds (decide → evolve)', () => {
  it('partial refund records the line + pro-rated tax without changing status', () => {
    const state = apply(makeState({ status: 'delivered' }), {
      type: 'refundOrder',
      lines: [{ lineItemId: 'li-1', quantity: 1 }],
      reason: 'damaged',
      at: AT,
    });
    expect(state.status).toBe('delivered');
    expect(state.refunds).toHaveLength(1);
    expect(state.refunds![0].refundAmount).toBe(10);
    expect(state.refunds![0].taxAmount).toBe(1); // 2.5 * (10/25)
  });

  it('full refund (omitted lines) marks the order refunded', () => {
    const state = apply(makeState({ status: 'delivered' }), {
      type: 'refundOrder',
      reason: 'full',
      at: AT,
    });
    expect(state.status).toBe('refunded');
    expect(state.refunds![0].refundAmount).toBe(25);
  });

  it('cumulative partials flip to refunded when everything is covered', () => {
    const first = apply(makeState({ status: 'delivered' }), {
      type: 'refundOrder',
      lines: [{ lineItemId: 'li-1', quantity: 2 }],
      at: AT,
    });
    expect(first.status).toBe('delivered');
    const second = apply(first, {
      type: 'refundOrder',
      lines: [{ lineItemId: 'li-2', quantity: 1 }],
      at: AT,
    });
    expect(second.status).toBe('refunded');
    expect(second.refunds).toHaveLength(2);
  });

  it('confirmReturn refunds the requested lines and marks the order returned', () => {
    const requested = apply(makeState({ status: 'delivered' }), {
      type: 'requestReturn',
      lines: [{ lineItemId: 'li-1', quantity: 2 }],
      reason: 'wrong size',
      at: AT,
    });
    const returned = apply(requested, { type: 'confirmReturn', at: AT });
    expect(returned.status).toBe('returned');
    expect(returned.returnRequest).toBeUndefined();
    expect(returned.refunds![0].refundAmount).toBe(20);
  });
});

describe('oms evolve() — folding one event', () => {
  it('PaymentCaptured folds nothing (demo: pure intake hop)', () => {
    const s = makeState({ status: 'pending_assignment' });
    expect(evolve(s, { type: 'PaymentCaptured', at: AT })).toEqual(s);
  });

  it('FulfillersAssigned pushes the assignments', () => {
    const next = evolve(makeState({ status: 'pending_assignment', assignments: [] }), {
      type: 'FulfillersAssigned',
      assignments: [makeAssignment()],
      at: AT,
    });
    expect(next.assignments).toHaveLength(1);
    expect(next.assignments[0].assignmentId).toBe('asg-1');
  });

  it('FulfillmentRequested installs fulfiller orders, marks assignments fulfilled, → processing', () => {
    const s = makeState({
      status: 'pending_assignment',
      assignments: [makeAssignment()],
      fulfillerOrders: [],
    });
    const [event] = decide(
      { type: 'requestFulfillment', fulfillerOrderIds: { f1: 'so-abc' }, at: AT },
      s,
    );
    const next = evolve(s, event);
    expect(next.status).toBe('processing');
    expect(next.fulfillerOrders).toHaveLength(1);
    expect(next.assignments[0]).toMatchObject({ fulfillerOrderId: 'so-abc', status: 'fulfilled' });
  });

  it('Refunded pushes the record and marks refunded when full', () => {
    const next = evolve(makeState(), {
      type: 'Refunded',
      record: refundRecord(),
      fullyRefunded: true,
      at: AT,
    });
    expect(next.refunds).toHaveLength(1);
    expect(next.status).toBe('refunded');
    expect(next.updatedAt).toBe(AT);
  });

  it('ReturnConfirmed → returned, clears the request, records the refund', () => {
    const s = makeState({ status: 'return_requested', returnRequest: { requestedAt: AT } });
    const next = evolve(s, { type: 'ReturnConfirmed', record: refundRecord(), at: AT });
    expect(next.status).toBe('returned');
    expect(next.returnRequest).toBeUndefined();
    expect(next.refunds).toHaveLength(1);
  });

  it('FulfillmentApplied mirrors the fulfiller order + assignments; delivered stamps deliveredAt', () => {
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

  it('collapses duplicate consecutive fulfiller-order statuses into one history entry', () => {
    const once = apply(makeState(), {
      type: 'fulfillmentStatus',
      update: fulfillmentUpdate(),
      at: 't1',
    });
    const twice = apply(once, { type: 'fulfillmentStatus', update: fulfillmentUpdate(), at: 't2' });
    const shippedEntries = twice.fulfillerOrders[0].statusHistory.filter(
      (h) => h.status === 'shipped',
    );
    expect(shippedEntries).toHaveLength(1);
    expect(shippedEntries[0].timestamp).toBe('t2');
  });

  it('forced status events set the status; forced OrderDelivered does NOT stamp deliveredAt', () => {
    expect(evolve(makeState(), { type: 'OrderShipped', at: AT }).status).toBe('shipped');
    const forced = evolve(makeState(), { type: 'OrderDelivered', at: AT });
    expect(forced.status).toBe('delivered');
    expect(forced.deliveredAt).toBeUndefined();
  });

  it('does not mutate the input state (copyOrderState fold)', () => {
    const state = makeState();
    apply(state, { type: 'cancelOrder', at: AT });
    expect(state.status).toBe('processing');
    const copy = copyOrderState(state);
    copy.fulfillerOrders[0].status = 'delivered';
    expect(state.fulfillerOrders[0].status).toBe('processing');
  });
});

describe('refundSelectionProblem — pure guard validation', () => {
  it('accepts an omitted selection (full refund of the remainder)', () => {
    expect(refundSelectionProblem(makeState(), undefined)).toBeUndefined();
  });

  it('rejects an unknown line item', () => {
    expect(refundSelectionProblem(makeState(), [{ lineItemId: 'nope', quantity: 1 }])).toMatch(
      /Unknown line item/,
    );
  });

  it('rejects a non-positive quantity', () => {
    expect(refundSelectionProblem(makeState(), [{ lineItemId: 'li-1', quantity: 0 }])).toMatch(
      /Non-positive refund quantity/,
    );
  });

  it('rejects a quantity exceeding the unrefunded remainder', () => {
    const s = makeState({
      refunds: [refundRecord({ lines: [{ lineItemId: 'li-1', quantity: 1 }] })],
    });
    expect(refundSelectionProblem(s, [{ lineItemId: 'li-1', quantity: 2 }])).toMatch(
      /exceeds remaining 1/,
    );
    expect(refundSelectionProblem(s, [{ lineItemId: 'li-1', quantity: 1 }])).toBeUndefined();
  });

  it('rejects a full refund when nothing remains', () => {
    const s = makeState({
      refunds: [
        refundRecord({
          lines: [
            { lineItemId: 'li-1', quantity: 2 },
            { lineItemId: 'li-2', quantity: 1 },
          ],
        }),
      ],
    });
    expect(refundSelectionProblem(s, undefined)).toBe('Nothing left to refund');
  });
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

describe('buildFulfillment — pure construction', () => {
  it('groups line-scoped assignments by fulfiller under the prepared ids', () => {
    const s = makeState({
      assignments: [
        makeAssignment(),
        makeAssignment({
          assignmentId: 'asg-2',
          lineItemId: 'li-2',
          variantId: 'v2',
          fulfillerId: 'f2',
          fulfillerName: 'F2',
          quantity: 1,
        }),
      ],
      fulfillerOrders: [],
    });
    const { fulfillerOrders, fulfillmentInputs } = buildFulfillment(s, AT, {
      f1: 'so-1',
      f2: 'so-2',
    });
    expect(fulfillerOrders.map((so) => so.fulfillerOrderId).sort()).toEqual(['so-1', 'so-2']);
    expect(fulfillmentInputs).toHaveLength(2);
  });

  it('falls back to the variantId when an assignment has no sku (demo: no sku threading)', () => {
    const s = makeState({ assignments: [makeAssignment({ sku: undefined })], fulfillerOrders: [] });
    const { fulfillmentInputs } = buildFulfillment(s, AT, { f1: 'so-1' });
    expect(fulfillmentInputs[0].items[0].sku).toBe('v1');
  });
});

describe('rebuilding state is a fold (decide → evolve)', () => {
  it('a shipment lifecycle folds processing → delivered', () => {
    let s = makeState({
      fulfillerOrders: [
        makeFulfillerOrder({ fulfillerOrderId: 'so-1', status: 'pending' }),
        makeFulfillerOrder({ fulfillerOrderId: 'so-2', status: 'pending' }),
      ],
    });
    const step = (fulfillerOrderId: string, status: 'shipped' | 'delivered') => {
      s = apply(s, {
        type: 'fulfillmentStatus',
        update: { fulfillerOrderId, status },
        at: AT,
      });
    };
    step('so-1', 'shipped');
    expect(s.status).toBe('partially_shipped');
    step('so-2', 'shipped');
    expect(s.status).toBe('shipped');
    step('so-1', 'delivered');
    step('so-2', 'delivered');
    expect(s.status).toBe('delivered');
  });
});

describe('omsDecider — the assembled decider', () => {
  it('exposes decide and evolve', () => {
    expect(omsDecider.decide).toBe(decide);
    expect(omsDecider.evolve).toBe(evolve);
  });

  it('has no isTerminal — terminality is the route tables (ADR-0024)', () => {
    expect('isTerminal' in omsDecider).toBe(false);
  });
});
