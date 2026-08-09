/**
 * Checkout Decider — the pure Functional Core, on the ADR-0024 decider-native surface
 * (aligned with nightheron-mono).
 *
 *   decide: (command, state) => Event[]     // what happened, as past-tense events
 *   evolve: (state, event)   => State       // fold one event into state (the ONLY writer)
 *
 * All I/O (cart query, shipping/tax, the PaymentIntent, the submit saga) runs in the
 * states' `prepare` phases (`states.ts`); their results arrive enriched on the commands.
 * `evolve` owns every `CheckoutContext`/`CheckoutState` mutation, including the pricing
 * math `totalPrice = subtotal − discounts + shipping + tax`. Routing keys on the emitted
 * events (per-state: `ValidationFailed` is terminal in `validating`; rejections in
 * `collecting` fold their error into `state.error` and stay put).
 *
 * The fold never writes the UI-facing `step` — the workflow derives it from prerequisites
 * (see `deriveStep` in `workflows.ts`), matching the mono's single-`collecting` design.
 */

import type { MachineDecider } from '../framework';
import type {
  CheckoutCommand,
  CheckoutContext,
  CheckoutState,
  Order,
  PaymentMethod,
  QueriedCart,
  ShippingAddress,
} from './types';
import type { ReservationInfo } from './activities';

// ── `prepare` result shapes (shared with the shell) ─────────────────────────

/** Result of pulling the live cart + renewing reservations on checkout entry. */
export interface ValidatingPrepared {
  success: boolean;
  reservations: ReservationInfo[];
  error?: string;
  /** Live cart contents (queryCart) — folded into the context on success. */
  cart: QueriedCart;
}

/**
 * Result of a recompute nudge: the re-pulled cart, plus re-priced shipping/tax when a
 * shipping address was already set (otherwise pricing waits for setShipping).
 */
export interface RecomputePrepared {
  cart: QueriedCart;
  shippingCost?: number;
  tax?: number;
}

/** Result of pricing a shipping address (+ creating the PaymentIntent). */
export interface ShippingPrepared {
  calculatedShipping: number;
  calculatedTax: number;
  clientSecret?: string;
  paymentIntentError?: string;
}

/** Result of the submit-order pipeline (payment → reservations → order → email → OMS). */
export type SubmitOrderPrepared =
  | { success: true; order: Order; newState: CheckoutState }
  | { success: false; error: string };

/**
 * The command as the decider sees it: the base `CheckoutCommand` union with the fields
 * the states' `prepare` phases inject, plus the framework's deterministic timestamp
 * (the collapse ADR-0024 prescribes — one union, with enrichment expressed as
 * intersections on it rather than a hand-maintained parallel union).
 */
export type EnrichedCheckoutCommand = (
  | (Extract<CheckoutCommand, { type: 'validate' }> & { prepared: ValidatingPrepared })
  | (Extract<CheckoutCommand, { type: 'setShipping' }> & { prepared: ShippingPrepared })
  | (Extract<CheckoutCommand, { type: 'submitOrder' }> & { prepared: SubmitOrderPrepared })
  | (Extract<CheckoutCommand, { type: 'recompute' }> & { prepared: RecomputePrepared })
  | Exclude<CheckoutCommand, { type: 'validate' | 'setShipping' | 'submitOrder' | 'recompute' }>
) & { at: string };

/** Past-tense domain events. */
export type CheckoutEvent =
  | { type: 'CartLoaded'; cart: QueriedCart; reservations: ReservationInfo[] }
  | { type: 'ValidationFailed'; error: string }
  | {
      type: 'ShippingSet';
      shippingAddress: ShippingAddress;
      shipping: number;
      tax: number;
      clientSecret?: string;
    }
  | {
      type: 'ShippingFailed';
      shippingAddress: ShippingAddress;
      shipping: number;
      tax: number;
      error: string;
    }
  | { type: 'PaymentSet'; paymentMethod: PaymentMethod }
  | { type: 'CartChangeAcknowledged'; cartVersion: number }
  | { type: 'ParentRetargeted'; parentCartWorkflowId: string }
  /**
   * Carries the pre-fold reservations so the release effect can act on them: `evolve`
   * clears `ctx.reservations` on this event (so `onTerminal` cannot double-release),
   * which means the post-fold context no longer knows what to release — the event does.
   */
  | {
      type: 'Cancelled';
      reason: 'checkout-cancelled' | 'checkout-timeout';
      reservations: ReservationInfo[];
    }
  | { type: 'OrderSubmitted'; newState: CheckoutState }
  | { type: 'SubmitRejected'; error: string }
  | { type: 'Recomputed'; cart: QueriedCart; shipping: number; tax: number };

// ── decide ──────────────────────────────────────────────────────────────────

/** decide(command, state) → events. Pure. */
export function decide(command: EnrichedCheckoutCommand, state: CheckoutContext): CheckoutEvent[] {
  switch (command.type) {
    case 'validate': {
      const p = command.prepared;
      return p.success
        ? [{ type: 'CartLoaded', cart: p.cart, reservations: p.reservations }]
        : [{ type: 'ValidationFailed', error: p.error || 'Some items are no longer available' }];
    }

    case 'setShipping': {
      const p = command.prepared;
      if (p.paymentIntentError) {
        return [
          {
            type: 'ShippingFailed',
            shippingAddress: command.shippingAddress,
            shipping: p.calculatedShipping,
            tax: p.calculatedTax,
            error: p.paymentIntentError,
          },
        ];
      }
      return [
        {
          type: 'ShippingSet',
          shippingAddress: command.shippingAddress,
          shipping: p.calculatedShipping,
          tax: p.calculatedTax,
          clientSecret: p.clientSecret ?? state.state.clientSecret,
        },
      ];
    }

    case 'setPayment':
      return [{ type: 'PaymentSet', paymentMethod: command.paymentMethod }];

    case 'acknowledgeCartChange':
      return [{ type: 'CartChangeAcknowledged', cartVersion: command.cartVersion }];

    case 'retargetParent':
      return [{ type: 'ParentRetargeted', parentCartWorkflowId: command.newParentCartWorkflowId }];

    case 'cancelCheckout':
      return [
        { type: 'Cancelled', reason: 'checkout-cancelled', reservations: state.reservations },
      ];

    case 'checkoutTimedOut':
      return [{ type: 'Cancelled', reason: 'checkout-timeout', reservations: state.reservations }];

    case 'submitOrder':
      return command.prepared.success
        ? [{ type: 'OrderSubmitted', newState: command.prepared.newState }]
        : [{ type: 'SubmitRejected', error: command.prepared.error }];

    case 'recompute': {
      const p = command.prepared;
      return [
        {
          type: 'Recomputed',
          cart: p.cart,
          shipping: p.shippingCost ?? state.shippingCost,
          tax: p.tax ?? state.totalTax,
        },
      ];
    }

    default:
      return [];
  }
}

// ── evolve ──────────────────────────────────────────────────────────────────

/** evolve(state, event) → state. Pure fold; the ONLY writer of context / CheckoutState. */
export function evolve(ctx: CheckoutContext, event: CheckoutEvent): CheckoutContext {
  switch (event.type) {
    case 'CartLoaded': {
      const { cart } = event;
      return {
        ...ctx,
        items: cart.items,
        subtotalPrice: cart.subtotalPrice,
        totalDiscounts: cart.totalDiscounts,
        appliedCoupons: cart.appliedCoupons,
        cartVersion: cart.cartVersion,
        totalPrice: cart.subtotalPrice - cart.totalDiscounts,
        reservations: event.reservations,
      };
    }

    case 'ValidationFailed':
      return { ...ctx, state: { ...ctx.state, error: event.error } };

    case 'ShippingSet': {
      const state: CheckoutState = {
        ...ctx.state,
        shippingAddress: event.shippingAddress,
        shippingCost: event.shipping,
        tax: event.tax,
        clientSecret: event.clientSecret,
        error: undefined,
      };
      return {
        ...ctx,
        state,
        shippingCost: event.shipping,
        totalTax: event.tax,
        totalPrice: ctx.subtotalPrice - ctx.totalDiscounts + event.shipping + event.tax,
      };
    }

    case 'ShippingFailed': {
      const state: CheckoutState = {
        ...ctx.state,
        shippingAddress: event.shippingAddress,
        shippingCost: event.shipping,
        tax: event.tax,
        error: event.error,
      };
      return {
        ...ctx,
        state,
        shippingCost: event.shipping,
        totalTax: event.tax,
        totalPrice: ctx.subtotalPrice - ctx.totalDiscounts + event.shipping + event.tax,
      };
    }

    case 'PaymentSet':
      return {
        ...ctx,
        state: { ...ctx.state, paymentMethod: event.paymentMethod, error: undefined },
      };

    case 'CartChangeAcknowledged':
      return { ...ctx, state: { ...ctx.state, cartVersionAcknowledged: event.cartVersion } };

    case 'ParentRetargeted':
      return { ...ctx, parentCartWorkflowId: event.parentCartWorkflowId };

    case 'Cancelled':
      return { ...ctx, state: { ...ctx.state, error: undefined }, reservations: [] };

    case 'OrderSubmitted':
      return { ...ctx, state: event.newState };

    case 'SubmitRejected':
      return { ...ctx, state: { ...ctx.state, error: event.error } };

    case 'Recomputed': {
      const { cart } = event;
      // Un-check payment on the amount-affecting cart change so the shopper re-confirms.
      const state: CheckoutState = {
        ...ctx.state,
        paymentMethod: undefined,
        shippingCost: event.shipping,
        tax: event.tax,
        error: undefined,
      };
      return {
        ...ctx,
        items: cart.items,
        subtotalPrice: cart.subtotalPrice,
        totalDiscounts: cart.totalDiscounts,
        appliedCoupons: cart.appliedCoupons,
        cartVersion: cart.cartVersion,
        shippingCost: event.shipping,
        totalTax: event.tax,
        totalPrice: cart.subtotalPrice - cart.totalDiscounts + event.shipping + event.tax,
        state,
      };
    }

    default:
      return ctx;
  }
}

/**
 * The assembled decider, conforming to the framework's `MachineDecider` shape (ADR-0024:
 * `isTerminal` is gone — terminality is the route tables' job; `initialState` remains as
 * the canonical empty shape for decider unit tests, never consulted at runtime).
 */
export const checkoutDecider: MachineDecider<
  EnrichedCheckoutCommand,
  CheckoutEvent,
  CheckoutContext
> = {
  decide,
  evolve,
  initialState: {
    cartId: '',
    parentCartWorkflowId: '',
    items: [],
    subtotalPrice: 0,
    totalDiscounts: 0,
    currency: 'USD',
    appliedCoupons: [],
    isGuest: true,
    cartVersion: 0,
    checkoutVersion: 0,
    state: { step: 'validating', isGuest: true, shippingCost: 0, tax: 0 },
    reservations: [],
    shippingCost: 0,
    totalTax: 0,
    totalPrice: 0,
  },
};
