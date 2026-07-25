/**
 * Workflow-level tests — the real `runStateMachine` driver in a time-skipping Temporal
 * test environment via {@link withWorkflowEnv}, with the I/O activities mocked.
 *
 * The decider units are covered in checkout-decider.test.ts / states.test.ts; these
 * exercise the driver, the mapped update handlers, terminal transitions, and activity
 * wiring across the full shipping → payment → review → submit flow.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { withWorkflowEnv } from '../../test-support/workflow-env';
import {
  CHECKOUT_TASK_QUEUE,
  buildWorkflowStartOptions,
  DEMO_STORE_ID,
} from '../contracts/constants';
import { checkoutWorkflow } from './workflows';
import {
  setShippingUpdate,
  setPaymentUpdate,
  submitOrderUpdate,
  cancelCheckoutUpdate,
  getCheckoutStateQuery,
} from './definitions';
import type { CheckoutWorkflowInput, Order } from './types';

const WORKFLOWS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflows.ts');

const order: Order = {
  orderId: 'o-1',
  cartId: 'cart-1',
  correlationId: 'corr-1',
  customerEmail: 'a@b.c',
  items: [],
  shippingAddress: {} as Order['shippingAddress'],
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
    // The live-cart bridge: validating and each recompute/submit re-pull go through here.
    queryCart: vi.fn(async () => ({
      items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 1, price: 10 }],
      subtotalPrice: 10,
      totalDiscounts: 0,
      appliedCoupons: [],
      cartVersion: 1,
    })),
    renewReservationsForCheckout: vi.fn(async () => ({
      success: true,
      reservations: [{ reservationId: 'r-1', variantId: 'v1', blankSku: 'SKU-1', quantity: 1 }],
    })),
    calculateShipping: vi.fn(async () => 5),
    calculateTax: vi.fn(async () => 0.8),
    createPaymentIntent: vi.fn(async () => ({ clientSecret: 'cs_1', id: 'pi_1' })),
    verifyPayment: vi.fn(async () => true),
    processPayment: vi.fn(async () => true),
    createOrder: vi.fn(async () => order),
    sendConfirmationEmail: vi.fn(async () => undefined),
    startOrderManagementWorkflow: vi.fn(async () => 'demo.order.o-1'),
    confirmReservations: vi.fn(async () => ({ unavailable: [] })),
    refundPayment: vi.fn(async () => true),
    releaseReservations: vi.fn(async () => undefined),
    cancelReservations: vi.fn(async () => undefined),
  };
}

// No item snapshot — contents come from the (mocked) queryCart activity.
const input: CheckoutWorkflowInput = {
  cartId: 'cart-1',
  parentCartWorkflowId: 'demo.cart.cart-1', // parent doesn't exist in the test env; signal failure is tolerated
  currency: 'USD',
  isGuest: true,
  cartVersion: 1,
  checkoutVersion: 1,
};

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

const startOpts = () => ({
  taskQueue: CHECKOUT_TASK_QUEUE,
  ...buildWorkflowStartOptions({
    storeId: DEMO_STORE_ID,
    domain: 'checkout',
    entityId: `co-${Math.random().toString(36).slice(2, 10)}`,
    correlationId: `corr-${input.cartId}`,
    cartId: input.cartId,
  }),
  args: [input] as [CheckoutWorkflowInput],
});

describe('checkoutWorkflow (Temporal test env)', () => {
  it('drives shipping → payment → review → submit to terminal complete', async () => {
    const activities = makeActivities();
    await withWorkflowEnv(
      [{ taskQueue: CHECKOUT_TASK_QUEUE, workflowsPath: WORKFLOWS_PATH, activities }],
      async (env) => {
        const handle = await env.client.workflow.start(checkoutWorkflow, startOpts());

        const afterShipping = await handle.executeUpdate(setShippingUpdate, {
          args: [{ shippingAddress: address }],
        });
        expect(afterShipping.step).toBe('payment');
        expect(afterShipping.clientSecret).toBe('cs_1');

        const afterPayment = await handle.executeUpdate(setPaymentUpdate, {
          args: [{ paymentMethod: { type: 'mock', token: 'tok_1' } }],
        });
        expect(afterPayment.step).toBe('review');

        const afterSubmit = await handle.executeUpdate(submitOrderUpdate, { args: [{}] });
        expect(afterSubmit.step).toBe('complete');
        expect(afterSubmit.order?.orderId).toBe('o-1');

        const result = await handle.result();
        expect(result.success).toBe(true);
        expect(result.finalStep).toBe('complete');
        expect(activities.processPayment).toHaveBeenCalled();
        expect(activities.confirmReservations).toHaveBeenCalled();
        expect(activities.startOrderManagementWorkflow).toHaveBeenCalledWith(order, 'a@b.c');
      },
    );
  }, 120_000);

  it('rejects a premature submit with the prerequisites error (step stays derived)', async () => {
    const activities = makeActivities();
    await withWorkflowEnv(
      [{ taskQueue: CHECKOUT_TASK_QUEUE, workflowsPath: WORKFLOWS_PATH, activities }],
      async (env) => {
        const handle = await env.client.workflow.start(checkoutWorkflow, startOpts());

        // submitOrder while prerequisites are missing → formatted error response; the
        // single `collecting` state derives the step from what's set (nothing yet → shipping)
        const rejected = await handle.executeUpdate(submitOrderUpdate, { args: [{}] });
        expect(rejected.error).toMatch(/shipping and payment required/i);
        expect(rejected.step).toBe('shipping');
        expect(activities.processPayment).not.toHaveBeenCalled();

        await handle.terminate('test complete');
      },
    );
  }, 120_000);

  it('cancelCheckout releases reservations and completes as cancelled', async () => {
    const activities = makeActivities();
    await withWorkflowEnv(
      [{ taskQueue: CHECKOUT_TASK_QUEUE, workflowsPath: WORKFLOWS_PATH, activities }],
      async (env) => {
        const handle = await env.client.workflow.start(checkoutWorkflow, startOpts());

        await handle.executeUpdate(setShippingUpdate, { args: [{ shippingAddress: address }] });
        const cancelled = await handle.executeUpdate(cancelCheckoutUpdate, { args: [{}] });
        expect(cancelled.step).toBe('cancelled');

        const result = await handle.result();
        expect(result.cancelled).toBe(true);
        expect(activities.releaseReservations).toHaveBeenCalled();

        // Terminal workflows keep serving queries with the final step
        const state = await handle.query(getCheckoutStateQuery);
        expect(state.step).toBe('cancelled');
      },
    );
  }, 120_000);
});
