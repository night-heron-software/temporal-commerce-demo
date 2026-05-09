'use server';

/**
 * Admin Cart Actions
 *
 * Server Actions for listing active cart workflows via Temporal.
 * Lists running cartWorkflow instances and queries each for state.
 */

import { getTemporalClient } from '@/lib';
import { Cart } from '@/temporal/contracts';

export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export interface CartSummary {
  cartId: string;
  workflowId: string;
  status: string;
  itemCount: number;
  totalPrice: number;
  currency: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
  checkout?: {
    step: string;
  };
}

/**
 * List all active carts by querying running cartWorkflow instances.
 */
export async function getActiveCarts(): Promise<ActionResult<CartSummary[]>> {
  try {
    const client = await getTemporalClient();
    const carts: CartSummary[] = [];

    // List running cartWorkflow instances
    for await (const workflow of client.workflow.list({
      query: `WorkflowType = "cartWorkflow" AND ExecutionStatus = "Running"`,
    })) {
      try {
        const handle = client.workflow.getHandle(workflow.workflowId);
        const details: Cart.CartDetails = await handle.query(Cart.getCartQuery);

        carts.push({
          cartId: details.cartId,
          workflowId: workflow.workflowId,
          status: details.status,
          itemCount: details.items.length,
          totalPrice: details.totalPrice,
          currency: details.currency,
          userId: details.userId,
          createdAt: details.createdAt,
          updatedAt: details.updatedAt,
          checkout: details.checkout ? { step: details.checkout.step } : undefined,
        });
      } catch {
        // Workflow may have completed between list and query — skip
      }
    }

    // Sort by updatedAt desc (most recently active first)
    carts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return { success: true, data: carts };
  } catch (e) {
    console.error('Failed to list active carts:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error: `Failed to load carts: ${message}` };
  }
}

/**
 * Get full cart details for a specific cart.
 */
export async function getCartDetails(cartId: string): Promise<ActionResult<Cart.CartDetails>> {
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(`cart-${cartId}`);
    const details = await handle.query(Cart.getCartQuery);
    return { success: true, data: details };
  } catch (e) {
    console.error('Failed to get cart details:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    const isNotFound = message.includes('not found') || message.includes('NOT_FOUND');
    return {
      success: false,
      error: isNotFound ? `Cart not found: ${cartId}` : `Failed to get cart: ${message}`,
    };
  }
}
