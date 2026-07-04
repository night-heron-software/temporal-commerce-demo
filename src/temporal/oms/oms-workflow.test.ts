/**
 * Workflow-level tests — the real `runStateMachine` driver in a time-skipping Temporal
 * test environment via {@link withWorkflowEnv}, with the I/O activities mocked.
 *
 * The decider units are covered in oms-decider.test.ts; these exercise the full intake
 * pipeline (pending_assignment → assigning_fulfillers → requesting_fulfillment →
 * processing), the fulfillment-status signal aggregation through
 * shipped → delivered, the post-delivery lifecycle (feedback → complete,
 * refund → refunded), and the admin cancel path.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { withWorkflowEnv } from '../../test-support/workflow-env';
import { OMS_TASK_QUEUE, buildWorkflowStartOptions, DEMO_STORE_ID } from '../contracts/constants';
import { orderWorkflow } from './workflows';
import {
  getOrderStateQuery,
  cancelOrderUpdate,
  submitFeedbackUpdate,
  refundOrderUpdate,
  fulfillmentStatusSignal,
} from './definitions';
import type { OrderWorkflowInput } from './types';
import type { Cart } from '../contracts';

const WORKFLOWS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflows.ts');

const order: Cart.Order = {
  orderId: 'o-test-1',
  cartId: 'cart-1',
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
};

function makeActivities() {
  return {
    saveOrderToDatabase: vi.fn(async () => undefined),
    updateOrderInDatabase: vi.fn(async () => undefined),
    sendOrderStatusEmail: vi.fn(async () => undefined),
    sendFeedbackThankYouEmail: vi.fn(async () => undefined),
    resolveFulfillerAssignments: vi.fn(async () =>
      order.items.map(() => ({
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
}

const input: OrderWorkflowInput = { order, customerEmail: order.customerEmail };

const startOpts = () => ({
  taskQueue: OMS_TASK_QUEUE,
  ...buildWorkflowStartOptions({
    storeId: DEMO_STORE_ID,
    domain: 'order',
    entityId: `o-${Math.random().toString(36).slice(2, 10)}`,
    orderId: order.orderId,
    cartId: order.cartId,
  }),
  args: [input] as [OrderWorkflowInput],
});

describe('orderWorkflow (Temporal test env)', () => {
  it('runs the intake pipeline, aggregates fulfillment to delivered, and completes on feedback', async () => {
    const activities = makeActivities();
    await withWorkflowEnv(
      [{ taskQueue: OMS_TASK_QUEUE, workflowsPath: WORKFLOWS_PATH, activities }],
      async (env) => {
        const handle = await env.client.workflow.start(orderWorkflow, startOpts());

        // Intake: pending_assignment → assigning_fulfillers → requesting_fulfillment →
        // processing (transitional states + the startFulfillment finalize / startChild).
        await vi.waitFor(async () => {
          const state = await handle.query(getOrderStateQuery);
          expect(state.status).toBe('processing');
        });
        expect(activities.saveOrderToDatabase).toHaveBeenCalled();
        expect(activities.resolveFulfillerAssignments).toHaveBeenCalled();

        const state = await handle.query(getOrderStateQuery);
        expect(state.fulfillerOrders).toHaveLength(1);
        const fulfillerOrderId = state.fulfillerOrders[0].fulfillerOrderId;
        expect(state.assignments[0].fulfillerOrderId).toBe(fulfillerOrderId);

        // Fulfillment reports shipped → the order aggregates to the shipped state.
        await handle.signal(fulfillmentStatusSignal, {
          fulfillerOrderId,
          status: 'shipped',
          carrier: 'Simulated Carrier',
          trackingNumber: 'SIM1',
        });
        await vi.waitFor(async () => {
          const s = await handle.query(getOrderStateQuery);
          expect(s.status).toBe('shipped');
        });

        // Delivered is a STATE now (post-delivery lifecycle), not a terminal.
        await handle.signal(fulfillmentStatusSignal, { fulfillerOrderId, status: 'delivered' });
        await vi.waitFor(async () => {
          const s = await handle.query(getOrderStateQuery);
          expect(s.status).toBe('delivered');
          expect(s.deliveredAt).toBeTruthy();
        });

        // Customer feedback finishes the order as complete.
        const fed = await handle.executeUpdate(submitFeedbackUpdate, {
          args: [{ rating: 5, comment: 'great' }],
        });
        expect(fed.status).toBe('complete');

        const result = await handle.result();
        expect(result.status).toBe('complete');
        expect(result.customerFeedback?.rating).toBe(5);
        expect(result.statusHistory.map((h) => h.status)).toEqual(
          expect.arrayContaining(['shipped', 'delivered', 'complete']),
        );
        expect(activities.sendFeedbackThankYouEmail).toHaveBeenCalledWith('a@b.c', 'o-test-1');
      },
    );
  }, 120_000);

  it('refunds a delivered order to terminal refunded', async () => {
    const activities = makeActivities();
    await withWorkflowEnv(
      [{ taskQueue: OMS_TASK_QUEUE, workflowsPath: WORKFLOWS_PATH, activities }],
      async (env) => {
        const handle = await env.client.workflow.start(orderWorkflow, startOpts());

        await vi.waitFor(async () => {
          const s = await handle.query(getOrderStateQuery);
          expect(s.status).toBe('processing');
        });
        const { fulfillerOrders } = await handle.query(getOrderStateQuery);
        await handle.signal(fulfillmentStatusSignal, {
          fulfillerOrderId: fulfillerOrders[0].fulfillerOrderId,
          status: 'delivered',
        });
        await vi.waitFor(async () => {
          const s = await handle.query(getOrderStateQuery);
          expect(s.status).toBe('delivered');
        });

        // Full refund (no line selection) → terminal refunded with a refund record.
        const refunded = await handle.executeUpdate(refundOrderUpdate, {
          args: [{ reason: 'customer request' }],
        });
        expect(refunded.status).toBe('refunded');
        expect(refunded.refunds).toHaveLength(1);
        expect(refunded.refunds![0].refundAmount).toBe(10);

        const result = await handle.result();
        expect(result.status).toBe('refunded');
      },
    );
  }, 120_000);

  it('cancelOrder terminates the order and cascades the fulfillment cancel', async () => {
    const activities = makeActivities();
    await withWorkflowEnv(
      [{ taskQueue: OMS_TASK_QUEUE, workflowsPath: WORKFLOWS_PATH, activities }],
      async (env) => {
        const handle = await env.client.workflow.start(orderWorkflow, startOpts());

        await vi.waitFor(async () => {
          const state = await handle.query(getOrderStateQuery);
          expect(state.status).toBe('processing');
        });

        const cancelled = await handle.executeUpdate(cancelOrderUpdate, {
          args: [{ reason: 'test cancel' }],
        });
        expect(cancelled.status).toBe('cancelled');

        const result = await handle.result();
        expect(result.status).toBe('cancelled');
        expect(result.statusHistory.at(-1)).toMatchObject({
          status: 'cancelled',
          note: 'test cancel',
        });
        expect(activities.sendOrderStatusEmail).toHaveBeenCalledWith(
          'a@b.c',
          'o-test-1',
          'cancelled',
          {},
        );
      },
    );
  }, 120_000);
});
