import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the workflow sandbox + activity I/O so the fulfiller-order machine states can
// be driven directly. The decider units are covered in fulfiller-decider.test.ts; these
// assert the states wiring: timer-synthesized commands (auto-progression), the
// manual-mode idle tick, the submit prepare adapter (rejection on failure), the
// workflow-id-derived tracking number, fulfillerStatus routing, and the event-keyed
// shipment-indexing / email effects.
vi.mock('@temporalio/workflow', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  defineSignal: vi.fn((name: string) => ({ type: 'signal', name })),
  defineQuery: vi.fn((name: string) => ({ type: 'query', name })),
  getExternalWorkflowHandle: vi.fn(() => ({ signal: vi.fn(), cancel: vi.fn() })),
  proxyActivities: vi.fn(() => ({ persistWorkflowTransitions: vi.fn(async () => undefined) })),
  workflowInfo: vi.fn(() => ({
    workflowId: 'demo.fulfiller-order.so-1',
    runId: 'run-1',
    searchAttributes: {},
    workflowType: 'fulfillerOrderWorkflow',
  })),
  condition: vi.fn(async () => true),
  uuid4: () => 'uuid-fixed',
}));

vi.mock('./activities', () => ({
  getFeatureFlag: vi.fn(async () => false),
  submitFulfillerOrder: vi.fn(async () => ({ success: true, fulfillerOrderId: 'SIM-1' })),
  sendShippedEmail: vi.fn(async () => undefined),
  sendDeliveredEmail: vi.fn(async () => undefined),
  transferInventoryReservations: vi.fn(async () => undefined),
  fulfillInventoryReservations: vi.fn(async () => undefined),
  releaseInventoryReservations: vi.fn(async () => undefined),
  indexFulfillment: vi.fn(async () => undefined),
  indexShipment: vi.fn(async () => undefined),
}));

import {
  submitFulfillerOrder,
  sendShippedEmail,
  sendDeliveredEmail,
  indexShipment,
} from './activities';
import { FULFILLER_ORDER_STATES, buildFulfillerOrderStates } from './fulfiller-states';
import type { FulfillerOrderCommand } from './fulfiller-states';
import { terminal } from '../framework';
import type { FulfillerOrderWorkflowContext } from './fulfiller-decider';
import type { ShipmentInfo } from './types';

// ── Builders ────────────────────────────────────────────────────────────────
function makeCtx(
  overrides: Partial<FulfillerOrderWorkflowContext> = {},
): FulfillerOrderWorkflowContext {
  return {
    orderId: 'o-1',
    cartId: 'cart-1',
    customerId: 'a@b.c',
    customerEmail: 'a@b.c',
    confirmationNumber: 'DEMO1234',
    shippingAddress: {
      firstName: 'A',
      lastName: 'B',
      email: 'a@b.c',
      address1: '1 Main St',
      city: 'Springfield',
      region: 'IL',
      zip: '62701',
      country: 'US',
    },
    shippingMethod: 'standard',
    so: {
      fulfillerOrderId: 'so-1',
      fulfillerId: 'simulated',
      fulfillerType: 'simulated',
      items: [{ sku: 'SKU-1', productId: 'p1', variantId: 'v1', quantity: 2, status: 'pending' }],
      status: 'received',
    },
    manualMode: false,
    ...overrides,
  };
}

const makeShipment = (over: Partial<ShipmentInfo> = {}): ShipmentInfo => ({
  shipmentId: 'so-1-1',
  carrier: 'UPS',
  trackingNumber: '1Z999',
  items: [{ sku: 'SKU-1', quantity: 2 }],
  shippedAt: 't1',
  ...over,
});

// Signals arrive at the state fn already mapped to commands (toSignal in fulfiller-workflows.ts).
const sig = (result: FulfillerOrderCommand) => ({
  kind: 'signal' as const,
  result,
  timestamp: 't',
});
const timeout = { kind: 'timeout' as const, timestamp: 't' };

beforeEach(() => vi.clearAllMocks());

// ── received: book-keeping hop ────────────────────────────────────────────────
describe('received', () => {
  it('timeout marks the order submitting and advances', async () => {
    const out = await FULFILLER_ORDER_STATES.received.fn(makeCtx(), timeout);
    expect(out.next).toBe('submitting');
    expect(out.context.so.status).toBe('submitting');
  });

  it('cancel terminates cancelled with items cascaded', async () => {
    const out = await FULFILLER_ORDER_STATES.received.fn(makeCtx(), sig({ type: 'cancel' }));
    expect(out.next).toBe(terminal('cancelled'));
    expect(out.context.so.status).toBe('cancelled');
    expect(out.context.so.items.every((i) => i.status === 'cancelled')).toBe(true);
  });

  it('a command the state does not list (fulfillerStatus pre-submit) is REJECTED', async () => {
    const ctx = makeCtx();
    const out = await FULFILLER_ORDER_STATES.received.fn(
      ctx,
      sig({
        type: 'fulfillerStatus',
        update: { fulfillerOrderId: 'so-1', status: 'shipped', timestamp: 't1' },
      }),
    );
    expect(out.next).toBe('received');
    expect(out.rejected).toBe(true);
    expect(out.error).toMatch(/does not accept command 'fulfillerStatus'/);
    expect(out.context.so.status).toBe('received');
  });
});

// ── submitting: the fulfiller submit prepare adapter ─────────────────────────
describe('submitting', () => {
  it('timeout submits to the fulfiller and records the external id', async () => {
    const ctx = makeCtx({ so: { ...makeCtx().so, status: 'submitting' } });
    const out = await FULFILLER_ORDER_STATES.submitting.fn(ctx, timeout);
    expect(out.next).toBe('in_production');
    expect(out.context.so.fulfillerExternalId).toBe('SIM-1');
    expect(out.context.so.submittedAt).toBe('t');
    expect(out.context.so.items.every((i) => i.status === 'in_production')).toBe(true);
    // The prepare adapter builds the fulfiller request from the workflow identity + context.
    expect(submitFulfillerOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        fulfillmentId: 'demo.fulfiller-order.so-1',
        fulfillerType: 'simulated',
        shippingMethod: 'standard',
        items: [
          expect.objectContaining({ sku: 'SKU-1', quantity: 2, fulfillerProductId: 'simulated' }),
        ],
        shippingAddress: expect.objectContaining({ address1: '1 Main St', region: 'IL' }),
      }),
    );
  });

  it('a submit failure REJECTS the tick: stay in submitting with the error', async () => {
    vi.mocked(submitFulfillerOrder).mockRejectedValueOnce(new Error('fulfiller down'));
    const out = await FULFILLER_ORDER_STATES.submitting.fn(makeCtx(), timeout);
    expect(out.next).toBe('submitting');
    expect(out.rejected).toBe(true); // no transition, no recording, no projection
    expect(out.error).toMatch(/fulfiller down/);
    expect(out.context.so.fulfillerExternalId).toBeUndefined();
  });

  it('a resolved success:false result stays in submitting with the error surfaced', async () => {
    vi.mocked(submitFulfillerOrder).mockResolvedValueOnce({
      success: false,
      errorMessage: 'fulfiller rejected the order',
    });
    const out = await FULFILLER_ORDER_STATES.submitting.fn(makeCtx(), timeout);
    expect(out.next).toBe('submitting');
    expect(out.rejected).toBe(true);
    expect(out.error).toMatch(/fulfiller rejected the order/);
    expect(out.context.so.fulfillerExternalId).toBeUndefined();
  });
});

// ── in_production: auto-ship timer vs manual mode vs fulfiller updates ────────
describe('in_production', () => {
  const inProd = (over: Partial<FulfillerOrderWorkflowContext> = {}) =>
    makeCtx({ so: { ...makeCtx().so, status: 'in_production' }, ...over });

  it('timeout auto-ships with a simulated tracking number derived from the workflow id', async () => {
    const out = await FULFILLER_ORDER_STATES.in_production.fn(inProd(), timeout);
    expect(out.next).toBe('shipped');
    expect(out.context.so.status).toBe('shipped');
    // deriveTrackingNumber prepare: `SIM` + workflowId.slice(0, 8).toUpperCase().
    expect(out.context.so.trackingNumber).toBe('SIMDEMO.FUL');
    expect(out.context.so.carrier).toBe('Simulated Carrier');
    expect(out.context.so.shipments).toHaveLength(1);
    // Event-keyed effects: SimulatedShipped indexes the shipment and emails the customer.
    expect(indexShipment).toHaveBeenCalledWith(
      expect.objectContaining({
        shipmentId: 'o-1-so-1-1',
        orderId: 'o-1',
        correlationId: 'cart-1',
        trackingNumber: 'SIMDEMO.FUL',
        itemCount: 1,
      }),
    );
    expect(sendShippedEmail).toHaveBeenCalledWith(
      'a@b.c',
      'o-1',
      'DEMO1234',
      expect.objectContaining({ trackingNumber: 'SIMDEMO.FUL', carrier: 'Simulated Carrier' }),
    );
  });

  it('manual mode suppresses the auto-ship timer (idle tick, stay put)', async () => {
    const ctx = inProd({ manualMode: true });
    const out = await FULFILLER_ORDER_STATES.in_production.fn(ctx, timeout);
    expect(out.next).toBe('in_production');
    expect(out.context.so.status).toBe('in_production');
    expect(out.context.so.shipments).toBeUndefined();
    expect(indexShipment).not.toHaveBeenCalled();
  });

  it('a fulfillerStatus shipped update appends the shipment, indexes it, and ships', async () => {
    const out = await FULFILLER_ORDER_STATES.in_production.fn(
      inProd(),
      sig({
        type: 'fulfillerStatus',
        update: {
          fulfillerOrderId: 'so-1',
          status: 'shipped',
          shipmentInfo: {
            carrier: 'UPS',
            trackingNumber: '1Z999',
            items: [{ sku: 'SKU-1', quantity: 2 }],
          },
          timestamp: 't1',
        },
      }),
    );
    expect(out.next).toBe('shipped');
    expect(out.context.so.shipments).toHaveLength(1);
    // The FulfillerStatusApplied effect indexes the NEWEST shipment.
    expect(indexShipment).toHaveBeenCalledWith(
      expect.objectContaining({
        shipmentId: 'so-1-1',
        orderId: 'o-1',
        correlationId: 'cart-1',
        carrier: 'UPS',
        trackingNumber: '1Z999',
        itemCount: 1,
      }),
    );
    // ShipmentProgressed effect emails the customer.
    expect(sendShippedEmail).toHaveBeenCalled();
  });

  it('a fulfillerStatus update without a new shipment stays put and does not index', async () => {
    const out = await FULFILLER_ORDER_STATES.in_production.fn(
      inProd(),
      sig({
        type: 'fulfillerStatus',
        update: { fulfillerOrderId: 'so-1', status: 'in_production', timestamp: 't1' },
      }),
    );
    expect(out.next).toBe('in_production');
    expect(indexShipment).not.toHaveBeenCalled();
    expect(sendShippedEmail).not.toHaveBeenCalled();
  });

  it('a fulfillerStatus failed update terminates failed', async () => {
    const out = await FULFILLER_ORDER_STATES.in_production.fn(
      inProd(),
      sig({
        type: 'fulfillerStatus',
        update: { fulfillerOrderId: 'so-1', status: 'failed', timestamp: 't1' },
      }),
    );
    expect(out.next).toBe(terminal('failed'));
    expect(out.context.so.status).toBe('failed');
  });

  it('cancel mid-production terminates cancelled', async () => {
    const out = await FULFILLER_ORDER_STATES.in_production.fn(inProd(), sig({ type: 'cancel' }));
    expect(out.next).toBe(terminal('cancelled'));
  });
});

// ── shipped: auto-deliver timer vs manual mode ────────────────────────────────
describe('shipped', () => {
  const shippedCtx = (over: Partial<FulfillerOrderWorkflowContext> = {}) =>
    makeCtx({
      so: { ...makeCtx().so, status: 'shipped', shipments: [makeShipment()] },
      ...over,
    });

  it('timeout auto-delivers (terminal), stamps completion, and emails the customer', async () => {
    const out = await FULFILLER_ORDER_STATES.shipped.fn(shippedCtx(), timeout);
    expect(out.next).toBe(terminal('delivered'));
    expect(out.context.so.status).toBe('delivered');
    expect(out.context.so.completedAt).toBe('t');
    expect(out.context.so.items.every((i) => i.status === 'delivered')).toBe(true);
    expect(sendDeliveredEmail).toHaveBeenCalledWith('a@b.c', 'o-1', 'DEMO1234');
  });

  it('manual mode suppresses the auto-deliver timer', async () => {
    const out = await FULFILLER_ORDER_STATES.shipped.fn(shippedCtx({ manualMode: true }), timeout);
    expect(out.next).toBe('shipped');
    expect(out.context.so.status).toBe('shipped');
    expect(sendDeliveredEmail).not.toHaveBeenCalled();
  });

  it('a fulfillerStatus delivered update stamps deliveredAt on the newest shipment', async () => {
    const out = await FULFILLER_ORDER_STATES.shipped.fn(
      shippedCtx(),
      sig({
        type: 'fulfillerStatus',
        update: { fulfillerOrderId: 'so-1', status: 'delivered', timestamp: 't2' },
      }),
    );
    expect(out.next).toBe(terminal('delivered'));
    expect(out.context.so.completedAt).toBe('t2');
    expect(out.context.so.shipments?.[0].deliveredAt).toBe('t2');
    // No shipment was ADDED, so the shipment-indexing effect must not fire.
    expect(indexShipment).not.toHaveBeenCalled();
    // The DeliveryConfirmed effect emails the customer.
    expect(sendDeliveredEmail).toHaveBeenCalled();
  });
});

// ── buildFulfillerOrderStates: memo-driven simulation delays ─────────────────
describe('buildFulfillerOrderStates', () => {
  it('overrides in_production/shipped timeouts from the memo delays', () => {
    const states = buildFulfillerOrderStates({
      processingDelayMs: 4000,
      shippingDelayMs: 2000,
      deliveryDelayMs: 3000,
    });
    expect(states.in_production.timeout).toBe('4000ms');
    // shipped waits out shipping + delivery before the simulated delivery fires.
    expect(states.shipped.timeout).toBe('5000ms');
    // The book-keeping hops keep their immediate placeholder timeouts.
    expect(states.received.timeout).toBe('1 millisecond');
    expect(states.submitting.timeout).toBe('1 millisecond');
  });
});
