/**
 * Checkout states — the machine around the pure checkout Decider (ADR-0024
 * decider-native surface, aligned with nightheron-mono).
 *
 * All I/O (reservations, shipping/tax pricing, the PaymentIntent, the whole submit-order
 * pipeline) lives in the commands' `prepare` phases (the submit saga stays a prepare —
 * the TOCTOU rule protects its atomic check-and-confirm sequence); routing keys on the
 * decider's EVENTS, per state: `ValidationFailed` is terminal in `validating`, while the
 * rejection events in `collecting` fold their error into `state.error` and stay put.
 * Reservation releases on cancellation are an event-keyed effect carrying the decided
 * reason and the pre-fold reservation list.
 *
 * Topology matches the mono: `validating` (transitional escape hatch) → `collecting`, a
 * single prerequisite-accumulation state. The UI step (shipping → payment → review) is
 * *derived* from which prerequisites are satisfied (see `deriveStep` in `workflows.ts`),
 * not tracked as machine states.
 */
import { defineSignal, getExternalWorkflowHandle, log } from '@temporalio/workflow';
import type { Cart } from '../contracts';
import {
  calculateShipping,
  calculateTax,
  processPayment,
  refundPayment,
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
  CheckoutCommand,
  CheckoutContext,
  CheckoutStateName,
} from './types';
import { checkoutDecider } from './checkout-decider';
import type {
  CheckoutEvent,
  ValidatingPrepared,
  ShippingPrepared,
  SubmitOrderPrepared,
  RecomputePrepared,
} from './checkout-decider';
import { defineMachine, terminal, SELF } from '../framework';
import type { EffectsMap, StateRegistry } from '../framework';

/**
 * Combined signal sent to the parent cart (wire name 'checkoutCompleted'): the
 * completion result + the submit-freeze phases.
 */
export const cartInboundSignal = defineSignal<[Cart.CartInboundSignal]>('checkoutCompleted');

// ==================
// The machine — binds the decider + shared type params once.
// ==================

const m = defineMachine<
  CheckoutStateName,
  CheckoutCommand,
  CheckoutEvent,
  CheckoutContext,
  CheckoutState
>({
  decider: checkoutDecider,
  // Errors fold into `state.error` (ShippingFailed, SubmitRejected, …); the caller
  // receives the state either way — matching the old formatError contract exactly.
  respond: (ctx) => ctx.state,
  effects: {
    Cancelled: async (event) => {
      // Demo divergence from mono: reservations are explicit per-variant holds, so the
      // release needs the list — carried on the event (decided from pre-fold state;
      // `evolve` clears `ctx.reservations` so `onTerminal` cannot double-release).
      if (event.reservations.length > 0) {
        await releaseReservations(event.reservations);
      }
    },
  } satisfies EffectsMap<CheckoutEvent, CheckoutContext>,
});

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
      // Demo divergence from mono: reservations are KEPT for a submit retry (they
      // expire via the inventory TTL), not released on payment failure.
      return { success: false, error: 'Payment failed. Please try again.' };
    }

    // Two-phase resurrect-then-confirm (issue #34): a hold that expired while the
    // shopper parked at payment is re-acquired only if the stock is still there. If
    // any item is gone, refund and fail the submit BEFORE the order exists — no
    // order, no fulfillment, no phantom inventory.
    const { unavailable } = await confirmReservations(ctx.reservations);
    if (unavailable.length > 0) {
      await refundPayment(ctx.state.paymentMethod!.token, ctx.totalPrice, ctx.currency, ctx.cartId);
      return {
        success: false,
        error:
          'Some items are no longer available. Your payment has been refunded — ' +
          'please adjust your cart and try again.',
      };
    }

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

    return { success: true, order, newState: { ...ctx.state, order } };
  } catch (err) {
    log.error('Failed to process order', { error: String(err) });
    return { success: false, error: 'An error occurred. Please try again.' };
  }
}

// ==================
// States
// ==================

export const CHECKOUT_STATES: StateRegistry<
  CheckoutStateName,
  CheckoutCommand,
  CheckoutContext,
  CheckoutState,
  CheckoutCommand
> = {
  // ── validating (escape hatch — transitional; the tick synthesizes `validate`) ──
  validating: m.state('validating', {
    commands: {
      validate: {
        // Pull authoritative cart contents live (no snapshot), then reserve against them.
        async prepare(ctx): Promise<{ prepared: ValidatingPrepared }> {
          const cart = await queryCart(ctx.parentCartWorkflowId);
          const res = await renewReservationsForCheckout(ctx.cartId, cart.items);
          return { prepared: { ...res, cart } };
        },
      },
    },
    route: {
      CartLoaded: 'collecting',
      ValidationFailed: terminal('failed'),
    },
    transitional: true,
    onTimeout: () => ({ type: 'validate' }),
  }),

  // ── collecting — single prerequisite-accumulation state ──
  collecting: m.state('collecting', {
    commands: {
      setShipping: {
        async prepare(ctx, command) {
          return { prepared: await prepareSetShipping(ctx, command.shippingAddress) };
        },
      },

      setPayment: {},
      cancelCheckout: {},
      acknowledgeCartChange: {},
      retargetParent: {},
      checkoutTimedOut: {},

      /**
       * submitOrder — non-mutating saga. The payment/order pipeline + cart freeze/abort
       * orchestration run in prepare; the decider is pure: OrderSubmitted routes to
       * terminal('complete'), SubmitRejected folds the error and stays.
       */
      submitOrder: {
        async prepare(ctx, command): Promise<{ prepared: SubmitOrderPrepared }> {
          if (!ctx.state.shippingAddress || !ctx.state.paymentMethod) {
            return { prepared: { success: false, error: 'Shipping and payment required' } };
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

          // Re-pull the live cart so the pipeline prices against current contents; the
          // price-integrity guard catches any edit that slipped in before the freeze.
          const cart = await queryCart(ctx.parentCartWorkflowId);
          if (
            command.reviewedCartVersion != null &&
            command.reviewedCartVersion !== cart.cartVersion
          ) {
            await freeze('submitAborted');
            return { prepared: { success: false, error: 'CART_CHANGED' } };
          }
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
          return { prepared: result };
        },
      },

      /**
       * recompute — the cart changed during checkout (nudge from the parent cart, signal
       * transport mapped to this command). Re-pull the cart live, re-price shipping/tax
       * when an address is set, and un-check the payment method so the shopper
       * re-confirms against the new total. All I/O in prepare.
       */
      recompute: {
        async prepare(ctx): Promise<{ prepared: RecomputePrepared }> {
          const cart = await queryCart(ctx.parentCartWorkflowId);
          if (!ctx.state.shippingAddress) {
            return { prepared: { cart } };
          }
          const addr = ctx.state.shippingAddress;
          const shippingCost = await calculateShipping(
            `${addr.city}, ${addr.state} ${addr.postalCode}`,
          );
          const tax = await calculateTax(addr.state, cart.subtotalPrice - cart.totalDiscounts);
          return { prepared: { cart, shippingCost, tax } };
        },
      },
    },
    route: {
      Cancelled: terminal('cancelled'),
      OrderSubmitted: terminal('complete'),
      // ShippingFailed / SubmitRejected / ValidationFailed fold their error into
      // `state.error` and stay put — the caller reads it off the response.
      '*': SELF,
    },
    timeout: '1 hour',
    onTimeout: () => ({ type: 'checkoutTimedOut' }),
  }),
};
