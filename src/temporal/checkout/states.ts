import { log } from '@temporalio/workflow';
import {
  calculateShipping,
  calculateTax,
  processPayment,
  createOrder,
  createPaymentIntent,
  sendConfirmationEmail,
  startOrderManagementWorkflow,
  releaseReservations,
  confirmReservations,
  renewReservationsForCheckout,
} from './activities';
import type {
  CheckoutState,
  ShippingAddress,
  Order,
  CheckoutInput,
  CheckoutContext,
  CheckoutStateName,
} from './types';
import { StateInput, StateOutput, StateRegistry } from '../framework';

// ==================
// Helpers
// ==================

/** Inputs that can be handled in any non-terminal state (lifecycle/coordination). */
function handleLifecycleInput(
  ctx: Readonly<CheckoutContext>,
  input: CheckoutInput,
  selfStateName: CheckoutStateName,
): StateOutput<CheckoutStateName, CheckoutContext, CheckoutState> | null {
  if (input.kind === 'retargetParent') {
    return {
      context: { ...ctx, parentCartWorkflowId: input.newParentCartWorkflowId },
      next: selfStateName,
      response: ctx.state,
    };
  }

  if (input.kind === 'acknowledgeCartChange') {
    const state = { ...ctx.state, cartVersionAcknowledged: input.cartVersion };
    return {
      context: { ...ctx, state },
      next: selfStateName,
      response: state,
    };
  }

  return null;
}

/** Build a rejection output for disallowed inputs. */
function rejectInput(
  ctx: Readonly<CheckoutContext>,
  input: CheckoutInput,
  selfStateName: CheckoutStateName,
): StateOutput<CheckoutStateName, CheckoutContext, CheckoutState> {
  const errorMsg = `Cannot '${input.kind}' from state: ${selfStateName}`;
  return {
    context: ctx,
    next: selfStateName,
    error: errorMsg,
    response: { ...ctx.state, error: errorMsg },
  };
}

// ==================
// State Functions
// ==================

/**
 * Validating state — acquires inventory reservations on entry.
 * This is the initial state; the driver enters here immediately.
 * On success → shipping. On failure → __terminal:failed.
 */
export async function validatingState(
  ctx: Readonly<CheckoutContext>,
  input: StateInput<CheckoutInput>,
): Promise<StateOutput<CheckoutStateName, CheckoutContext, CheckoutState>> {
  const reserveResult = await renewReservationsForCheckout(
    ctx.cartId,
    ctx.items,
  );

  if (!reserveResult.success) {
    return {
      context: {
        ...ctx,
        state: { ...ctx.state, error: reserveResult.error || 'Some items are no longer available' },
      },
      next: '__terminal:failed',
      response: ctx.state,
    };
  }

  return {
    context: { ...ctx, reservations: reserveResult.reservations },
    next: 'shipping',
    response: ctx.state,
  };
}

/**
 * Shipping state — waiting for the shopper to provide a shipping address.
 */
export async function shippingState(
  ctx: Readonly<CheckoutContext>,
  input: StateInput<CheckoutInput>,
): Promise<StateOutput<CheckoutStateName, CheckoutContext, CheckoutState>> {
  if (input.kind === 'timeout') {
    return cancelCheckoutTransition(ctx);
  }
  const event = (input as { kind: 'event'; event: CheckoutInput }).event;

  const lifecycle = handleLifecycleInput(ctx, event, 'shipping');
  if (lifecycle) return lifecycle;

  if (event.kind === 'cancelCheckout') {
    return cancelCheckoutTransition(ctx);
  }

  if (event.kind === 'setShipping') {
    return processShipping(ctx, event.shippingAddress);
  }

  return rejectInput(ctx, event, 'shipping');
}

/**
 * Payment state — waiting for payment method.
 */
export async function paymentState(
  ctx: Readonly<CheckoutContext>,
  input: StateInput<CheckoutInput>,
): Promise<StateOutput<CheckoutStateName, CheckoutContext, CheckoutState>> {
  if (input.kind === 'timeout') {
    return cancelCheckoutTransition(ctx);
  }
  const event = (input as { kind: 'event'; event: CheckoutInput }).event;

  const lifecycle = handleLifecycleInput(ctx, event, 'payment');
  if (lifecycle) return lifecycle;

  if (event.kind === 'cancelCheckout') {
    return cancelCheckoutTransition(ctx);
  }

  if (event.kind === 'setShipping') {
    return processShipping(ctx, event.shippingAddress);
  }

  if (event.kind === 'setPayment') {
    if (!ctx.state.shippingAddress) {
      return {
        context: ctx,
        next: 'payment',
        error: 'Shipping address required before payment',
        response: { ...ctx.state, error: 'Shipping address required before payment' },
      };
    }

    const state: CheckoutState = {
      ...ctx.state,
      paymentMethod: event.paymentMethod,
      error: undefined,
    };
    return {
      context: { ...ctx, state },
      next: 'review',
      response: state,
    };
  }

  return rejectInput(ctx, event, 'payment');
}

/**
 * Review state — order summary, ready to submit.
 */
export async function reviewState(
  ctx: Readonly<CheckoutContext>,
  input: StateInput<CheckoutInput>,
): Promise<StateOutput<CheckoutStateName, CheckoutContext, CheckoutState>> {
  if (input.kind === 'timeout') {
    return cancelCheckoutTransition(ctx);
  }
  const event = (input as { kind: 'event'; event: CheckoutInput }).event;

  const lifecycle = handleLifecycleInput(ctx, event, 'review');
  if (lifecycle) return lifecycle;

  if (event.kind === 'cancelCheckout') {
    return cancelCheckoutTransition(ctx);
  }

  if (event.kind === 'setShipping') {
    return processShipping(ctx, event.shippingAddress);
  }

  if (event.kind === 'setPayment') {
    const state: CheckoutState = {
      ...ctx.state,
      paymentMethod: event.paymentMethod,
      error: undefined,
    };
    return {
      context: { ...ctx, state },
      next: 'review',
      response: state,
    };
  }

  if (event.kind === 'submitOrder') {
    if (!ctx.state.shippingAddress || !ctx.state.paymentMethod) {
      return {
        context: ctx,
        next: 'review',
        error: 'Shipping and payment required',
        response: { ...ctx.state, error: 'Shipping and payment required' },
      };
    }

    // Run the order processing pipeline inline synchronously
    return processOrder(ctx);
  }

  return rejectInput(ctx, event, 'review');
}

// ==================
// Transition Helpers
// ==================

/**
 * Process shipping address: calculate shipping, tax, create PaymentIntent.
 */
async function processShipping(
  ctx: Readonly<CheckoutContext>,
  shippingAddress: ShippingAddress,
): Promise<StateOutput<CheckoutStateName, CheckoutContext, CheckoutState>> {
  const calculatedShipping = await calculateShipping(
    `${shippingAddress.city}, ${shippingAddress.state} ${shippingAddress.postalCode}`,
  );
  const calculatedTax = await calculateTax(
    shippingAddress.state,
    ctx.subtotalPrice - ctx.totalDiscounts,
  );

  const shippingCost = calculatedShipping;
  const totalTax = calculatedTax;
  const totalPrice = ctx.subtotalPrice - ctx.totalDiscounts + shippingCost + totalTax;

  let clientSecret = ctx.state.clientSecret;
  try {
    const result = await createPaymentIntent(totalPrice, ctx.currency);
    clientSecret = result.clientSecret;
  } catch (e) {
    log.error('Failed to create payment intent', { error: String(e) });
    const errorState: CheckoutState = {
      ...ctx.state,
      shippingAddress,
      shippingCost: calculatedShipping,
      tax: calculatedTax,
      error: 'Unable to initialize payment. Please try again.',
    };
    return {
      context: {
        ...ctx,
        state: errorState,
        shippingCost,
        totalTax,
        totalPrice,
      },
      next: 'shipping',
      response: errorState,
      error: 'Unable to initialize payment. Please try again.',
    };
  }

  const state: CheckoutState = {
    ...ctx.state,
    shippingAddress,
    shippingCost: calculatedShipping,
    tax: calculatedTax,
    clientSecret,
    error: undefined,
  };

  return {
    context: {
      ...ctx,
      state,
      shippingCost,
      totalTax,
      totalPrice,
    },
    next: 'payment',
    response: state,
  };
}

/**
 * Cancel checkout: release reservations and transition to cancelled.
 */
async function cancelCheckoutTransition(
  ctx: Readonly<CheckoutContext>,
): Promise<StateOutput<CheckoutStateName, CheckoutContext, CheckoutState>> {
  if (ctx.reservations.length > 0) {
    await releaseReservations(ctx.reservations);
  }

  const state: CheckoutState = { ...ctx.state, error: undefined };
  return {
    context: {
      ...ctx,
      state,
      reservations: [],
    },
    next: '__terminal:cancelled',
    response: state,
  };
}

/**
 * Process order: payment, reservation confirmation, order creation, email, OMS.
 */
async function processOrder(
  ctx: Readonly<CheckoutContext>,
): Promise<StateOutput<CheckoutStateName, CheckoutContext, CheckoutState>> {
  try {
    const paymentSuccess = await processPayment(
      ctx.state.paymentMethod!.token,
      ctx.totalPrice,
      ctx.currency,
      ctx.cartId,
    );

    if (!paymentSuccess) {
      const state: CheckoutState = {
        ...ctx.state,
        error: 'Payment failed. Please try again.',
      };
      return {
        context: { ...ctx, state },
        next: 'payment',
        response: state,
        error: 'Payment failed. Please try again.',
      };
    }

    await confirmReservations(ctx.reservations);

    const order: Order = await createOrder({
      cartId: ctx.cartId,
      items: ctx.items,
      shippingAddress: ctx.state.shippingAddress!,
      paymentMethod: ctx.state.paymentMethod!,
      subtotal: ctx.subtotalPrice,
      shippingCost: ctx.shippingCost,
      tax: ctx.totalTax,
      totalDiscounts: ctx.totalDiscounts,
      total: ctx.totalPrice,
      currency: ctx.currency,
    });

    await sendConfirmationEmail(ctx.state.shippingAddress!.email, order.confirmationNumber, order);

    await startOrderManagementWorkflow(order, ctx.state.shippingAddress!.email);

    const state: CheckoutState = {
      ...ctx.state,
      order,
    };

    return {
      context: { ...ctx, state },
      next: '__terminal:complete',
      response: state,
    };
  } catch (err) {
    log.error('Failed to process order', { error: String(err) });
    const state: CheckoutState = {
      ...ctx.state,
      error: 'An error occurred. Please try again.',
    };
    return {
      context: { ...ctx, state },
      next: 'payment',
      response: state,
      error: 'An error occurred. Please try again.',
    };
  }
}

export const CHECKOUT_STATES: StateRegistry<
  CheckoutStateName,
  CheckoutInput,
  CheckoutContext,
  CheckoutState
> = {
  validating: { fn: validatingState, timeout: '1 millisecond' },
  shipping: { fn: shippingState, timeout: '1 hour' },
  payment: { fn: paymentState, timeout: '1 hour' },
  review: { fn: reviewState, timeout: '1 hour' },
};
