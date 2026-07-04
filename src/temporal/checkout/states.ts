/**
 * Checkout states — the shell around the pure checkout Decider (prepare → decide → finalize).
 *
 * All I/O (reservations, shipping/tax pricing, the PaymentIntent, the whole submit-order
 * pipeline) runs in `prepare` handlers; each command is enriched with the prepared result
 * before it reaches the pure core in `checkout-decider.ts`. State structure is unchanged
 * from the pre-refactor demo: validating → shipping → payment → review, with terminal
 * complete / failed / cancelled.
 */
import { defineSignal, getExternalWorkflowHandle, log } from '@temporalio/workflow';
import type { Cart } from '../contracts';
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
  queryCart,
} from './activities';
import type {
  CheckoutState,
  ShippingAddress,
  Order,
  CheckoutInput,
  CheckoutContext,
  CheckoutStateName,
  RecomputeSignal,
} from './types';
import { decide as checkoutDecide, evolve } from './checkout-decider';
import type {
  CheckoutCommand,
  ValidatingPrepared,
  ShippingPrepared,
  SubmitOrderPrepared,
  RecomputePrepared,
} from './checkout-decider';
import { defineDomain, terminal, SELF } from '../framework';
import type { StateRegistry, TransitionMap } from '../framework';

/**
 * Combined signal sent to the parent cart (wire name 'checkoutCompleted'): the
 * completion result + the submit-freeze phases.
 */
export const cartInboundSignal = defineSignal<[Cart.CartInboundSignal]>('checkoutCompleted');

// ==================
// Domain factory — binds the shared type params once
// ==================

const checkout = defineDomain<
  CheckoutStateName,
  CheckoutInput,
  CheckoutContext,
  CheckoutState,
  RecomputeSignal
>();

type CheckoutTransitions = TransitionMap<
  CheckoutStateName,
  CheckoutContext,
  CheckoutState,
  CheckoutInput
>;

/** Shell adapter — run the pure Decider (decide → evolve) for the next context. */
function apply(ctx: Readonly<CheckoutContext>, command: CheckoutCommand): CheckoutContext {
  const state = ctx as CheckoutContext;
  return checkoutDecide(command, state).reduce(evolve, state);
}

// ==================
// Shared transition entries
// ==================

/** Reject a disallowed input in this state (pre-refactor message + response shape). */
function rejectEntry<K extends CheckoutInput['type']>(stateName: CheckoutStateName) {
  return {
    decide(ctx: Readonly<CheckoutContext>, event: Extract<CheckoutInput, { type: K }>) {
      const errorMsg = `Cannot '${event.type}' from state: ${stateName}`;
      return {
        context: ctx as CheckoutContext,
        next: SELF,
        error: errorMsg,
        response: { ...ctx.state, error: errorMsg },
      };
    },
  };
}

/** acknowledgeCartChange — lifecycle input, handled in any waiting state (stays put). */
const acknowledgeCartChangeEntry: CheckoutTransitions['acknowledgeCartChange'] = {
  decide(ctx, event) {
    const context = apply(ctx, { type: 'acknowledgeCartChange', cartVersion: event.cartVersion });
    return { context, next: SELF, response: context.state };
  },
};

/** retargetParent — lifecycle input, handled in any waiting state (stays put). */
const retargetParentEntry: CheckoutTransitions['retargetParent'] = {
  decide(ctx, event) {
    const context = apply(ctx, {
      type: 'retargetParent',
      newParentCartWorkflowId: event.newParentCartWorkflowId,
    });
    return { context, next: SELF, response: context.state };
  },
};

/**
 * cancelCheckout — release reservations and transition to terminal:cancelled.
 * Shared across states; finalize fires if reservations exist (reads the pre-decision ctx).
 */
const cancelCheckoutEntry = {
  decide(ctx: Readonly<CheckoutContext>) {
    const context = apply(ctx, { type: 'cancelCheckout' });
    return {
      context,
      next: terminal('cancelled'),
      response: context.state,
      finalize: { hasReservations: ctx.reservations.length > 0 },
    };
  },
  async finalize(
    ctx: Readonly<CheckoutContext>,
    decision: { finalize?: { hasReservations: boolean } },
  ) {
    if (decision.finalize?.hasReservations) {
      await releaseReservations(ctx.reservations);
    }
  },
};

/** Timeout in a waiting state cancels the checkout (same path as cancelCheckout). */
const timeoutCancels = {
  onTimeout: {
    decide(ctx: Readonly<CheckoutContext>) {
      const context = apply(ctx, { type: 'cancelCheckout' });
      return {
        context,
        next: terminal('cancelled'),
        finalize: { hasReservations: ctx.reservations.length > 0 },
      };
    },
    async finalize(
      ctx: Readonly<CheckoutContext>,
      decision: { finalize?: { hasReservations: boolean } },
    ) {
      if (decision.finalize?.hasReservations) {
        await releaseReservations(ctx.reservations);
      }
    },
  },
};

// ==================
// setShipping prepare — computes shipping/tax and creates the PaymentIntent
// ==================

async function prepareSetShipping(
  ctx: Readonly<CheckoutContext>,
  shippingAddress: ShippingAddress,
): Promise<ShippingPrepared> {
  const calculatedShipping = await calculateShipping(
    `${shippingAddress.city}, ${shippingAddress.state} ${shippingAddress.postalCode}`,
  );
  const calculatedTax = await calculateTax(
    shippingAddress.state,
    ctx.subtotalPrice - ctx.totalDiscounts,
  );

  let clientSecret = ctx.state.clientSecret;
  let paymentIntentError: string | undefined;
  try {
    const totalPrice = ctx.subtotalPrice - ctx.totalDiscounts + calculatedShipping + calculatedTax;
    const result = await createPaymentIntent(totalPrice, ctx.currency);
    clientSecret = result.clientSecret;
  } catch (e) {
    log.error('Failed to create payment intent', { error: String(e) });
    paymentIntentError = 'Unable to initialize payment. Please try again.';
  }

  return { calculatedShipping, calculatedTax, clientSecret, paymentIntentError };
}

/**
 * setShipping — shared by shipping/payment/review. On success → payment; a PaymentIntent
 * failure re-prices but returns to shipping with the error (pre-refactor behavior).
 */
const setShippingEntry: CheckoutTransitions['setShipping'] = {
  async prepare(ctx, event) {
    return prepareSetShipping(ctx, event.shippingAddress);
  },
  decide(ctx, event, _meta, prepared: ShippingPrepared) {
    const context = apply(ctx, {
      type: 'setShipping',
      shippingAddress: event.shippingAddress,
      prepared,
    });
    if (prepared.paymentIntentError) {
      return {
        context,
        next: 'shipping' as const,
        response: context.state,
        error: prepared.paymentIntentError,
      };
    }
    return { context, next: 'payment' as const, response: context.state };
  },
};

// ==================
// submitOrder prepare — the entire payment/order pipeline runs here (I/O only)
// ==================

async function prepareSubmitOrder(ctx: Readonly<CheckoutContext>): Promise<SubmitOrderPrepared> {
  try {
    const paymentSuccess = await processPayment(
      ctx.state.paymentMethod!.token,
      ctx.totalPrice,
      ctx.currency,
      ctx.cartId,
    );

    if (!paymentSuccess) {
      return { success: false, error: 'Payment failed. Please try again.' };
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

    return { success: true, order };
  } catch (err) {
    log.error('Failed to process order', { error: String(err) });
    return { success: false, error: 'An error occurred. Please try again.' };
  }
}

// ==================
// Recompute (inbound signal from the parent cart) — shared by all waiting states.
// Re-pull the cart live, re-price shipping/tax when an address is set, and un-check the
// payment method so the shopper re-confirms against the new total. All I/O in prepare.
// ==================

const recomputeEntry = {
  async prepare(ctx: Readonly<CheckoutContext>, _signal: RecomputeSignal): Promise<RecomputePrepared> {
    const cart = await queryCart(ctx.parentCartWorkflowId);
    if (!ctx.state.shippingAddress) {
      return { cart };
    }
    const addr = ctx.state.shippingAddress;
    const shippingCost = await calculateShipping(`${addr.city}, ${addr.state} ${addr.postalCode}`);
    const tax = await calculateTax(addr.state, cart.subtotalPrice - cart.totalDiscounts);
    return { cart, shippingCost, tax };
  },
  decide(
    ctx: Readonly<CheckoutContext>,
    _signal: RecomputeSignal,
    _meta: unknown,
    prepared: RecomputePrepared,
  ) {
    const context = apply(ctx, { type: 'recompute', prepared });
    // Payment is un-checked by the fold; land wherever the prerequisites now point.
    const next = context.state.shippingAddress ? ('payment' as const) : ('shipping' as const);
    return { context, next, response: context.state };
  },
};

// ==================
// State: validating (escape hatch — transitional, prepare-only)
// ==================

const validating = checkout.state('validating', {
  async prepare(ctx): Promise<ValidatingPrepared> {
    // Pull authoritative cart contents live (no snapshot), then reserve against them.
    const cart = await queryCart(ctx.parentCartWorkflowId);
    const res = await renewReservationsForCheckout(ctx.cartId, cart.items);
    return { ...res, cart };
  },
  decide(ctx, _input, prepared: ValidatingPrepared) {
    const context = apply(ctx, { type: 'validated', prepared });
    return {
      context,
      next: prepared.success ? ('shipping' as const) : terminal('failed'),
      response: context.state,
    };
  },
});

// ==================
// State: shipping — waiting for the shopper's shipping address
// ==================

const shipping = checkout.transitions(
  'shipping',
  {
    setShipping: setShippingEntry,
    cancelCheckout: cancelCheckoutEntry,
    acknowledgeCartChange: acknowledgeCartChangeEntry,
    retargetParent: retargetParentEntry,
    setPayment: rejectEntry<'setPayment'>('shipping'),
    submitOrder: rejectEntry<'submitOrder'>('shipping'),
  },
  { ...timeoutCancels, onSignal: recomputeEntry },
);

// ==================
// State: payment — waiting for a payment method
// ==================

const payment = checkout.transitions(
  'payment',
  {
    setShipping: setShippingEntry,
    setPayment: {
      decide(ctx, event) {
        if (!ctx.state.shippingAddress) {
          const errorMsg = 'Shipping address required before payment';
          return {
            context: ctx as CheckoutContext,
            next: 'payment' as const,
            error: errorMsg,
            response: { ...ctx.state, error: errorMsg },
          };
        }
        const context = apply(ctx, { type: 'setPayment', paymentMethod: event.paymentMethod });
        return { context, next: 'review' as const, response: context.state };
      },
    },
    cancelCheckout: cancelCheckoutEntry,
    acknowledgeCartChange: acknowledgeCartChangeEntry,
    retargetParent: retargetParentEntry,
    submitOrder: rejectEntry<'submitOrder'>('payment'),
  },
  { ...timeoutCancels, onSignal: recomputeEntry },
);

// ==================
// State: review — order summary, ready to submit
// ==================

const review = checkout.transitions(
  'review',
  {
    setShipping: setShippingEntry,
    setPayment: {
      decide(ctx, event) {
        const context = apply(ctx, { type: 'setPayment', paymentMethod: event.paymentMethod });
        return { context, next: 'review' as const, response: context.state };
      },
    },
    /**
     * submitOrder — non-mutating saga. The payment/order pipeline + cart freeze/abort
     * orchestration run in prepare; decide is pure: terminal('complete') on success,
     * else back to payment with the error.
     */
    submitOrder: {
      async prepare(ctx): Promise<SubmitOrderPrepared> {
        if (!ctx.state.shippingAddress || !ctx.state.paymentMethod) {
          return { success: false, error: 'Shipping and payment required' };
        }
        // Freeze the cart for the duration of the saga: edits are rejected while the
        // order is being placed, so pricing can't drift mid-pipeline. Best-effort — a
        // missing parent (already closed) must not block the submit itself.
        const freeze = async (kind: 'submitStarted' | 'submitAborted') => {
          try {
            await getExternalWorkflowHandle(ctx.parentCartWorkflowId).signal(cartInboundSignal, {
              kind,
            });
          } catch (err) {
            log.warn('Failed to signal cart submit-freeze phase', {
              parentCartWorkflowId: ctx.parentCartWorkflowId,
              kind,
              error: String(err),
            });
          }
        };
        await freeze('submitStarted');

        // Re-pull the live cart so the pipeline prices against current contents.
        const cart = await queryCart(ctx.parentCartWorkflowId);
        const totalPrice =
          cart.subtotalPrice - cart.totalDiscounts + ctx.shippingCost + ctx.totalTax;
        const result = await prepareSubmitOrder({
          ...ctx,
          items: cart.items,
          subtotalPrice: cart.subtotalPrice,
          totalDiscounts: cart.totalDiscounts,
          cartVersion: cart.cartVersion,
          totalPrice,
        });
        if (!result.success) {
          await freeze('submitAborted');
        }
        return result;
      },
      decide(ctx, _event, _meta, prepared: SubmitOrderPrepared) {
        if (!prepared.success && prepared.error === 'Shipping and payment required') {
          return {
            context: ctx as CheckoutContext,
            next: 'review' as const,
            error: prepared.error,
            response: { ...ctx.state, error: prepared.error },
          };
        }
        const context = apply(ctx, { type: 'submitOrder', prepared });
        if (!prepared.success) {
          // Pipeline failed — back to payment with the error.
          return { context, next: 'payment' as const, response: context.state, error: prepared.error };
        }
        return { context, next: terminal('complete'), response: context.state };
      },
    },
    cancelCheckout: cancelCheckoutEntry,
    acknowledgeCartChange: acknowledgeCartChangeEntry,
    retargetParent: retargetParentEntry,
  },
  { ...timeoutCancels, onSignal: recomputeEntry },
);

// ==================
// Registry
// ==================

export const CHECKOUT_STATES: StateRegistry<
  CheckoutStateName,
  CheckoutInput,
  CheckoutContext,
  CheckoutState,
  RecomputeSignal
> = {
  validating: { ...validating, transitional: true },
  shipping: { ...shipping, timeout: '1 hour' },
  payment: { ...payment, timeout: '1 hour' },
  review: { ...review, timeout: '1 hour' },
};
