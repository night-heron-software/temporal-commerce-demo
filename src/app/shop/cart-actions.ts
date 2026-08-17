'use server';

/**
 * Cart Server Actions — Demo version
 *
 * Simplified: no auth, cookie-only cart ID.
 * Uses Temporal updateWithStart for lazy cart creation.
 */

import { cookies } from 'next/headers';
import { randomUUID } from 'crypto';
import { createLogger } from '@/lib/logger';
import { getTemporalClient } from '@/lib/temporal-client';
import { resolveVariantDisplay } from '@/lib/variant-display';
import { Cart, Checkout, Constants } from '@/temporal/contracts';
import {
  buildWorkflowId,
  buildWorkflowStartOptions,
  DEMO_STORE_ID,
} from '@/temporal/contracts/constants';
import { domainErrorOf, domainMessageOf } from './cart-actions-outcome';

const log = createLogger('cart-actions');

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

  const cartId = randomUUID();
  cookieStore.set(CART_ID_COOKIE, cartId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60,
    path: '/',
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
 * Why a workflow update produced no result: the workflow is gone (never started /
 * timed out / terminated) vs. it already reached a terminal state and no longer
 * accepts updates. Distinguished so recovery paths can log what actually happened
 * instead of collapsing both into a silent `null`.
 */
type UpdateFailureReason = 'workflow-not-found' | 'workflow-already-completed';

type UpdateOutcome<T> = { ok: true; value: T } | { ok: false; reason: UpdateFailureReason };

function classifyUpdateError(e: unknown): UpdateFailureReason | null {
  const error = e as { name?: string; cause?: { type?: string } };
  if (error?.name === 'WorkflowNotFoundError') return 'workflow-not-found';
  if (error?.cause?.type === 'AcceptedUpdateCompletedWorkflow') return 'workflow-already-completed';
  return null;
}

/**
 * Unified wrapper for Temporal cart updates with error handling.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Temporal SDK executeUpdate overloads require any */
export async function executeCartUpdate<TReturn, TArgs extends any[]>(
  cartId: string,
  updateDef: any,
  args: TArgs,
  options: { createIfMissing?: boolean } = {},
): Promise<TReturn | null> {
  const client = await getTemporalClient();
  const workflowId = buildWorkflowId(DEMO_STORE_ID, 'cart', cartId);
  // R6 (backlog #6): one entry line + one exit line per mutating action, correlation-
  // tagged (post-R5 the correlationId IS the cartId), so a shopper journey is
  // reconstructable from demo-web.log alone. Every cart mutation funnels through here;
  // the command's own type is the action name. No payloads.
  const command = (args[0] as { type?: string } | undefined)?.type ?? updateDef?.name;
  log.info({ correlationId: cartId, cartId, command }, 'cart action start');

  try {
    let result: TReturn | null;
    if (options.createIfMissing) {
      // Use updateWithStart to lazily create the workflow.
      // The correlationId IS the cartId (remediation R5, decided 2026-08-11 — the
      // mono's ADR-0022 one-lifecycle-id property): one id retrieves everything a cart
      // ever did, across every run and checkout. The per-run UUID mint this replaces
      // gave the same cart a different correlation id on every revival, so no single
      // query returned a cart's history (run -006 F9). Every downstream workflow start
      // still reads the value from its parent's CorrelationId Search Attribute; when
      // the cart workflow already exists (USE_EXISTING), the existing workflow's value
      // stays authoritative — which is now the same value by construction.
      const correlationId = cartId;
      const { WithStartWorkflowOperation } = await import('@temporalio/client');
      const startOp = new WithStartWorkflowOperation('cartWorkflow', {
        ...buildWorkflowStartOptions({
          storeId: DEMO_STORE_ID,
          domain: 'cart',
          entityId: cartId,
          correlationId,
          cartId,
        }),
        args: [{ cartId }],
        taskQueue: Constants.CART_TASK_QUEUE,
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowExecutionTimeout: '30 days',
        workflowTaskTimeout: '2m',
      });
      result = await client.workflow.executeUpdateWithStart(updateDef, {
        startWorkflowOperation: startOp,
        args: args as unknown as [any, ...any[]],
      });
    } else {
      const handle = client.workflow.getHandle(workflowId);
      result = await handle.executeUpdate(updateDef, { args: args as unknown as [any, ...any[]] });
    }
    const domainError = domainErrorOf(result);
    if (domainError) {
      // NOT `ok: true`. The transport succeeded; the domain refused (mono #242 — its run 013
      // logged a clean journey around a triple charge because this line couldn't tell).
      log.warn(
        { correlationId: cartId, cartId, command, ok: false, domainError },
        'cart action reported a domain failure',
      );
    } else {
      log.info({ correlationId: cartId, cartId, command, ok: true }, 'cart action done');
    }
    return result;
  } catch (e) {
    const reason = classifyUpdateError(e);
    if (reason) {
      log.info({ correlationId: cartId, cartId, command, ok: false, reason }, 'cart action done');
      return null;
    }
    const domainReason = domainMessageOf(e);
    log.warn(
      { correlationId: cartId, cartId, command, err: domainReason ?? (e as Error).message },
      'cart action failed',
    );
    // Re-throw carrying the DOMAIN's sentence so the UI can show it instead of guessing.
    if (domainReason) throw new Error(domainReason, { cause: e });
    throw e;
  }
}

/**
 * Checkout workflow update with a discriminated outcome — callers that recover
 * (e.g. setShippingAddress restarting a dead checkout) can see WHY it failed.
 */
async function runCheckoutUpdate<TReturn, TArgs extends any[]>(
  checkoutWorkflowId: string,
  updateDef: any,
  args: TArgs,
): Promise<UpdateOutcome<TReturn>> {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(checkoutWorkflowId);
  // R6: every checkout mutation funnels through here; the update's wire name is the
  // action. The checkout workflow id carries the checkoutId — the journey join key
  // (correlationId = cartId) is on the caller's cart lines.
  const action = updateDef?.name ?? 'checkoutUpdate';
  log.info({ checkoutWorkflowId, action }, 'checkout action start');
  try {
    const value = await handle.executeUpdate(updateDef, {
      args: args as unknown as [any, ...any[]],
    });
    const domainError = domainErrorOf(value);
    if (domainError) {
      log.warn(
        { checkoutWorkflowId, action, ok: false, domainError },
        'checkout action reported a domain failure',
      );
    } else {
      log.info({ checkoutWorkflowId, action, ok: true }, 'checkout action done');
    }
    return { ok: true, value: value as TReturn };
  } catch (e) {
    const reason = classifyUpdateError(e);
    if (reason) {
      log.info({ checkoutWorkflowId, action, ok: false, reason }, 'checkout action done');
      return { ok: false, reason };
    }
    const domainReason = domainMessageOf(e);
    log.warn(
      { checkoutWorkflowId, action, err: domainReason ?? (e as Error).message },
      'checkout action failed',
    );
    if (domainReason) throw new Error(domainReason, { cause: e });
    throw e;
  }
}

/** Unified wrapper for checkout workflow updates (null on any tolerated failure). */
async function executeCheckoutUpdate<TReturn, TArgs extends any[]>(
  checkoutWorkflowId: string,
  updateDef: any,
  args: TArgs,
): Promise<TReturn | null> {
  const outcome = await runCheckoutUpdate<TReturn, TArgs>(checkoutWorkflowId, updateDef, args);
  return outcome.ok ? outcome.value : null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Get cart details by querying the workflow.
 */
export async function getCart(cartId: string): Promise<Cart.CartDetails | null> {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(buildWorkflowId(DEMO_STORE_ID, 'cart', cartId));
  try {
    return await handle.query(Cart.getCartQuery);
  } catch (e: unknown) {
    const err = e as { name?: string };
    if (err?.name === 'WorkflowNotFoundError') {
      log.info({ cartId }, 'Cart workflow not found');
    } else {
      log.error({ cartId, err: e }, 'Failed to get cart');
    }
    return null;
  }
}

/**
 * Add an item to the cart (creates cart workflow if needed). The display snapshot is
 * resolved server-side here (backlog #1 / remediation R1) — the client is not trusted
 * for what the shopper bought; a failed resolution adds the line without a snapshot and
 * the UI falls back to the variantId.
 */
export async function addItemToCart(
  cartId: string,
  variantId: string,
  quantity: number,
  price: number,
): Promise<Cart.CartDetails | null> {
  const display = await resolveVariantDisplay(variantId);
  return executeCartUpdate(
    cartId,
    Cart.cartUpdate,
    [{ type: 'addItem' as const, variantId, quantity, price, ...(display ?? {}) }],
    { createIfMissing: true },
  );
}

export async function removeFromCart(
  cartId: string,
  lineItemId: string,
): Promise<Cart.CartDetails | null> {
  return executeCartUpdate(cartId, Cart.cartUpdate, [{ type: 'removeItem' as const, lineItemId }]);
}

export async function updateItemQuantity(
  cartId: string,
  lineItemId: string,
  quantity: number,
): Promise<Cart.CartDetails | null> {
  return executeCartUpdate(cartId, Cart.cartUpdate, [
    { type: 'updateQuantity' as const, lineItemId, quantity },
  ]);
}

// ==================
// Checkout Flow
// ==================

export async function beginCheckout(cartId: string): Promise<Cart.CartDetails | null> {
  return executeCartUpdate(cartId, Cart.cartUpdate, [{ type: 'beginCheckout' as const }]);
}

export async function getCheckoutWorkflowId(cartId: string): Promise<string | null> {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(buildWorkflowId(DEMO_STORE_ID, 'cart', cartId));
  try {
    return await handle.query(Cart.getCheckoutWorkflowIdQuery);
  } catch {
    return null;
  }
}

export async function setShippingAddress(
  cartId: string,
  shippingAddress: Cart.ShippingAddress,
): Promise<Cart.CheckoutState | null> {
  let checkoutWfId = await getCheckoutWorkflowId(cartId);

  if (!checkoutWfId) {
    await beginCheckout(cartId);
    checkoutWfId = await getCheckoutWorkflowId(cartId);
    if (!checkoutWfId) return null;
  }

  const outcome = await runCheckoutUpdate<
    Cart.CheckoutState,
    [{ shippingAddress: Cart.ShippingAddress }]
  >(checkoutWfId, Checkout.setShippingUpdate, [{ shippingAddress }]);
  if (outcome.ok) return outcome.value;

  // Recovery: the checkout workflow was dead (timed out / terminated / already
  // completed) — start a fresh attempt and retry the update against it.
  log.info(
    { checkoutWorkflowId: checkoutWfId, reason: outcome.reason },
    'Checkout unavailable; starting a fresh checkout',
  );
  await beginCheckout(cartId);
  const newId = await getCheckoutWorkflowId(cartId);
  if (!newId) return null;
  return executeCheckoutUpdate(newId, Checkout.setShippingUpdate, [
    { shippingAddress },
  ]) as Promise<Cart.CheckoutState | null>;
}

export async function setPaymentMethod(
  cartId: string,
  paymentMethod: Cart.PaymentMethod,
): Promise<Cart.CheckoutState | null> {
  const checkoutWfId = await getCheckoutWorkflowId(cartId);
  if (!checkoutWfId) return null;
  return executeCheckoutUpdate(checkoutWfId, Checkout.setPaymentUpdate, [
    { paymentMethod },
  ]) as Promise<Cart.CheckoutState | null>;
}

export async function submitOrder(cartId: string): Promise<Cart.CheckoutState | null> {
  const checkoutWfId = await getCheckoutWorkflowId(cartId);
  if (!checkoutWfId) return null;
  const state = (await executeCheckoutUpdate(checkoutWfId, Checkout.submitOrderUpdate, [
    {},
  ])) as Cart.CheckoutState | null;

  if (state?.step === 'complete') {
    const cookieStore = await cookies();
    cookieStore.delete(CART_ID_COOKIE);
  }

  return state;
}

export async function cancelCheckout(cartId: string): Promise<Cart.CheckoutState | null> {
  const checkoutWfId = await getCheckoutWorkflowId(cartId);
  if (!checkoutWfId) return null;
  return executeCheckoutUpdate(checkoutWfId, Checkout.cancelCheckoutUpdate, [
    {},
  ]) as Promise<Cart.CheckoutState | null>;
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
    const cartHandle = client.workflow.getHandle(buildWorkflowId(DEMO_STORE_ID, 'cart', cartId));
    return await cartHandle.query(Cart.getCheckoutStateQuery);
  } catch {
    return null;
  }
}

export async function acknowledgeCartChange(
  cartId: string,
  cartVersion: number,
): Promise<Cart.CheckoutState | null> {
  const checkoutWfId = await getCheckoutWorkflowId(cartId);
  if (!checkoutWfId) return null;
  return executeCheckoutUpdate(checkoutWfId, Checkout.acknowledgeCartChangeUpdate, [
    { cartVersion },
  ]) as Promise<Cart.CheckoutState | null>;
}
