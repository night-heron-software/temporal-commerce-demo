import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the workflow sandbox + activity I/O so the machine states can be exercised
// directly. The pure decide/evolve logic is covered in oms-decider.test.ts — these tests
// assert the wiring: route tables, guards (rejections), prepare adapters, and the
// event-keyed effects (emails, fulfillment cancel, the fulfillment child start).
vi.mock('@temporalio/workflow', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  defineSignal: vi.fn((name: string) => ({ type: 'signal', name })),
  startChild: vi.fn(async () => ({ workflowId: 'fulfillment-child' })),
  getExternalWorkflowHandle: vi.fn(() => ({ signal: vi.fn(), cancel: vi.fn() })),
  // Needed by the framework's transition-sink / identity resolver, which load with '../framework'.
  proxyActivities: vi.fn(() => ({ persistWorkflowTransitions: vi.fn(async () => undefined) })),
  workflowInfo: vi.fn(() => ({
    workflowId: 'demo.order.o-1',
    runId: 'run-1',
    // The workflow's own journey correlationId (ADR-0011) — downstream startChild
    // reads this Search Attribute and passes it on.
    searchAttributes: { CorrelationId: ['corr-1'] },
    workflowType: 'orderWorkflow',
  })),
  condition: vi.fn(async () => true),
  uuid4: () => 'uuid-fixed',
}));

vi.mock('./activities', () => ({
  saveOrderToDatabase: vi.fn(async () => undefined),
  updateOrderInDatabase: vi.fn(async () => undefined),
  sendOrderStatusEmail: vi.fn(async () => undefined),
  sendFeedbackThankYouEmail: vi.fn(async () => undefined),
  getOrdersByEmail: vi.fn(async () => []),
  getOrderById: vi.fn(async () => null),
  resolveFulfillerAssignments: vi.fn(async () => [
    {
      fulfillerId: 'simulated',
      fulfillerName: 'Simulated',
      fulfillerType: 'simulated',
      sku: 'SKU-1',
    },
  ]),
  insertStatusHistoryEntry: vi.fn(async () => undefined),
  indexOrder: vi.fn(async () => undefined),
  indexFulfillerOrder: vi.fn(async () => undefined),
  indexCustomer: vi.fn(async () => undefined),
}));

import { startChild, getExternalWorkflowHandle, log } from '@temporalio/workflow';
import {
  sendOrderStatusEmail,
  sendFeedbackThankYouEmail,
  resolveFulfillerAssignments,
  indexFulfillerOrder,
} from './activities';
import { OMS_STATES } from './states';
import { terminal } from '../framework';
import type {
  Order,
  OrderState,
  OrderCommand,
  OrderAssignment,
  FulfillerOrder,
  FulfillmentStatusUpdate,
  RefundRecord,
} from './types';

// ── Builders ────────────────────────────────────────────────────────────────
function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId: 'o-1',
    cartId: 'cart-1',
    correlationId: 'corr-1',
    customerEmail: 'a@b.c',
    items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 1, price: 10 }],
    shippingAddress: {
      firstName: 'A',
      lastName: 'B',
      address1: '1 Main St',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      country: 'US',
      email: 'a@b.c',
    },
    paymentMethod: { type: 'mock', token: 'tok_1' },
    subtotal: 10,
    shippingCost: 5,
    tax: 0.8,
    totalDiscounts: 0,
    total: 15.8,
    currency: 'USD',
    status: 'paid',
    createdAt: '2026-01-01T00:00:00Z',
    confirmationNumber: 'DEMO1234',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<OrderState> = {}): OrderState {
  return {
    order: makeOrder(),
    status: 'processing',
    statusHistory: [],
    assignments: [],
    fulfillerOrders: [],
    ...overrides,
  };
}

const makeAssignment = (over: Partial<OrderAssignment> = {}): OrderAssignment => ({
  assignmentId: 'a-1',
  lineItemId: 'li-1',
  variantId: 'v1',
  fulfillerId: 'simulated',
  fulfillerName: 'Simulated',
  quantity: 1,
  status: 'assigned',
  ...over,
});

const makeSO = (
  id: string,
  assignmentId: string,
  status: FulfillerOrder['status'] = 'pending',
): FulfillerOrder => ({
  fulfillerOrderId: id,
  orderId: 'o-1',
  fulfillerId: 'simulated',
  fulfillerName: 'Simulated',
  status,
  items: [{ assignmentId, variantId: 'v1', quantity: 1 }],
  createdAt: 't0',
  updatedAt: 't0',
  statusHistory: [{ status: 'pending', timestamp: 't0' }],
});

const ev = (event: OrderCommand) => ({ kind: 'event' as const, event, timestamp: 't' });
// ADR-0024: signals are transport — the registration maps the raw payload to a
// `fulfillmentStatus` COMMAND, which is what the state function receives.
const sig = (update: FulfillmentStatusUpdate) => ({
  kind: 'signal' as const,
  result: { type: 'fulfillmentStatus', update } as OrderCommand,
  timestamp: 't',
});
const timeout = { kind: 'timeout' as const, timestamp: 't' };

/** Capture the external-handle signal fn (the OrderCancelled effect → fulfillment cancel). */
function captureExternalSignal() {
  const signal = vi.fn();
  vi.mocked(getExternalWorkflowHandle).mockReturnValue({ signal, cancel: vi.fn() } as never);
  return signal;
}

beforeEach(() => vi.clearAllMocks());

// ── Intake: pending_assignment → assigning_fulfillers → requesting_fulfillment ──
describe('pending_assignment (transitional)', () => {
  it('is a pure hop to assigning_fulfillers (no ledger in the demo)', async () => {
    const ctx = makeCtx({ status: 'pending_assignment' });
    const out = await OMS_STATES.pending_assignment.fn(ctx, timeout);
    expect(out.next).toBe('assigning_fulfillers');
    expect(out.context).toEqual(ctx);
  });
});

describe('assigning_fulfillers (transitional)', () => {
  it('records resolved assignments and advances to requesting_fulfillment', async () => {
    const out = await OMS_STATES.assigning_fulfillers.fn(
      makeCtx({ status: 'assigning_fulfillers' }),
      timeout,
    );
    expect(out.next).toBe('requesting_fulfillment');
    expect(out.context.assignments).toHaveLength(1);
    expect(out.context.assignments[0]).toMatchObject({
      lineItemId: 'li-1',
      variantId: 'v1',
      fulfillerId: 'simulated',
      status: 'assigned',
      sku: 'SKU-1',
    });
    // IDs come from the prepared payload (generated in prepare, not decide) — with the
    // sandbox uuid4 mocked, the assert is deterministic.
    expect(out.context.assignments[0].assignmentId).toBe('asg-uuid-fix');
    // The prepare adapter snapshots line items with display-field fallbacks (bare
    // CartItems); the snapshot marker is the order's own creation instant.
    const [lineItems] = vi.mocked(resolveFulfillerAssignments).mock.calls[0];
    expect(lineItems[0]).toMatchObject({
      productId: 'unknown',
      productTitle: 'Unknown Product',
      snapshotTimestamp: '2026-01-01T00:00:00Z',
    });
  });

  it('falls back to the manual ready_to_fulfill path when nothing resolves', async () => {
    vi.mocked(resolveFulfillerAssignments).mockResolvedValueOnce([]);
    const out = await OMS_STATES.assigning_fulfillers.fn(
      makeCtx({ status: 'assigning_fulfillers' }),
      timeout,
    );
    expect(out.next).toBe('ready_to_fulfill');
    expect(out.context.assignments).toHaveLength(0);
  });

  it('a resolution activity failure is a rejection (prepare-throw): stay put with the error', async () => {
    vi.mocked(resolveFulfillerAssignments).mockRejectedValueOnce(new Error('resolver down'));
    const out = await OMS_STATES.assigning_fulfillers.fn(
      makeCtx({ status: 'assigning_fulfillers' }),
      timeout,
    );
    expect(out.next).toBe('assigning_fulfillers');
    expect(out.rejected).toBe(true);
    expect(out.error).toMatch(/resolver down/);
  });
});

describe('requesting_fulfillment (transitional)', () => {
  const intakeCtx = () =>
    makeCtx({
      status: 'requesting_fulfillment',
      order: makeOrder({
        items: [
          { lineItemId: 'li-1', variantId: 'v1', quantity: 1, price: 10 },
          { lineItemId: 'li-2', variantId: 'v2', quantity: 2, price: 5 },
        ],
      }),
      assignments: [
        makeAssignment({ assignmentId: 'a-1', fulfillerId: 'f1', sku: 'SKU-1' }),
        makeAssignment({
          assignmentId: 'a-2',
          lineItemId: 'li-2',
          variantId: 'v2',
          fulfillerId: 'f2',
          quantity: 2,
        }),
      ],
    });

  it('groups assignments per fulfiller, starts the fulfillment child, moves to processing', async () => {
    const out = await OMS_STATES.requesting_fulfillment.fn(intakeCtx(), timeout);
    expect(out.next).toBe('processing');
    expect(out.context.status).toBe('processing');
    // One fulfiller order per fulfiller; assignments stamped with their fulfiller order.
    expect(out.context.fulfillerOrders).toHaveLength(2);
    expect(out.context.fulfillerOrders.map((so) => so.status)).toEqual(['pending', 'pending']);
    for (const a of out.context.assignments) {
      // IDs come from the prepared payload (generated per fulfiller in prepare, not
      // decide) — deterministic under the mocked sandbox uuid4.
      expect(a.fulfillerOrderId).toBe('so-uuid-fix');
      expect(a.status).toBe('fulfilled');
    }
    // FulfillmentRequested effect: index each fulfiller order, then start the child
    // (ABANDON so OMS closing never kills an in-flight fulfillment).
    expect(indexFulfillerOrder).toHaveBeenCalledTimes(2);
    expect(startChild).toHaveBeenCalledWith(
      'fulfillmentWorkflow',
      expect.objectContaining({
        workflowId: 'demo.fulfillment.o-1',
        taskQueue: 'fulfillment-queue',
        parentClosePolicy: 'ABANDON',
        searchAttributes: expect.objectContaining({
          OrderId: ['o-1'],
          CartId: ['cart-1'],
          // The journey UUID read from this workflow's own CorrelationId Search
          // Attribute — no longer the cartId.
          CorrelationId: ['corr-1'],
        }),
      }),
    );
    // The request payload prices items from the order lines; sku falls back to variantId.
    // (Cast: vi.mocked resolves startChild's single-arg overload, hiding the options tuple.)
    const [, startOptions] = vi.mocked(startChild).mock.calls[0] as unknown as [
      string,
      { args: [{ fulfillerOrders: Array<{ items: Array<{ sku: string; unitPrice: number }> }> }] },
    ];
    const request = startOptions.args[0];
    expect(request.fulfillerOrders).toHaveLength(2);
    expect(request.fulfillerOrders[0].items[0]).toMatchObject({ sku: 'SKU-1', unitPrice: 10 });
    expect(request.fulfillerOrders[1].items[0]).toMatchObject({ sku: 'v2', unitPrice: 5 });
  });

  it('prices each fulfillment item from its own line when a variant repeats across lines', async () => {
    // Two lines share variantId v1 but differ in lineItemId/price/title — items must be
    // matched by the assignment's lineItemId, not by variantId (which would price both
    // from the first line).
    const ctx = makeCtx({
      status: 'requesting_fulfillment',
      order: makeOrder({
        items: [
          { lineItemId: 'li-1', variantId: 'v1', quantity: 1, price: 10, title: 'Small Print' },
          { lineItemId: 'li-2', variantId: 'v1', quantity: 1, price: 25, title: 'Large Print' },
          // (Cast: `title` lives on the decider's OrderCartItem view of CartItem.)
        ] as unknown as Order['items'],
      }),
      assignments: [
        makeAssignment({ assignmentId: 'a-1', lineItemId: 'li-1' }),
        makeAssignment({ assignmentId: 'a-2', lineItemId: 'li-2' }),
      ],
    });
    const out = await OMS_STATES.requesting_fulfillment.fn(ctx, timeout);
    expect(out.next).toBe('processing');
    const [, startOptions] = vi.mocked(startChild).mock.calls[0] as unknown as [
      string,
      {
        args: [
          {
            fulfillerOrders: Array<{
              items: Array<{ sku: string; unitPrice: number; title: string }>;
            }>;
          },
        ];
      },
    ];
    const request = startOptions.args[0];
    // Same fulfiller → one fulfiller order with both items, each priced from its own line.
    expect(request.fulfillerOrders).toHaveLength(1);
    expect(request.fulfillerOrders[0].items.map((i) => i.unitPrice)).toEqual([10, 25]);
    expect(request.fulfillerOrders[0].items.map((i) => i.title)).toEqual([
      'Small Print',
      'Large Print',
    ]);
  });

  it('zero-price items log the manipulation warning but do not block fulfillment', async () => {
    const ctx = makeCtx({
      status: 'requesting_fulfillment',
      order: makeOrder({ items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 1, price: 0 }] }),
      assignments: [makeAssignment()],
    });
    const out = await OMS_STATES.requesting_fulfillment.fn(ctx, timeout);
    expect(out.next).toBe('processing');
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/zero or negative price/),
      expect.anything(),
    );
    expect(startChild).toHaveBeenCalled();
  });
});

// ── ready_to_fulfill: manual fallback ────────────────────────────────────────
describe('ready_to_fulfill — manual fallback', () => {
  const ctx = () => makeCtx({ status: 'ready_to_fulfill' });

  it('cancelOrder terminates cancelled, notifies the customer, and signals fulfillment', async () => {
    const signal = captureExternalSignal();
    const out = await OMS_STATES.ready_to_fulfill.fn(ctx(), ev({ type: 'cancelOrder' }));
    expect(out.next).toBe(terminal('cancelled'));
    expect(out.context.status).toBe('cancelled');
    expect(sendOrderStatusEmail).toHaveBeenCalledWith('a@b.c', 'o-1', 'cancelled', {});
    expect(getExternalWorkflowHandle).toHaveBeenCalledWith('demo.fulfillment.o-1');
    expect(signal).toHaveBeenCalled();
  });

  it('updateStatus(shipped) routes on OrderShipped and sends the status email', async () => {
    const out = await OMS_STATES.ready_to_fulfill.fn(
      ctx(),
      ev({ type: 'updateStatus', status: 'shipped', updatedBy: 'admin' }),
    );
    expect(out.next).toBe('shipped');
    expect(out.context.status).toBe('shipped');
    expect(sendOrderStatusEmail).toHaveBeenCalledWith('a@b.c', 'o-1', 'shipped', {});
  });

  it('a command the state does not list is REJECTED in place', async () => {
    const out = await OMS_STATES.ready_to_fulfill.fn(ctx(), ev({ type: 'confirmReturn' }));
    expect(out.next).toBe('ready_to_fulfill');
    expect(out.rejected).toBe(true);
    expect(out.error).toMatch(/does not accept command 'confirmReturn'/);
  });

  it('timeout stays put (the order waits indefinitely for the admin)', async () => {
    const out = await OMS_STATES.ready_to_fulfill.fn(ctx(), timeout);
    expect(out.next).toBe('ready_to_fulfill');
  });
});

// ── processing: aggregated fulfillment-status command ────────────────────────
describe('processing — fulfillment-status aggregation', () => {
  it('an update for an unknown fulfiller order emits nothing (stay put)', async () => {
    const ctx = makeCtx({ fulfillerOrders: [makeSO('so-1', 'a-1')] });
    const out = await OMS_STATES.processing.fn(
      ctx,
      sig({ fulfillerOrderId: 'so-unknown', status: 'shipped' }),
    );
    expect(out.next).toBe('processing');
    expect(out.context.fulfillerOrders[0].status).toBe('pending');
  });

  it('one of two shipped aggregates to partially_shipped and stamps the assignment', async () => {
    const ctx = makeCtx({
      assignments: [makeAssignment({ status: 'fulfilled', fulfillerOrderId: 'so-1' })],
      fulfillerOrders: [makeSO('so-1', 'a-1'), makeSO('so-2', 'a-2')],
    });
    const out = await OMS_STATES.processing.fn(
      ctx,
      sig({ fulfillerOrderId: 'so-1', status: 'shipped', carrier: 'USPS', trackingNumber: 'TN1' }),
    );
    expect(out.next).toBe('partially_shipped');
    expect(out.context.fulfillerOrders[0].trackingNumber).toBe('TN1');
    expect(out.context.assignments[0]).toMatchObject({ status: 'shipped', carrier: 'USPS' });
  });

  it('the last fulfiller order shipping aggregates to shipped', async () => {
    const ctx = makeCtx({
      fulfillerOrders: [makeSO('so-1', 'a-1', 'shipped'), makeSO('so-2', 'a-2')],
    });
    const out = await OMS_STATES.processing.fn(
      ctx,
      sig({ fulfillerOrderId: 'so-2', status: 'shipped' }),
    );
    expect(out.next).toBe('shipped');
    expect(out.context.status).toBe('shipped');
  });

  it('all fulfiller orders delivered aggregates to delivered with deliveredAt stamped', async () => {
    const ctx = makeCtx({
      fulfillerOrders: [makeSO('so-1', 'a-1', 'delivered'), makeSO('so-2', 'a-2', 'shipped')],
    });
    const out = await OMS_STATES.processing.fn(
      ctx,
      sig({ fulfillerOrderId: 'so-2', status: 'delivered' }),
    );
    expect(out.next).toBe('delivered');
    expect(out.context.deliveredAt).toBe('t');
  });

  it('updateStatus(cancelled) routes through the OrderCancelled effect (email + fulfillment cancel)', async () => {
    const signal = captureExternalSignal();
    const out = await OMS_STATES.processing.fn(
      makeCtx(),
      ev({ type: 'updateStatus', status: 'cancelled', updatedBy: 'admin' }),
    );
    expect(out.next).toBe(terminal('cancelled'));
    expect(sendOrderStatusEmail).toHaveBeenCalledWith('a@b.c', 'o-1', 'cancelled', {});
    expect(signal).toHaveBeenCalled();
  });

  it('updateStatus with an unforceable status is REJECTED — no transition', async () => {
    const out = await OMS_STATES.processing.fn(
      makeCtx(),
      ev({ type: 'updateStatus', status: 'pending_assignment', updatedBy: 'admin' }),
    );
    expect(out.rejected).toBe(true);
    expect(out.error).toMatch(/Unexpected status/);
    expect(out.next).toBe('processing');
    expect(out.context.status).toBe('processing');
  });

  it('timeout stays put (shipment-tracking states never expire the order)', async () => {
    const out = await OMS_STATES.processing.fn(makeCtx(), timeout);
    expect(out.next).toBe('processing');
  });
});

// ── delivered: post-delivery lifecycle ────────────────────────────────────────
describe('delivered — feedback, refunds, returns', () => {
  const deliveredCtx = (over: Partial<OrderState> = {}) =>
    makeCtx({ status: 'delivered', ...over });

  it('submitFeedback completes the order and sends the thank-you email', async () => {
    const out = await OMS_STATES.delivered.fn(
      deliveredCtx(),
      ev({ type: 'submitFeedback', rating: 5, comment: 'great' }),
    );
    expect(out.next).toBe(terminal('complete'));
    expect(out.context.customerFeedback).toEqual({
      rating: 5,
      comment: 'great',
      submittedAt: 't',
    });
    expect(sendFeedbackThankYouEmail).toHaveBeenCalledWith('a@b.c', 'o-1');
  });

  it('a full refund (no line selection) terminates refunded and notifies', async () => {
    const out = await OMS_STATES.delivered.fn(deliveredCtx(), ev({ type: 'refundOrder' }));
    expect(out.next).toBe(terminal('refunded'));
    expect(out.context.refunds).toHaveLength(1);
    expect(out.context.refunds?.[0]).toMatchObject({ refundAmount: 10, taxAmount: 0.8 });
    expect(sendOrderStatusEmail).toHaveBeenCalledWith('a@b.c', 'o-1', 'refunded', {});
  });

  it('a partial refund stays delivered without the refunded email', async () => {
    const ctx = deliveredCtx({
      order: makeOrder({
        items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 2, price: 10 }],
      }),
    });
    const out = await OMS_STATES.delivered.fn(
      ctx,
      ev({ type: 'refundOrder', lines: [{ lineItemId: 'li-1', quantity: 1 }] }),
    );
    expect(out.next).toBe('delivered');
    expect(out.context.refunds).toHaveLength(1);
    expect(out.context.status).not.toBe('refunded');
    expect(sendOrderStatusEmail).not.toHaveBeenCalled();
  });

  it('refundOrder with an invalid selection is REJECTED before any refund math', async () => {
    const out = await OMS_STATES.delivered.fn(
      deliveredCtx(),
      ev({ type: 'refundOrder', lines: [{ lineItemId: 'nope', quantity: 1 }] }),
    );
    expect(out.rejected).toBe(true);
    expect(out.error).toMatch(/Unknown line item/);
    expect(out.context.refunds).toBeUndefined();
  });

  it('refundOrder when everything is already refunded is REJECTED (nothing left)', async () => {
    const priorRefund: RefundRecord = {
      refundId: 'refund-1',
      timestamp: 't0',
      lines: [{ lineItemId: 'li-1', quantity: 1 }],
      refundAmount: 10,
      taxAmount: 0.8,
    };
    const out = await OMS_STATES.delivered.fn(
      deliveredCtx({ refunds: [priorRefund] }),
      ev({ type: 'refundOrder' }),
    );
    expect(out.rejected).toBe(true);
    expect(out.error).toMatch(/Nothing left to refund/);
  });

  it("updateStatus('refunded') routes through the refund command (records the refund)", async () => {
    const out = await OMS_STATES.delivered.fn(
      deliveredCtx(),
      ev({ type: 'updateStatus', status: 'refunded', updatedBy: 'admin' }),
    );
    expect(out.next).toBe(terminal('refunded'));
    expect(out.context.refunds).toHaveLength(1);
    expect(sendOrderStatusEmail).toHaveBeenCalledWith('a@b.c', 'o-1', 'refunded', {});
  });

  it('requestReturn records the pending request and moves to return_requested', async () => {
    const out = await OMS_STATES.delivered.fn(
      deliveredCtx(),
      ev({ type: 'requestReturn', reason: 'wrong size', updatedBy: 'customer' }),
    );
    expect(out.next).toBe('return_requested');
    expect(out.context.returnRequest).toMatchObject({
      reason: 'wrong size',
      requestedAt: 't',
      requestedBy: 'customer',
    });
  });

  it('a stale fulfillment signal in delivered is REJECTED (state does not accept it)', async () => {
    const out = await OMS_STATES.delivered.fn(
      deliveredCtx(),
      sig({ fulfillerOrderId: 'so-1', status: 'shipped' }),
    );
    expect(out.next).toBe('delivered');
    expect(out.rejected).toBe(true);
    expect(out.error).toMatch(/does not accept command 'fulfillmentStatus'/);
    expect(out.context.status).toBe('delivered');
  });
});

// ── return_requested: confirm / deny ─────────────────────────────────────────
describe('return_requested — confirm / deny', () => {
  const returnCtx = () =>
    makeCtx({
      status: 'return_requested',
      returnRequest: { reason: 'wrong size', requestedAt: 't0', requestedBy: 'customer' },
    });

  it('confirmReturn refunds the requested lines and terminates returned', async () => {
    const out = await OMS_STATES.return_requested.fn(returnCtx(), ev({ type: 'confirmReturn' }));
    expect(out.next).toBe(terminal('returned'));
    expect(out.context.status).toBe('returned');
    expect(out.context.refunds).toHaveLength(1);
    expect(out.context.returnRequest).toBeUndefined();
    expect(sendOrderStatusEmail).toHaveBeenCalledWith('a@b.c', 'o-1', 'returned', {});
  });

  it('denyReturn clears the request and drops back to delivered without email', async () => {
    const out = await OMS_STATES.return_requested.fn(returnCtx(), ev({ type: 'denyReturn' }));
    expect(out.next).toBe('delivered');
    expect(out.context.returnRequest).toBeUndefined();
    expect(sendOrderStatusEmail).not.toHaveBeenCalled();
  });
});
