/**
 * Checkout Decider — the pure Functional Core (ported pattern from nightheron-mono, ADR-0009).
 *
 *   decide: (command, state) => Event[]      // what happened, as past-tense facts
 *   evolve: (state, event)   => State        // fold one fact into state (the ONLY writer)
 *
 * Both are pure and infrastructure-free. Everything a decision needs from the outside world
 * (reservation results, computed shipping/tax, the processed order) is gathered by the shell
 * (`states.ts` prepare) and injected into the command as a `prepared` payload.
 *
 * `State` is the whole `CheckoutContext` (checkout state + pricing + reservations + parent link).
 *
 * The fold owns the pricing math `totalPrice = subtotal − discounts + shipping + tax` and never
 * writes the UI-facing `step` — the workflow derives it from prerequisites (see `deriveStep` in
 * `workflows.ts`), matching the mono's single-`collecting`-state design.
 */

import type {
  CheckoutContext,
  CheckoutState,
  Order,
  PaymentMethod,
  QueriedCart,
  ShippingAddress,
} from './types';
import type { ReservationInfo } from './activities';

// ── Prepared payloads (shell → core) ────────────────────────────────────────

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

// ── Commands & facts ────────────────────────────────────────────────────────

/** The Chassaing "command": the intent enriched with its `prepare` result / payload by the shell. */
export type CheckoutCommand =
  | { type: 'validated'; prepared: ValidatingPrepared }
  | { type: 'setShipping'; shippingAddress: ShippingAddress; prepared: ShippingPrepared }
  | { type: 'setPayment'; paymentMethod: PaymentMethod }
  | { type: 'acknowledgeCartChange'; cartVersion: number }
  | { type: 'retargetParent'; newParentCartWorkflowId: string }
  | { type: 'cancelCheckout' }
  | { type: 'submitOrder'; prepared: SubmitOrderPrepared }
  | { type: 'recompute'; prepared: RecomputePrepared };

/** Past-tense domain facts. */
export type CheckoutFact =
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
  | { type: 'Cancelled' }
  | { type: 'OrderSubmitted'; newState: CheckoutState }
  | { type: 'SubmitRejected'; error: string }
  | { type: 'Recomputed'; cart: QueriedCart; shipping: number; tax: number };

// ── decide ──────────────────────────────────────────────────────────────────

/** decide(command, state) → facts. Pure. */
export function decide(command: CheckoutCommand, state: CheckoutContext): CheckoutFact[] {
  switch (command.type) {
    case 'validated': {
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
      return [{ type: 'Cancelled' }];

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

/** evolve(state, fact) → state. Pure fold; the ONLY writer of context / CheckoutState. */
export function evolve(ctx: CheckoutContext, fact: CheckoutFact): CheckoutContext {
  switch (fact.type) {
    case 'CartLoaded': {
      const { cart } = fact;
      return {
        ...ctx,
        items: cart.items,
        subtotalPrice: cart.subtotalPrice,
        totalDiscounts: cart.totalDiscounts,
        appliedCoupons: cart.appliedCoupons,
        cartVersion: cart.cartVersion,
        totalPrice: cart.subtotalPrice - cart.totalDiscounts,
        reservations: fact.reservations,
      };
    }

    case 'ValidationFailed':
      return { ...ctx, state: { ...ctx.state, error: fact.error } };

    case 'ShippingSet': {
      const state: CheckoutState = {
        ...ctx.state,
        shippingAddress: fact.shippingAddress,
        shippingCost: fact.shipping,
        tax: fact.tax,
        clientSecret: fact.clientSecret,
        error: undefined,
      };
      return {
        ...ctx,
        state,
        shippingCost: fact.shipping,
        totalTax: fact.tax,
        totalPrice: ctx.subtotalPrice - ctx.totalDiscounts + fact.shipping + fact.tax,
      };
    }

    case 'ShippingFailed': {
      const state: CheckoutState = {
        ...ctx.state,
        shippingAddress: fact.shippingAddress,
        shippingCost: fact.shipping,
        tax: fact.tax,
        error: fact.error,
      };
      return {
        ...ctx,
        state,
        shippingCost: fact.shipping,
        totalTax: fact.tax,
        totalPrice: ctx.subtotalPrice - ctx.totalDiscounts + fact.shipping + fact.tax,
      };
    }

    case 'PaymentSet':
      return {
        ...ctx,
        state: { ...ctx.state, paymentMethod: fact.paymentMethod, error: undefined },
      };

    case 'CartChangeAcknowledged':
      return { ...ctx, state: { ...ctx.state, cartVersionAcknowledged: fact.cartVersion } };

    case 'ParentRetargeted':
      return { ...ctx, parentCartWorkflowId: fact.parentCartWorkflowId };

    case 'Cancelled':
      return { ...ctx, state: { ...ctx.state, error: undefined }, reservations: [] };

    case 'OrderSubmitted':
      return { ...ctx, state: fact.newState };

    case 'SubmitRejected':
      return { ...ctx, state: { ...ctx.state, error: fact.error } };

    case 'Recomputed': {
      const { cart } = fact;
      // Un-check payment on the amount-affecting cart change so the shopper re-confirms.
      const state: CheckoutState = {
        ...ctx.state,
        paymentMethod: undefined,
        shippingCost: fact.shipping,
        tax: fact.tax,
        error: undefined,
      };
      return {
        ...ctx,
        items: cart.items,
        subtotalPrice: cart.subtotalPrice,
        totalDiscounts: cart.totalDiscounts,
        appliedCoupons: cart.appliedCoupons,
        cartVersion: cart.cartVersion,
        shippingCost: fact.shipping,
        totalTax: fact.tax,
        totalPrice: cart.subtotalPrice - cart.totalDiscounts + fact.shipping + fact.tax,
        state,
      };
    }

    default:
      return ctx;
  }
}
