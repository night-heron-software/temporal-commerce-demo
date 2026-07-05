/**
 * Cross-domain order journey — cart → checkout → OMS → fulfillment → fulfiller child —
 * driven end-to-end in one time-skipping Temporal test environment with a worker per
 * domain task queue.
 *
 * Everything between workflows is REAL: the cart→checkout child start, the live-cart
 * pricing bridge (queryCart runs a real Temporal query against the cart), the
 * checkout→cart completion signal, the OMS→fulfillment child start, the fulfiller-order
 * child simulation timers, and the fulfillment→OMS status signals. Only the I/O edges
 * (Cassandra/ES/email/payment) are mocked.
 *
 * Two checkout activities are reimplemented against the test env instead of mocked,
 * because their production implementations dial TEMPORAL_ADDRESS directly:
 * `queryCart` and `startOrderManagementWorkflow` (mirroring checkout/activities-impl.ts).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { withWorkflowEnv } from '../test-support/workflow-env';
import {
  CART_TASK_QUEUE,
  CHECKOUT_TASK_QUEUE,
  OMS_TASK_QUEUE,
  FULFILLMENT_TASK_QUEUE,
  buildWorkflowId,
  buildWorkflowStartOptions,
  DEMO_STORE_ID,
} from './contracts/constants';
import { cartWorkflow } from './cart/workflows';
import { cartUpdate, getCartQuery, getCheckoutWorkflowIdQuery } from './cart/definitions';
import {
  setShippingUpdate,
  setPaymentUpdate,
  submitOrderUpdate,
  getCheckoutStateQuery,
} from './checkout/definitions';
import type { CreateOrderInput } from './checkout/activities';
import type { Order } from './checkout/types';
import { getOrderStateQuery, submitFeedbackUpdate } from './oms/definitions';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CART_ID = 'cart-e2e-1';
const ORDER_ID = 'o-e2e-1';

const WAIT = { timeout: 30_000 } as const;

// The bridged activities are built before the env exists; they read it at call time.
const envRef: { env?: TestWorkflowEnvironment } = {};

const cartActivities = {
  validateInventory: vi.fn(async () => true),
  reserveCartItem: vi.fn(async () => 'r-e2e-1'),
  releaseCartItem: vi.fn(async () => undefined),
  indexCart: vi.fn(async () => undefined),
  deleteCart: vi.fn(async () => undefined),
};

const checkoutActivities = {
  // REAL live-cart bridge: query the actual cart workflow through the test env's client,
  // exactly as the production activity does through its own Temporal client.
  queryCart: vi.fn(async (parentCartWorkflowId: string) => {
    const cart = await envRef
      .env!.client.workflow.getHandle(parentCartWorkflowId)
      .query(getCartQuery);
    return {
      items: cart.items,
      subtotalPrice: cart.subtotalPrice,
      totalDiscounts: cart.totalDiscounts,
      appliedCoupons: cart.appliedCoupons,
      cartVersion: cart.cartVersion,
    };
  }),
  renewReservationsForCheckout: vi.fn(async () => ({
    success: true,
    reservations: [{ reservationId: 'r-e2e-1', variantId: 'v1', blankSku: 'SKU-1', quantity: 2 }],
  })),
  calculateShipping: vi.fn(async () => 5),
  calculateTax: vi.fn(async () => 1.6),
  createPaymentIntent: vi.fn(async () => ({ clientSecret: 'cs_e2e', id: 'pi_e2e' })),
  verifyPayment: vi.fn(async () => true),
  processPayment: vi.fn(async () => true),
  // Deterministic order ID so every downstream workflow ID is known in advance;
  // totals pass through from the checkout's real pricing of the live cart.
  createOrder: vi.fn(
    async (input: CreateOrderInput): Promise<Order> => ({
      orderId: ORDER_ID,
      cartId: input.cartId,
      customerEmail: input.shippingAddress.email,
      items: input.items,
      shippingAddress: input.shippingAddress,
      paymentMethod: input.paymentMethod,
      subtotal: input.subtotal,
      shippingCost: input.shippingCost,
      tax: input.tax,
      totalDiscounts: input.totalDiscounts,
      total: input.total,
      currency: input.currency,
      status: 'paid',
      createdAt: '2026-01-01T00:00:00Z',
      confirmationNumber: 'E2E12345',
    }),
  ),
  sendConfirmationEmail: vi.fn(async () => undefined),
  // REAL OMS start through the test env's client (production dials its own client).
  startOrderManagementWorkflow: vi.fn(async (order: Order, customerEmail: string) => {
    const startOptions = buildWorkflowStartOptions({
      storeId: DEMO_STORE_ID,
      domain: 'order',
      entityId: order.orderId,
      orderId: order.orderId,
      cartId: order.cartId,
    });
    await envRef.env!.client.workflow.start('orderWorkflow', {
      ...startOptions,
      taskQueue: OMS_TASK_QUEUE,
      args: [{ order, customerEmail }],
    });
    return startOptions.workflowId;
  }),
  confirmReservations: vi.fn(async () => undefined),
  releaseReservations: vi.fn(async () => undefined),
  cancelReservations: vi.fn(async () => undefined),
};

const omsActivities = {
  saveOrderToDatabase: vi.fn(async () => undefined),
  updateOrderInDatabase: vi.fn(async () => undefined),
  sendOrderStatusEmail: vi.fn(async () => undefined),
  sendFeedbackThankYouEmail: vi.fn(async () => undefined),
  resolveFulfillerAssignments: vi.fn(async (items: unknown[]) =>
    items.map(() => ({
      fulfillerId: 'simulated',
      fulfillerName: 'Simulated',
      fulfillerType: 'simulated',
    })),
  ),
  insertStatusHistoryEntry: vi.fn(async () => undefined),
  getOrdersByEmail: vi.fn(async () => []),
  getOrderById: vi.fn(async () => null),
  indexOrder: vi.fn(async () => undefined),
  indexFulfillerOrder: vi.fn(async () => undefined),
  indexCustomer: vi.fn(async () => undefined),
};

const fulfillmentActivities = {
  getFeatureFlag: vi.fn(async () => false), // automatic (timer-driven) fulfillment
  submitFulfillerOrder: vi.fn(async () => ({ success: true, fulfillerOrderId: 'SIM-E2E-1' })),
  sendShippedEmail: vi.fn(async () => undefined),
  sendDeliveredEmail: vi.fn(async () => undefined),
  transferInventoryReservations: vi.fn(async () => undefined),
  fulfillInventoryReservations: vi.fn(async () => undefined),
  releaseInventoryReservations: vi.fn(async () => undefined),
  indexFulfillment: vi.fn(async () => undefined),
  indexShipment: vi.fn(async () => undefined),
};

const workers = [
  {
    taskQueue: CART_TASK_QUEUE,
    workflowsPath: path.join(HERE, 'cart', 'workflows.ts'),
    activities: cartActivities,
  },
  {
    taskQueue: CHECKOUT_TASK_QUEUE,
    workflowsPath: path.join(HERE, 'checkout', 'workflows.ts'),
    activities: checkoutActivities,
  },
  {
    taskQueue: OMS_TASK_QUEUE,
    workflowsPath: path.join(HERE, 'oms', 'workflows.ts'),
    activities: omsActivities,
  },
  {
    // fulfillerOrderWorkflow is re-exported from fulfillment/workflows.ts, so this one
    // worker runs the fulfillment parent and its fulfiller-order children.
    taskQueue: FULFILLMENT_TASK_QUEUE,
    workflowsPath: path.join(HERE, 'fulfillment', 'workflows.ts'),
    activities: fulfillmentActivities,
  },
];

const address = {
  firstName: 'A',
  lastName: 'B',
  address1: '1 Main St',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62701',
  country: 'US',
  email: 'a@b.c',
};

describe('order journey (cart → checkout → OMS → fulfillment, Temporal test env)', () => {
  it('completes the full customer journey with real cross-workflow orchestration', async () => {
    await withWorkflowEnv(workers, async (env) => {
      envRef.env = env;

      // 1. Cart: add 2 × $10.
      const cartHandle = await env.client.workflow.start(cartWorkflow, {
        taskQueue: CART_TASK_QUEUE,
        // The ID must be demo.cart.<cartId>: beginCheckout derives the parent workflow
        // ID for the checkout child via buildWorkflowId.
        ...buildWorkflowStartOptions({
          storeId: DEMO_STORE_ID,
          domain: 'cart',
          entityId: CART_ID,
          cartId: CART_ID,
        }),
        args: [{ cartId: CART_ID }],
      });
      const cart = await cartHandle.executeUpdate(cartUpdate, {
        args: [{ type: 'addItem', variantId: 'v1', quantity: 2, price: 10 }],
      });
      expect(cart?.items).toHaveLength(1);

      // 2. Begin checkout → the cart starts a REAL checkout child on the checkout queue.
      const inCheckout = await cartHandle.executeUpdate(cartUpdate, {
        args: [{ type: 'beginCheckout' }],
      });
      expect(inCheckout?.status).toBe('checkout');

      const checkoutWorkflowId = await vi.waitFor(async () => {
        const id = await cartHandle.query(getCheckoutWorkflowIdQuery);
        expect(id).toBeTruthy();
        return id!;
      }, WAIT);
      const checkoutHandle = env.client.workflow.getHandle(checkoutWorkflowId);

      // The checkout validates first (real queryCart against the live cart), then waits
      // for the shipping address — same readiness the storefront polls for.
      await vi.waitFor(async () => {
        const state = await checkoutHandle.query(getCheckoutStateQuery);
        expect(state.step).toBe('shipping');
      }, WAIT);

      // 3. Shipping → payment → review → submit.
      const afterShipping = await checkoutHandle.executeUpdate(setShippingUpdate, {
        args: [{ shippingAddress: address }],
      });
      expect(afterShipping.step).toBe('payment');
      expect(afterShipping.clientSecret).toBe('cs_e2e');

      const afterPayment = await checkoutHandle.executeUpdate(setPaymentUpdate, {
        args: [{ paymentMethod: { type: 'mock', token: 'tok_e2e' } }],
      });
      expect(afterPayment.step).toBe('review');

      const afterSubmit = await checkoutHandle.executeUpdate(submitOrderUpdate, { args: [{}] });
      expect(afterSubmit.step).toBe('complete');
      expect(afterSubmit.order?.orderId).toBe(ORDER_ID);
      // Subtotal 20 proves checkout priced the LIVE cart (2 × $10) via the real
      // queryCart bridge rather than any snapshot.
      expect(afterSubmit.order?.subtotal).toBe(20);

      // 4. The bridged activity started the REAL OMS workflow; intake runs to processing
      //    and starts the fulfillment child.
      const omsHandle = env.client.workflow.getHandle(
        buildWorkflowId(DEMO_STORE_ID, 'order', ORDER_ID),
      );
      await vi.waitFor(async () => {
        const state = await omsHandle.query(getOrderStateQuery);
        expect(state.status).toBe('processing');
        expect(state.fulfillerOrders).toHaveLength(1);
      }, WAIT);

      // 5. Await the fulfillment workflow result — this unlocks time-skipping so the
      //    fulfiller child's simulation timers fast-forward through
      //    in_production → shipped → delivered, signalling OMS along the way.
      const fulfillmentResult = await env.client.workflow
        .getHandle(buildWorkflowId(DEMO_STORE_ID, 'fulfillment', ORDER_ID))
        .result();
      expect(fulfillmentResult.status).toBe('delivered');

      await vi.waitFor(async () => {
        const state = await omsHandle.query(getOrderStateQuery);
        expect(state.status).toBe('delivered');
        expect(state.deliveredAt).toBeTruthy();
      }, WAIT);

      // 6. Customer feedback closes the order.
      const fed = await omsHandle.executeUpdate(submitFeedbackUpdate, {
        args: [{ rating: 5, comment: 'flawless' }],
      });
      expect(fed.status).toBe('complete');

      const omsResult = await omsHandle.result();
      expect(omsResult.status).toBe('complete');
      expect(omsResult.statusHistory.map((h: { status: string }) => h.status)).toEqual(
        expect.arrayContaining(['shipped', 'delivered', 'complete']),
      );

      // 7. Upstream terminals: the checkout completed, and its REAL checkoutCompleted
      //    signal drove the cart to its completed terminal.
      const checkoutResult = await checkoutHandle.result();
      expect(checkoutResult.success).toBe(true);
      expect(checkoutResult.finalStep).toBe('complete');

      const cartResult = await cartHandle.result();
      expect(cartResult.status).toBe('completed');

      // 8. Cross-domain side effects all fired.
      expect(checkoutActivities.queryCart).toHaveBeenCalledWith(
        buildWorkflowId(DEMO_STORE_ID, 'cart', CART_ID),
      );
      expect(checkoutActivities.confirmReservations).toHaveBeenCalled();
      expect(omsActivities.saveOrderToDatabase).toHaveBeenCalled();
      expect(fulfillmentActivities.transferInventoryReservations).toHaveBeenCalled();
      expect(fulfillmentActivities.submitFulfillerOrder).toHaveBeenCalled();
      expect(fulfillmentActivities.fulfillInventoryReservations).toHaveBeenCalled();
    });
  }, 180_000);
});
