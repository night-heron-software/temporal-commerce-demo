import {
  allHandlersFinished,
  condition,
  continueAsNew,
  getExternalWorkflowHandle,
  log,
  setHandler,
} from '@temporalio/workflow';
import { releaseCartItem, indexCart } from './activities';
import { buildCartDocument } from './document-builder';
import type {
  CartDetails,
  CartEvent,
  CartUpdateResponse,
  CheckoutWorkflowResult,
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

import {
  runStateMachine,
  StateMachineConfig,
} from '../framework';

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

interface CartWorkflowInput {
  cartId: string;
  initialCart?: CartDetails;
  createdAt?: string;
  updateCount?: number;
  checkoutWorkflowId?: string;
  checkoutInProgress?: boolean;
  checkoutVersion?: number;
  currentState?: 'active' | 'awaitingCheckout';
}

/** Bump version/timestamps on a cart and sync the ES projection. */
async function flushCart(cart: CartDetails): Promise<CartDetails> {
  const updated: CartDetails = {
    ...cart,
    cartVersion: (cart.cartVersion || 0) + 1,
    updatedAt: new Date().toISOString(),
  };

  await indexCart(buildCartDocument(updated, updated.createdAt));
  return updated;
}

export async function cartWorkflow(input: CartWorkflowInput | string): Promise<CartDetails> {
  const {
    cartId,
    initialCart,
    createdAt: inputCreatedAt,
    checkoutWorkflowId: inputCheckoutWfId,
    checkoutInProgress: inputCheckoutInProgress,
    checkoutVersion: inputCheckoutVersion,
    currentState: legacyStateName,
  } = typeof input === 'string'
    ? {
        cartId: input,
        initialCart: undefined,
        createdAt: undefined,
        checkoutWorkflowId: null,
        checkoutInProgress: false,
        checkoutVersion: 0,
        currentState: undefined,
      }
    : input;

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
  };

  // ── Track current status (single source of truth: the driver's state) ──
  let currentStatus = ((inputCheckoutInProgress || legacyStateName === 'awaitingCheckout') ? 'checkout' : 'active') as CartDetails['status'];

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
    CheckoutWorkflowResult
  > = {
    states: CART_STATES,
    initialState: (inputCheckoutInProgress || legacyStateName === 'awaitingCheckout') ? 'checkout' : 'active',
    onContextUpdate: (newCtx: CartWorkflowContext, state: CartStateName | `__terminal:${string}`) => {
      workflowContext = newCtx;
      currentStatus = (typeof state === 'string' && state.startsWith('__terminal:')
        ? state.replace('__terminal:', '')
        : state) as CartDetails['status'];
    },
    onTransition: async (from: CartStateName, to: CartStateName | `__terminal:${string}`, event: CartEvent | 'timeout' | 'signal', currentCtx: CartWorkflowContext) => {
      const flushedCart = await flushCart(currentCtx.cart);
      workflowContext.cart = flushedCart;
    },
    continueAsNewThreshold: CONTINUE_AS_NEW_THRESHOLD,
    serializeForContinueAsNew: (currentCtx: CartWorkflowContext, currentState: CartStateName) => {
      return {
        cartId,
        initialCart: currentCtx.cart,
        createdAt: currentCtx.cart.createdAt,
        updateCount: 0,
        checkoutWorkflowId: currentCtx.checkoutWorkflowId ?? undefined,
        checkoutInProgress: currentState === 'checkout',
        checkoutVersion: currentCtx.checkoutVersion,
      };
    },
    onCancellation: async (cancelCtx: CartWorkflowContext) => {
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
    onTerminal: async (finalCtx: CartWorkflowContext) => {
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
  };

  workflowContext = await runStateMachine<
    CartStateName,
    CartEvent,
    CartWorkflowContext,
    CartUpdateResponse,
    CheckoutWorkflowResult
  >(config, workflowContext, cartUpdate, checkoutCompletedSignal);

  return workflowContext.cart;
}
