/**
 * Workflow-level tests — parent fulfillment + supplier-order child on one task queue in a
 * time-skipping Temporal test environment via {@link withWorkflowEnv}, activities mocked.
 *
 * Exercises the timer-driven simulation end-to-end: received → submitting →
 * in_production → shipped → delivered on the child, aggregated to terminal:delivered on
 * the parent (the child inherits the parent's task queue, so one worker runs both).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { withWorkflowEnv } from '../../test-support/workflow-env';
import {
  FULFILLMENT_TASK_QUEUE,
  buildWorkflowStartOptions,
  DEMO_STORE_ID,
} from '../contracts/constants';
import { fulfillmentWorkflow } from './workflows';
import type { FulfillmentOrderRequest } from './types';

const WORKFLOWS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflows.ts');

function makeActivities() {
  return {
    getFeatureFlag: vi.fn(async () => false), // automatic (timer-driven) fulfillment
    submitSupplierOrder: vi.fn(async () => ({ success: true, supplierOrderId: 'SIM-1' })),
    sendShippedEmail: vi.fn(async () => undefined),
    sendDeliveredEmail: vi.fn(async () => undefined),
    transferInventoryReservations: vi.fn(async () => undefined),
    fulfillInventoryReservations: vi.fn(async () => undefined),
    releaseInventoryReservations: vi.fn(async () => undefined),
    indexFulfillment: vi.fn(async () => undefined),
    indexShipment: vi.fn(async () => undefined),
  };
}

const orderId = 'o-fulfil-1';

const request: FulfillmentOrderRequest = {
  orderId,
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
  supplierOrders: [
    {
      supplierOrderId: 'so-test-1',
      supplierId: 'simulated',
      supplierType: 'simulated',
      items: [
        { sku: 'SKU-1', productId: 'p1', variantId: 'v1', quantity: 2, unitPrice: 10, title: 'T' },
      ],
    },
  ],
};

describe('fulfillmentWorkflow (Temporal test env)', () => {
  it('auto-progresses parent + supplier child to delivered via time-skipped timers', async () => {
    const activities = makeActivities();
    await withWorkflowEnv(
      [{ taskQueue: FULFILLMENT_TASK_QUEUE, workflowsPath: WORKFLOWS_PATH, activities }],
      async (env) => {
        const handle = await env.client.workflow.start(fulfillmentWorkflow, {
          taskQueue: FULFILLMENT_TASK_QUEUE,
          // Deterministic ID: the supplier child signals its parent via
          // buildWorkflowId(DEMO_STORE_ID, 'fulfillment', orderId).
          ...buildWorkflowStartOptions({
            storeId: DEMO_STORE_ID,
            domain: 'fulfillment',
            entityId: orderId,
            orderId,
            cartId: request.cartId,
          }),
          args: [request],
        });

        // The 15s+15s+15s simulation timers are fast-forwarded by the time-skipping env.
        const result = await handle.result();
        expect(result.status).toBe('delivered');
        expect(result.supplierOrders).toHaveLength(1);
        expect(result.supplierOrders[0].status).toBe('delivered');

        // Full pipeline side effects fired
        expect(activities.transferInventoryReservations).toHaveBeenCalled();
        expect(activities.submitSupplierOrder).toHaveBeenCalled();
        expect(activities.sendShippedEmail).toHaveBeenCalled();
        expect(activities.sendDeliveredEmail).toHaveBeenCalled();
        expect(activities.fulfillInventoryReservations).toHaveBeenCalled();
      },
    );
  }, 120_000);
});
