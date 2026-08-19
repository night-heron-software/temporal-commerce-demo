import { getExternalWorkflowHandle, log, setHandler } from '@temporalio/workflow';
import { releaseCartItem, indexCart } from './activities';
import { buildCartDocument } from './document-builder';
import type {
  CartCommand,
  CartDetails,
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

import {
  runStateMachine,
  StateMachineConfig,
  SignalRegistration,
  deriveDisplayStatus,
} from '../framework';
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
  // ADR-0024: the checkout child's inbound signal is transport — the registration maps
  // its discriminated payload to COMMANDS, the machine's single input vocabulary.
  const signals: SignalRegistration<CartCommand>[] = [
    {
      definition: checkoutCompletedSignal,
      toSignal: (payload: CartInboundSignal): CartCommand =>
        payload.kind === 'completed'
          ? { type: 'checkoutCompleted', result: payload.result }
          : payload.kind === 'submitStarted'
            ? { type: 'submitStarted' }
            : { type: 'submitAborted' },
    },
  ];

  const config: StateMachineConfig<
    CartStateName,
    CartCommand,
    CartWorkflowContext,
    CartUpdateResponse,
    CartCommand
  > = {
    states: CART_STATES,
    initialState: inputCheckoutInProgress ? 'checkout' : 'active',
    onContextUpdate: (newCtx, state) => {
      workflowContext = newCtx;
      currentStatus = deriveDisplayStatus<CartDetails['status']>(state);
    },
    onTransition: async (_from, _to, _event, currentCtx) => {
      // Projection only: evolve already stamped version/timestamps, and the mid-checkout
      // recompute nudge is an event-keyed EFFECT in states.ts. Rejected inputs never
      // reach this hook (ADR-0024), so a refused edit no longer bumps or projects.
      await indexCart(buildCartDocument(currentCtx.cart, currentCtx.cart.createdAt));
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
    CartCommand,
    CartWorkflowContext,
    CartUpdateResponse,
    CartCommand
  >(config, workflowContext, cartUpdate, signals);

  return workflowContext.cart;
}
