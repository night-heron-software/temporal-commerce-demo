import { defineSignal, getExternalWorkflowHandle, log, setHandler } from '@temporalio/workflow';
import { releaseReservations } from './activities';
import type {
  CheckoutState,
  CheckoutWorkflowInput,
  CheckoutWorkflowResult,
  CheckoutContext,
  CheckoutInput,
  CheckoutStateName,
  CheckoutStep,
  RecomputeSignal,
  SetShippingSignal,
  SetPaymentSignal,
  SubmitOrderSignal,
  RetargetParentSignal,
} from './types';

import {
  setShippingUpdate,
  setPaymentUpdate,
  submitOrderUpdate,
  cancelCheckoutUpdate,
  acknowledgeCartChangeUpdate,
  retargetParentUpdate,
  getCheckoutStateQuery,
} from './definitions';

import {
  runStateMachine,
  StateMachineConfig,
  MappedUpdateRegistration,
  deriveDisplayStatus,
  isTerminal,
} from '../framework';
import { CHECKOUT_STATES, cartInboundSignal } from './states';

/**
 * Inbound nudge from the parent cart: items changed mid-checkout, re-pull and re-price.
 * Local definition (wire name 'recompute') — the cart sends it by name, no import cycle.
 */
const recomputeSignal = defineSignal<[RecomputeSignal]>('recompute');

// Re-export definitions for worker registration compatibility
export {
  setShippingUpdate,
  setPaymentUpdate,
  submitOrderUpdate,
  cancelCheckoutUpdate,
  acknowledgeCartChangeUpdate,
  retargetParentUpdate,
  getCheckoutStateQuery,
};

/**
 * Derive the UI step from prerequisites (the single `collecting` state has no
 * per-step machine state). shipping → payment → review.
 */
function deriveStep(state: CheckoutState): CheckoutStep {
  if (!state.shippingAddress) return 'shipping';
  if (!state.paymentMethod) return 'payment';
  return 'review';
}

export async function checkoutWorkflow(
  input: CheckoutWorkflowInput,
): Promise<CheckoutWorkflowResult> {
  // ── Initialize context ──
  // No cart-content snapshot in the input: items/pricing are seeded empty and folded in
  // at `validating`, where the live cart is pulled via the queryCart activity.
  let ctx: CheckoutContext = {
    cartId: input.cartId,
    parentCartWorkflowId: input.parentCartWorkflowId,
    items: [],
    subtotalPrice: 0,
    totalDiscounts: 0,
    currency: input.currency,
    appliedCoupons: [],
    isGuest: input.isGuest,
    cartVersion: input.cartVersion,
    checkoutVersion: input.checkoutVersion || 0,
    state: {
      step: 'validating',
      isGuest: input.isGuest,
      shippingCost: 0,
      tax: 0,
      cartVersionAtStart: input.cartVersion,
      cartVersionAcknowledged: input.cartVersion,
    },
    reservations: [],
    shippingCost: 0,
    totalTax: 0,
    totalPrice: 0,
  };

  // ── Track current step (single source of truth: the driver's state) ──
  let currentStep = 'validating' as CheckoutStep;

  // Query handler (read-only) — returns state with computed step
  setHandler(getCheckoutStateQuery, () => ({ ...ctx.state, step: currentStep }));

  // ── State machine run ──
  const config: StateMachineConfig<
    CheckoutStateName,
    CheckoutInput,
    CheckoutContext,
    CheckoutState | void,
    RecomputeSignal
  > = {
    states: CHECKOUT_STATES,
    initialState: 'validating',
    onContextUpdate: (
      newCtx: CheckoutContext,
      state: CheckoutStateName | `__terminal:${string}`,
    ) => {
      ctx = newCtx;
      // Single `collecting` state → derive the UI step from prerequisites; terminal
      // states (complete/failed/cancelled) and `validating` map straight through.
      const display = deriveDisplayStatus<CheckoutStep | 'collecting'>(state);
      currentStep = display === 'collecting' ? deriveStep(ctx.state) : display;
    },
    onCancellation: async (
      cancelCtx: CheckoutContext,
      _currentState: CheckoutStateName | `__terminal:${string}`,
    ) => {
      currentStep = 'cancelled';
      if (cancelCtx.reservations.length > 0) {
        await releaseReservations(cancelCtx.reservations);
      }
    },
    onTerminal: async (finalCtx: CheckoutContext, terminalState: string) => {
      if (!isTerminal(terminalState, 'complete') && finalCtx.reservations.length > 0) {
        await releaseReservations(finalCtx.reservations);
      }
    },
  };

  // Shared response shaping for every update: errors echo the current state with the
  // message attached; responses always carry the derived step (evolve never writes it).
  const stateFormatters = {
    formatError: (err: string, currentCtx: CheckoutContext): CheckoutState => ({
      ...currentCtx.state,
      error: err,
      step: currentStep,
    }),
    formatResponse: (res: CheckoutState | void): CheckoutState | undefined =>
      res ? { ...res, step: currentStep } : undefined,
  };

  const updateHandlers: MappedUpdateRegistration<
    CheckoutInput,
    CheckoutContext,
    CheckoutState | void
  >[] = [
    {
      definition: setShippingUpdate,
      toEvent: (s: SetShippingSignal) => ({
        type: 'setShipping',
        shippingAddress: s.shippingAddress,
      }),
      ...stateFormatters,
    },
    {
      definition: setPaymentUpdate,
      toEvent: (s: SetPaymentSignal) => ({ type: 'setPayment', paymentMethod: s.paymentMethod }),
      ...stateFormatters,
    },
    {
      definition: submitOrderUpdate,
      toEvent: (s: SubmitOrderSignal) => ({
        type: 'submitOrder',
        reviewedCartVersion: s?.reviewedCartVersion,
      }),
      ...stateFormatters,
    },
    {
      definition: cancelCheckoutUpdate,
      toEvent: () => ({ type: 'cancelCheckout' }),
      ...stateFormatters,
    },
    {
      definition: acknowledgeCartChangeUpdate,
      toEvent: (s: { cartVersion: number }) => ({
        type: 'acknowledgeCartChange',
        cartVersion: s.cartVersion,
      }),
      ...stateFormatters,
    },
    {
      definition: retargetParentUpdate,
      toEvent: (s: RetargetParentSignal) => ({
        type: 'retargetParent',
        newParentCartWorkflowId: s.newParentCartWorkflowId,
      }),
    },
  ];

  ctx = await runStateMachine<
    CheckoutStateName,
    CheckoutInput,
    CheckoutContext,
    CheckoutState | void,
    RecomputeSignal
  >(config, ctx, updateHandlers, recomputeSignal);

  // ── Unified exit path ──
  const result: CheckoutWorkflowResult = {
    success: currentStep === 'complete',
    cancelled: currentStep === 'cancelled',
    timedOut: false,
    order: ctx.state.order,
    error: ctx.state.error,
    finalState: { ...ctx.state, step: currentStep },
    finalStep: currentStep,
    checkoutVersion: ctx.checkoutVersion,
  };

  await signalParent(ctx.parentCartWorkflowId, result);

  log.info('checkoutWorkflow EXITING', { cartId: ctx.cartId, step: currentStep });
  return result;
}

async function signalParent(
  parentCartWorkflowId: string,
  result: CheckoutWorkflowResult,
): Promise<void> {
  try {
    const parentHandle = getExternalWorkflowHandle(parentCartWorkflowId);
    await parentHandle.signal(cartInboundSignal, { kind: 'completed', result });
  } catch (err) {
    log.warn('Failed to signal parent cart with checkout result', {
      parentCartWorkflowId,
      error: String(err),
    });
  }
}
