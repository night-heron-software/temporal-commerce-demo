import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the workflow sandbox + activity I/O so the fulfiller-order shell can be driven
// directly. The decider units are covered in fulfiller-decider.test.ts; these assert the
// states wiring: timer-driven auto-progression, the manual-mode guard, the submit prepare
// adapter, fulfillerStatus routing, and the shipment-indexing finalize.
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

import { submitFulfillerOrder, indexShipment } from './activities';
import { FULFILLER_ORDER_STATES, buildFulfillerOrderStates } from './fulfiller-states';
import { terminal } from '../framework';
import type { FulfillerOrderSignal, FulfillerOrderWorkflowContext } from './fulfiller-workflows';
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

const sig = (result: FulfillerOrderSignal) => ({ kind: 'signal' as const, result, timestamp: 't' });
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
    const out = await FULFILLER_ORDER_STATES.received.fn(makeCtx(), sig({ kind: 'cancel' }));
    expect(out.next).toBe(terminal('cancelled'));
    expect(out.context.so.status).toBe('cancelled');
    expect(out.context.so.items.every((i) => i.status === 'cancelled')).toBe(true);
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

  it('a submit failure stays in submitting with the error (prepare-throw guard)', async () => {
    vi.mocked(submitFulfillerOrder).mockRejectedValueOnce(new Error('fulfiller down'));
    const out = await FULFILLER_ORDER_STATES.submitting.fn(makeCtx(), timeout);
    expect(out.next).toBe('submitting');
    expect(out.error).toMatch(/fulfiller down/);
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
    expect(out.context.so.trackingNumber).toMatch(/^SIM/);
    expect(out.context.so.carrier).toBe('Simulated Carrier');
    expect(out.context.so.shipments).toHaveLength(1);
    // Shipment indexing on the auto path happens in the workflow's onTransition, not here.
    expect(indexShipment).not.toHaveBeenCalled();
  });

  it('manual mode suppresses the auto-ship timer (stay put via SELF)', async () => {
    const ctx = inProd({ manualMode: true });
    const out = await FULFILLER_ORDER_STATES.in_production.fn(ctx, timeout);
    expect(out.next).toBe('in_production');
    expect(out.context.so.status).toBe('in_production');
    expect(out.context.so.shipments).toBeUndefined();
  });

  it('a fulfillerStatus shipped update appends the shipment, indexes it, and ships', async () => {
    const out = await FULFILLER_ORDER_STATES.in_production.fn(
      inProd(),
      sig({
        kind: 'fulfillerStatus',
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
    // The finalize hook indexes the NEWEST shipment, keyed by the fulfiller order.
    expect(indexShipment).toHaveBeenCalledWith(
      expect.objectContaining({
        shipmentId: 'so-1-1',
        orderId: 'so-1',
        carrier: 'UPS',
        trackingNumber: '1Z999',
        itemCount: 1,
      }),
    );
  });

  it('a fulfillerStatus update without a new shipment stays put and does not index', async () => {
    const out = await FULFILLER_ORDER_STATES.in_production.fn(
      inProd(),
      sig({
        kind: 'fulfillerStatus',
        update: { fulfillerOrderId: 'so-1', status: 'in_production', timestamp: 't1' },
      }),
    );
    expect(out.next).toBe('in_production');
    expect(indexShipment).not.toHaveBeenCalled();
  });

  it('a fulfillerStatus failed update terminates failed', async () => {
    const out = await FULFILLER_ORDER_STATES.in_production.fn(
      inProd(),
      sig({
        kind: 'fulfillerStatus',
        update: { fulfillerOrderId: 'so-1', status: 'failed', timestamp: 't1' },
      }),
    );
    expect(out.next).toBe(terminal('failed'));
    expect(out.context.so.status).toBe('failed');
  });

  it('cancel mid-production terminates cancelled', async () => {
    const out = await FULFILLER_ORDER_STATES.in_production.fn(inProd(), sig({ kind: 'cancel' }));
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

  it('timeout auto-delivers (terminal) and stamps completion', async () => {
    const out = await FULFILLER_ORDER_STATES.shipped.fn(shippedCtx(), timeout);
    expect(out.next).toBe(terminal('delivered'));
    expect(out.context.so.status).toBe('delivered');
    expect(out.context.so.completedAt).toBe('t');
    expect(out.context.so.items.every((i) => i.status === 'delivered')).toBe(true);
  });

  it('manual mode suppresses the auto-deliver timer', async () => {
    const out = await FULFILLER_ORDER_STATES.shipped.fn(shippedCtx({ manualMode: true }), timeout);
    expect(out.next).toBe('shipped');
    expect(out.context.so.status).toBe('shipped');
  });

  it('a fulfillerStatus delivered update stamps deliveredAt on the newest shipment', async () => {
    const out = await FULFILLER_ORDER_STATES.shipped.fn(
      shippedCtx(),
      sig({
        kind: 'fulfillerStatus',
        update: { fulfillerOrderId: 'so-1', status: 'delivered', timestamp: 't2' },
      }),
    );
    expect(out.next).toBe(terminal('delivered'));
    expect(out.context.so.completedAt).toBe('t2');
    expect(out.context.so.shipments?.[0].deliveredAt).toBe('t2');
    // No shipment was ADDED, so the shipment-indexing finalize must not fire.
    expect(indexShipment).not.toHaveBeenCalled();
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
