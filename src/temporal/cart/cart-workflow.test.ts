/**
 * Workflow-level tests — the real `runStateMachine` driver in a time-skipping Temporal
 * test environment, via the shared {@link withWorkflowEnv} harness.
 *
 * The decider units are covered in cart-decider.test.ts / states.test.ts; these exercise
 * the driver, the `cartUpdate` update handler, the `getCart` query, terminal transitions,
 * and activity wiring — with the I/O activities mocked.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withWorkflowEnv } from '../../test-support/workflow-env';
import { CART_TASK_QUEUE, buildWorkflowStartOptions, DEMO_STORE_ID } from '../contracts/constants';
import { cartWorkflow } from './workflows';
import { cartUpdate, getCartQuery } from './definitions';

// Absolute path to the workflow source for the worker bundler (require.resolve doesn't resolve
// under vitest's transform).
const WORKFLOWS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflows.ts');

// Activities are worker-only I/O; mock them so the tests assert orchestration, not persistence.
const activities = {
  validateInventory: async () => true,
  reserveCartItem: async () => 'reservation-1',
  releaseCartItem: async () => undefined,
  indexCart: async () => undefined,
  deleteCart: async () => undefined,
};

const cartWorker = { taskQueue: CART_TASK_QUEUE, workflowsPath: WORKFLOWS_PATH, activities };

const startOpts = (cartId: string) => ({
  taskQueue: CART_TASK_QUEUE,
  ...buildWorkflowStartOptions({ storeId: DEMO_STORE_ID, domain: 'cart', entityId: cartId, cartId }),
  args: [{ cartId }] as [{ cartId: string }],
});

describe('cartWorkflow (Temporal test env)', () => {
  it('adds an item via cartUpdate and reflects it in getCart', async () => {
    await withWorkflowEnv([cartWorker], async (env) => {
      const handle = await env.client.workflow.start(cartWorkflow, startOpts('cart-harness-1'));

      const res = await handle.executeUpdate(cartUpdate, {
        args: [{ type: 'addItem', variantId: 'v1', quantity: 2, price: 22.99 }],
      });
      expect(res && res.items).toHaveLength(1);

      const cart = await handle.query(getCartQuery);
      expect(cart.items[0]).toMatchObject({ variantId: 'v1', quantity: 2 });
      expect(cart.subtotalPrice).toBeCloseTo(45.98);

      await handle.terminate('test complete');
    });
  }, 120_000);

  it('evolves state across multiple updates (add, merge-quantity, remove → abandoned)', async () => {
    await withWorkflowEnv([cartWorker], async (env) => {
      const handle = await env.client.workflow.start(cartWorkflow, startOpts('cart-harness-2'));

      await handle.executeUpdate(cartUpdate, {
        args: [{ type: 'addItem', variantId: 'v1', quantity: 1, price: 10 }],
      });
      // Same variant again → quantity merges rather than duplicating the line.
      const merged = await handle.executeUpdate(cartUpdate, {
        args: [{ type: 'addItem', variantId: 'v1', quantity: 2, price: 10 }],
      });
      expect(merged && merged.items).toHaveLength(1);
      expect(merged!.items[0].quantity).toBe(3);
      expect(merged!.subtotalPrice).toBe(30);

      // Removing the only line abandons the cart → terminal → the workflow run completes.
      const removed = await handle.executeUpdate(cartUpdate, {
        args: [{ type: 'removeItem', lineItemId: merged!.items[0].lineItemId }],
      });
      expect(removed && removed.items).toHaveLength(0);

      const result = await handle.result();
      expect(result.status).toBe('abandoned');
    });
  }, 120_000);

  it('auto-abandons after the active-state idle timeout (time-skip)', async () => {
    await withWorkflowEnv([cartWorker], async (env) => {
      const handle = await env.client.workflow.start(cartWorkflow, startOpts('cart-harness-timeout'));

      // The 'active' state has a 30-day idle onTimeout that routes to terminal('abandoned').
      // The time-skipping env fast-forwards the timer, so awaiting the result advances
      // virtual time to completion without a real 30-day wait.
      const result = await handle.result();
      expect(result.status).toBe('abandoned');
    });
  }, 120_000);
});
