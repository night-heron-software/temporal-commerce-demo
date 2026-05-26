import {
  getExternalWorkflowHandle,
  log,
  setHandler,
} from '@temporalio/workflow';
import { releaseReservations } from './activities';
import type {
  CheckoutState,
  CheckoutWorkflowInput,
  CheckoutWorkflowResult,
  CheckoutContext,
  CheckoutInput,
  CheckoutStateName,
  CheckoutStep,
  SetShippingSignal,
  SetPaymentSignal,
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

import { runStateMachine, StateMachineConfig, MappedUpdateRegistration } from '../framework';
import { CHECKOUT_STATES } from './states';
import { Cart } from '../contracts';

const checkoutCompletedSignal = Cart.checkoutCompletedSignal;

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

export async function checkoutWorkflow(
  input: CheckoutWorkflowInput,
): Promise<CheckoutWorkflowResult> {
  // ── Initialize context ──
  let ctx: CheckoutContext = {
    cartId: input.cartId,
    parentCartWorkflowId: input.parentCartWorkflowId,
    items: input.items,
    subtotalPrice: input.subtotalPrice,
    totalDiscounts: input.totalDiscounts,
    currency: input.currency,
    appliedCoupons: input.appliedCoupons,
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
    totalPrice: input.subtotalPrice - input.totalDiscounts,
  };

  // ── Track current step (single source of truth: the driver's state) ──
  let currentStep = 'validating' as CheckoutStep;

  // Query handler (read-only) — returns state with computed step
  setHandler(getCheckoutStateQuery, () => ({ ...ctx.state, step: currentStep }));

  // ── State machine run ──
  const config: StateMachineConfig<CheckoutStateName, CheckoutInput, CheckoutContext, CheckoutState | void> = {
    states: CHECKOUT_STATES,
    initialState: 'validating',
    onContextUpdate: (newCtx: CheckoutContext, state: CheckoutStateName | `__terminal:${string}`) => {
      ctx = newCtx;
      currentStep = (typeof state === 'string' && state.startsWith('__terminal:')
        ? state.replace('__terminal:', '')
        : state) as CheckoutStep;
    },
    onCancellation: async (cancelCtx: CheckoutContext, _currentState: CheckoutStateName | `__terminal:${string}`) => {
      currentStep = 'cancelled';
      if (cancelCtx.reservations.length > 0) {
        await releaseReservations(cancelCtx.reservations);
      }
    },
    onTerminal: async (finalCtx: CheckoutContext, terminalState: string) => {
      if (terminalState !== '__terminal:complete' && finalCtx.reservations.length > 0) {
        await releaseReservations(finalCtx.reservations);
      }
    },
  };

  const updateHandlers: MappedUpdateRegistration<
    CheckoutInput,
    CheckoutContext,
    CheckoutState | void
  >[] = [
    {
      definition: setShippingUpdate,
      toEvent: (s: SetShippingSignal) => ({ kind: 'setShipping', shippingAddress: s.shippingAddress }),
      formatError: (err: string, currentCtx: CheckoutContext) => ({ ...currentCtx.state, error: err, step: currentStep } as any),
      formatResponse: (res: CheckoutState | void) => (res ? { ...res, step: res.step || currentStep } as any : undefined),
    },
    {
      definition: setPaymentUpdate,
      toEvent: (s: SetPaymentSignal) => ({ kind: 'setPayment', paymentMethod: s.paymentMethod }),
      formatError: (err: string, currentCtx: CheckoutContext) => ({ ...currentCtx.state, error: err, step: currentStep } as any),
      formatResponse: (res: CheckoutState | void) => (res ? { ...res, step: res.step || currentStep } as any : undefined),
    },
    {
      definition: submitOrderUpdate,
      toEvent: () => ({ kind: 'submitOrder' }),
      formatError: (err: string, currentCtx: CheckoutContext) => ({ ...currentCtx.state, error: err, step: currentStep } as any),
      formatResponse: (res: CheckoutState | void) => (res ? { ...res, step: res.step || currentStep } as any : undefined),
    },
    {
      definition: cancelCheckoutUpdate,
      toEvent: () => ({ kind: 'cancelCheckout' }),
      formatError: (err: string, currentCtx: CheckoutContext) => ({ ...currentCtx.state, error: err, step: currentStep } as any),
      formatResponse: (res: CheckoutState | void) => (res ? { ...res, step: res.step || currentStep } as any : undefined),
    },
    {
      definition: acknowledgeCartChangeUpdate,
      toEvent: (s: { cartVersion: number }) => ({ kind: 'acknowledgeCartChange', cartVersion: s.cartVersion }),
      formatError: (err: string, currentCtx: CheckoutContext) => ({ ...currentCtx.state, error: err, step: currentStep } as any),
      formatResponse: (res: CheckoutState | void) => (res ? { ...res, step: res.step || currentStep } as any : undefined),
    },
    {
      definition: retargetParentUpdate,
      toEvent: (s: RetargetParentSignal) => ({
        kind: 'retargetParent',
        newParentCartWorkflowId: s.newParentCartWorkflowId,
      }),
    },
  ];

  ctx = await runStateMachine<CheckoutStateName, CheckoutInput, CheckoutContext, CheckoutState | void>(config, ctx, updateHandlers);

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
    await parentHandle.signal(checkoutCompletedSignal, result);
  } catch (err) {
    log.warn('Failed to signal parent cart with checkout result', {
      parentCartWorkflowId,
      error: String(err),
    });
  }
}
