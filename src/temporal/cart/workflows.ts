import { defineSignal, getExternalWorkflowHandle, log, setHandler } from '@temporalio/workflow';
import { releaseCartItem, indexCart } from './activities';
import { buildCartDocument } from './document-builder';
import type {
  CartDetails,
  CartEvent,
  CartUpdateResponse,
  CartInboundSignal,
  CartStateName,
  CartWorkflowContext,
} from './types';

import {
  cartUpdate,
  checkoutCompletedSignal,
  getCartQuery,
  getCheckoutStateQuery,
  getCheckoutWorkflowIdQuery,
  getUserIdQuery,
} from './definitions';

import { runStateMachine, StateMachineConfig, deriveDisplayStatus } from '../framework';
import { ES_INDICES } from '../contracts/elasticsearch';

import { CART_STATES } from './states';

// Re-export definitions for worker registration compatibility
export {
  cartUpdate,
  checkoutCompletedSignal,
  getCartQuery,
  getCheckoutStateQuery,
  getCheckoutWorkflowIdQuery,
  getUserIdQuery,
};

const CONTINUE_AS_NEW_THRESHOLD = 100;

// Outbound nudge to the checkout child when the cart changes during checkout.
// Defined locally with the same name the checkout workflow listens on.
const recomputeSignal = defineSignal<[{ cartVersion: number }]>('recompute');
const ITEM_EDIT_EVENTS = ['addItem', 'updateQuantity', 'removeItem', 'applyCoupon'];

interface CartWorkflowInput {
  cartId: string;
  initialCart?: CartDetails;
  createdAt?: string;
  updateCount?: number;
  checkoutWorkflowId?: string;
  checkoutInProgress?: boolean;
  checkoutVersion?: number;
  submitting?: boolean;
}

/** Bump version/timestamps on a cart and sync the ES projection. `at` is the driver-supplied
 * deterministic transition time (never read the clock in state-machine hooks). */
async function flushCart(cart: CartDetails, at: string): Promise<CartDetails> {
  const updated: CartDetails = {
    ...cart,
    cartVersion: (cart.cartVersion || 0) + 1,
    updatedAt: at,
  };

  await indexCart(buildCartDocument(updated, updated.createdAt));
  return updated;
}

export async function cartWorkflow(input: CartWorkflowInput): Promise<CartDetails> {
  const {
    cartId,
    initialCart,
    createdAt: inputCreatedAt,
    checkoutWorkflowId: inputCheckoutWfId,
    checkoutInProgress: inputCheckoutInProgress,
    checkoutVersion: inputCheckoutVersion,
    submitting: inputSubmitting,
  } = input;

  const now = new Date().toISOString();

  // ── State Machine Context ──
  let workflowContext: CartWorkflowContext = {
    cart: initialCart || {
      cartId,
      items: [],
      subtotalPrice: 0,
      totalDiscounts: 0,
      totalTax: 0,
      totalPrice: 0,
      shippingCost: 0,
      currency: 'USD',
      appliedCoupons: [],
      cartVersion: 0,
      status: 'active',
      checkout: undefined,
      createdAt: inputCreatedAt || now,
      updatedAt: now,
    },
    checkoutWorkflowId: inputCheckoutWfId || null,
    checkoutVersion: inputCheckoutVersion || 0,
    submitting: inputSubmitting,
  };

  // ── Track current status (single source of truth: the driver's state) ──
  let currentStatus = (inputCheckoutInProgress ? 'checkout' : 'active') as CartDetails['status'];

  // Query Handlers — synthesize status from driver state
  setHandler(getCartQuery, () => ({ ...workflowContext.cart, status: currentStatus }));
  setHandler(getCheckoutStateQuery, () => workflowContext.cart.checkout || null);
  setHandler(getCheckoutWorkflowIdQuery, () => workflowContext.checkoutWorkflowId);
  setHandler(getUserIdQuery, () => workflowContext.cart.userId);

  // ── State Machine Run ──
  const config: StateMachineConfig<
    CartStateName,
    CartEvent,
    CartWorkflowContext,
    CartUpdateResponse,
    CartInboundSignal
  > = {
    states: CART_STATES,
    initialState: inputCheckoutInProgress ? 'checkout' : 'active',
    onContextUpdate: (newCtx, state) => {
      workflowContext = newCtx;
      currentStatus = deriveDisplayStatus<CartDetails['status']>(state);
    },
    onTransition: async (from, to, event, currentCtx, at) => {
      const flushedCart = await flushCart(currentCtx.cart, at);
      workflowContext.cart = flushedCart;

      // Cart edited mid-checkout → nudge the checkout child to recompute. The nudge is
      // a trigger only (carries the new cartVersion); checkout re-pulls via queryCart.
      // Emptying the cart routes to terminal (not 'checkout'), where onTerminal cancels
      // the child instead — so no nudge there.
      const isItemEdit =
        typeof event === 'object' && event !== null && ITEM_EDIT_EVENTS.includes(event.type);
      if (to === 'checkout' && currentCtx.checkoutWorkflowId && isItemEdit) {
        try {
          const handle = getExternalWorkflowHandle(currentCtx.checkoutWorkflowId);
          await handle.signal(recomputeSignal, { cartVersion: flushedCart.cartVersion });
        } catch (e) {
          log.warn('Failed to send recompute nudge to checkout child', { error: String(e) });
        }
      }
    },
    continueAsNewThreshold: CONTINUE_AS_NEW_THRESHOLD,
    serializeForContinueAsNew: (currentCtx, currentState) => {
      return {
        cartId,
        initialCart: currentCtx.cart,
        createdAt: currentCtx.cart.createdAt,
        updateCount: 0,
        checkoutWorkflowId: currentCtx.checkoutWorkflowId ?? undefined,
        checkoutInProgress: currentState === 'checkout',
        checkoutVersion: currentCtx.checkoutVersion,
        submitting: currentCtx.submitting,
      };
    },
    onCancellation: async (cancelCtx) => {
      log.info('Cart workflow cancelled via Temporal cancellation', { cartId });
      if (cancelCtx.checkoutWorkflowId) {
        try {
          const checkoutHandle = getExternalWorkflowHandle(cancelCtx.checkoutWorkflowId);
          await checkoutHandle.cancel();
        } catch (error) {
          log.error('Failed to cancel checkout workflow during cart cancellation', {
            cartId,
            checkoutWorkflowId: cancelCtx.checkoutWorkflowId,
            error: String(error),
          });
        }
      }
      for (const item of cancelCtx.cart.items) {
        await releaseCartItem(cartId, item.variantId);
      }
      cancelCtx.cart.status = 'abandoned';
      await indexCart(buildCartDocument(cancelCtx.cart, cancelCtx.cart.createdAt));
    },
    onTerminal: async (finalCtx) => {
      if (finalCtx.checkoutWorkflowId) {
        try {
          const checkoutHandle = getExternalWorkflowHandle(finalCtx.checkoutWorkflowId);
          await checkoutHandle.cancel();
        } catch (error) {
          log.error('Failed to cancel checkout workflow', {
            cartId,
            checkoutWorkflowId: finalCtx.checkoutWorkflowId,
            error: String(error),
          });
        }
      }
      await indexCart(buildCartDocument(finalCtx.cart, finalCtx.cart.createdAt));
    },
    projections: {
      refs: () => [{ index: ES_INDICES.carts, id: cartId }],
    },
  };

  workflowContext = await runStateMachine<
    CartStateName,
    CartEvent,
    CartWorkflowContext,
    CartUpdateResponse,
    CartInboundSignal
  >(config, workflowContext, cartUpdate, checkoutCompletedSignal);

  return workflowContext.cart;
}
