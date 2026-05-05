'use server';

/**
 * Cart Server Actions — Demo version
 * 
 * Simplified: no auth, cookie-only cart ID.
 * Uses Temporal updateWithStart for lazy cart creation.
 */

import { cookies } from 'next/headers';
import { v4 as uuidv4 } from 'uuid';
import { getTemporalClient } from '@/lib/temporal-client';
import { Cart, Checkout, Constants } from '@/temporal/contracts';

const CART_ID_COOKIE = 'cartId';

// Re-export types for client components
export type CartDetails = Cart.CartDetails;
export type CheckoutState = Cart.CheckoutState;

/**
 * Get or create a cart ID from cookie.
 */
export async function getOrCreateCartId(): Promise<string> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(CART_ID_COOKIE)?.value;
  if (existing) return existing;

  const cartId = uuidv4();
  cookieStore.set(CART_ID_COOKIE, cartId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60,
    path: '/'
  });
  return cartId;
}

/**
 * Get the current cart ID (cookie only).
 */
export async function getCartId(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(CART_ID_COOKIE)?.value || null;
}

/**
 * Unified wrapper for Temporal cart updates with error handling.
 */
async function executeCartUpdate<TReturn, TArgs extends any[]>(
  cartId: string,
  updateDef: any,
  args: TArgs,
  options: { createIfMissing?: boolean } = {}
): Promise<TReturn | null> {
  const client = await getTemporalClient();
  const workflowId = `cart-${cartId}`;

  try {
    if (options.createIfMissing) {
      // Use updateWithStart to lazily create the workflow
      const { WithStartWorkflowOperation } = await import('@temporalio/client');
      const startOp = new WithStartWorkflowOperation('cartWorkflow', {
        workflowId,
        args: [{ cartId }],
        taskQueue: Constants.CART_TASK_QUEUE,
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowExecutionTimeout: '30 days',
        workflowTaskTimeout: '2m'
      });
      return await client.workflow.executeUpdateWithStart(updateDef, {
        startWorkflowOperation: startOp,
        args: args as any
      });
    } else {
      const handle = client.workflow.getHandle(workflowId);
      return await handle.executeUpdate(updateDef, { args: args as any });
    }
  } catch (e) {
    const error = e as { name?: string; cause?: { type?: string } };
    if (
      error?.name === 'WorkflowNotFoundError' ||
      error?.cause?.type === 'AcceptedUpdateCompletedWorkflow'
    ) {
      return null;
    }
    throw e;
  }
}

/**
 * Unified wrapper for checkout workflow updates.
 */
async function executeCheckoutUpdate<TReturn, TArgs extends any[]>(
  checkoutWorkflowId: string,
  updateDef: any,
  args: TArgs
): Promise<TReturn | null> {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(checkoutWorkflowId);
  try {
    return await handle.executeUpdate(updateDef, { args: args as any });
  } catch (e) {
    const error = e as { name?: string; cause?: { type?: string } };
    if (
      error?.name === 'WorkflowNotFoundError' ||
      error?.cause?.type === 'AcceptedUpdateCompletedWorkflow'
    ) {
      return null;
    }
    throw e;
  }
}

/**
 * Get cart details by querying the workflow.
 */
export async function getCart(cartId: string): Promise<Cart.CartDetails | null> {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(`cart-${cartId}`);
  try {
    return await handle.query(Cart.getCartQuery);
  } catch (e: unknown) {
    const err = e as { name?: string };
    if (err?.name === 'WorkflowNotFoundError') {
      console.info(`[getCart] Cart workflow not found for ${cartId}`);
    } else {
      console.error('Failed to get cart', e);
    }
    return null;
  }
}

/**
 * Add an item to the cart (creates cart workflow if needed).
 */
export async function addItemToCart(
  cartId: string,
  variantId: string,
  quantity: number,
  price: number
): Promise<Cart.CartDetails | null> {
  return executeCartUpdate(
    cartId,
    Cart.addItemToCartUpdate,
    [{ variantId, quantity, price }],
    { createIfMissing: true }
  );
}

export async function removeFromCart(
  cartId: string,
  lineItemId: string
): Promise<Cart.CartDetails | null> {
  return executeCartUpdate(cartId, Cart.removeItemUpdate, [{ lineItemId }]);
}

export async function updateItemQuantity(
  cartId: string,
  lineItemId: string,
  quantity: number
): Promise<Cart.CartDetails | null> {
  return executeCartUpdate(cartId, Cart.updateQuantityUpdate, [{ lineItemId, quantity }]);
}

// ==================
// Checkout Flow
// ==================

export async function beginCheckout(cartId: string): Promise<Cart.CartDetails | null> {
  return executeCartUpdate(cartId, Cart.beginCheckoutUpdate, [{}]);
}

export async function getCheckoutWorkflowId(cartId: string): Promise<string | null> {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(`cart-${cartId}`);
  try {
    return await handle.query(Cart.getCheckoutWorkflowIdQuery);
  } catch {
    return null;
  }
}

export async function setShippingAddress(
  cartId: string,
  shippingAddress: Cart.ShippingAddress
): Promise<Cart.CheckoutState | null> {
  let checkoutWfId = await getCheckoutWorkflowId(cartId);

  if (!checkoutWfId) {
    await beginCheckout(cartId);
    checkoutWfId = await getCheckoutWorkflowId(cartId);
    if (!checkoutWfId) return null;
  }

  let state = await executeCheckoutUpdate(checkoutWfId, Checkout.setShippingUpdate, [{ shippingAddress }]) as Cart.CheckoutState | null;

  // Recovery: if checkout workflow was dead, start a fresh one
  if (state === null) {
    await beginCheckout(cartId);
    const newId = await getCheckoutWorkflowId(cartId);
    if (newId) {
      state = await executeCheckoutUpdate(newId, Checkout.setShippingUpdate, [{ shippingAddress }]) as Cart.CheckoutState | null;
    }
  }

  return state;
}

export async function setPaymentMethod(
  cartId: string,
  paymentMethod: Cart.PaymentMethod
): Promise<Cart.CheckoutState | null> {
  const checkoutWfId = await getCheckoutWorkflowId(cartId);
  if (!checkoutWfId) return null;
  return executeCheckoutUpdate(checkoutWfId, Checkout.setPaymentUpdate, [{ paymentMethod }]) as Promise<Cart.CheckoutState | null>;
}

export async function submitOrder(cartId: string): Promise<Cart.CheckoutState | null> {
  const checkoutWfId = await getCheckoutWorkflowId(cartId);
  if (!checkoutWfId) return null;
  const state = await executeCheckoutUpdate(checkoutWfId, Checkout.submitOrderUpdate, [{}]) as Cart.CheckoutState | null;

  if (state?.step === 'complete') {
    const cookieStore = await cookies();
    cookieStore.delete(CART_ID_COOKIE);
  }

  return state;
}

export async function cancelCheckout(cartId: string): Promise<Cart.CheckoutState | null> {
  const checkoutWfId = await getCheckoutWorkflowId(cartId);
  if (!checkoutWfId) return null;
  return executeCheckoutUpdate(checkoutWfId, Checkout.cancelCheckoutUpdate, [{}]) as Promise<Cart.CheckoutState | null>;
}

export async function getCheckoutState(cartId: string): Promise<Cart.CheckoutState | null> {
  const checkoutWfId = await getCheckoutWorkflowId(cartId);
  if (checkoutWfId) {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(checkoutWfId);
    try {
      return await handle.query(Checkout.getCheckoutStateQuery);
    } catch {
      // fall through
    }
  }
  try {
    const client = await getTemporalClient();
    const cartHandle = client.workflow.getHandle(`cart-${cartId}`);
    return await cartHandle.query(Cart.getCheckoutStateQuery);
  } catch {
    return null;
  }
}

export async function acknowledgeCartChange(
  cartId: string,
  cartVersion: number
): Promise<Cart.CheckoutState | null> {
  const checkoutWfId = await getCheckoutWorkflowId(cartId);
  if (!checkoutWfId) return null;
  return executeCheckoutUpdate(checkoutWfId, Checkout.acknowledgeCartChangeUpdate, [{ cartVersion }]) as Promise<Cart.CheckoutState | null>;
}

/**
 * Legacy simple checkout (used by CartContext).
 */
export async function checkout(cartId: string): Promise<Cart.CartDetails | null> {
  return executeCartUpdate(cartId, Cart.checkoutUpdate, [{ checkoutUrl: '/checkout' }]);
}
