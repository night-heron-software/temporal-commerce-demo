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
 */

import type { CheckoutContext, CheckoutState, Order, PaymentMethod, ShippingAddress } from './types';
import type { ReservationInfo } from './activities';

// ── Prepared payloads (shell → core) ────────────────────────────────────────

/** Result of renewing reservations on checkout entry. */
export interface ValidatingPrepared {
  success: boolean;
  reservations: ReservationInfo[];
  error?: string;
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
  | { success: true; order: Order }
  | { success: false; error: string };

// ── Commands & facts ────────────────────────────────────────────────────────

export type CheckoutCommand =
  | { type: 'validated'; prepared: ValidatingPrepared }
  | { type: 'setShipping'; shippingAddress: ShippingAddress; prepared: ShippingPrepared }
  | { type: 'setPayment'; paymentMethod: PaymentMethod }
  | { type: 'submitOrder'; prepared: SubmitOrderPrepared }
  | { type: 'cancelCheckout' }
  | { type: 'acknowledgeCartChange'; cartVersion: number }
  | { type: 'retargetParent'; newParentCartWorkflowId: string };

export type CheckoutFact =
  | { type: 'ValidationSucceeded'; reservations: ReservationInfo[] }
  | { type: 'ValidationFailed'; error: string }
  | {
      type: 'ShippingPriced';
      shippingAddress: ShippingAddress;
      shippingCost: number;
      tax: number;
      clientSecret?: string;
      error?: string;
    }
  | { type: 'PaymentMethodSet'; paymentMethod: PaymentMethod }
  | { type: 'OrderCompleted'; order: Order }
  | { type: 'SubmitFailed'; error: string }
  | { type: 'CheckoutCancelled' }
  | { type: 'CartChangeAcknowledged'; cartVersion: number }
  | { type: 'ParentRetargeted'; newParentCartWorkflowId: string };

// ── decide ──────────────────────────────────────────────────────────────────

export function decide(command: CheckoutCommand, _state: CheckoutContext): CheckoutFact[] {
  switch (command.type) {
    case 'validated':
      return command.prepared.success
        ? [{ type: 'ValidationSucceeded', reservations: command.prepared.reservations }]
        : [
            {
              type: 'ValidationFailed',
              error: command.prepared.error || 'Some items are no longer available',
            },
          ];

    case 'setShipping':
      return [
        {
          type: 'ShippingPriced',
          shippingAddress: command.shippingAddress,
          shippingCost: command.prepared.calculatedShipping,
          tax: command.prepared.calculatedTax,
          clientSecret: command.prepared.clientSecret,
          error: command.prepared.paymentIntentError,
        },
      ];

    case 'setPayment':
      return [{ type: 'PaymentMethodSet', paymentMethod: command.paymentMethod }];

    case 'submitOrder':
      return command.prepared.success
        ? [{ type: 'OrderCompleted', order: command.prepared.order }]
        : [{ type: 'SubmitFailed', error: command.prepared.error }];

    case 'cancelCheckout':
      return [{ type: 'CheckoutCancelled' }];

    case 'acknowledgeCartChange':
      return [{ type: 'CartChangeAcknowledged', cartVersion: command.cartVersion }];

    case 'retargetParent':
      return [{ type: 'ParentRetargeted', newParentCartWorkflowId: command.newParentCartWorkflowId }];

    default:
      return [];
  }
}

// ── evolve ──────────────────────────────────────────────────────────────────

function withState(ctx: CheckoutContext, state: CheckoutState): CheckoutContext {
  return { ...ctx, state };
}

export function evolve(ctx: CheckoutContext, fact: CheckoutFact): CheckoutContext {
  switch (fact.type) {
    case 'ValidationSucceeded':
      return {
        ...withState(ctx, { ...ctx.state, step: 'shipping' }),
        reservations: fact.reservations,
      };

    case 'ValidationFailed':
      return withState(ctx, { ...ctx.state, step: 'failed', error: fact.error });

    case 'ShippingPriced': {
      const totalPrice = ctx.subtotalPrice - ctx.totalDiscounts + fact.shippingCost + fact.tax;
      const state: CheckoutState = fact.error
        ? {
            ...ctx.state,
            shippingAddress: fact.shippingAddress,
            shippingCost: fact.shippingCost,
            tax: fact.tax,
            error: fact.error,
          }
        : {
            ...ctx.state,
            step: 'payment',
            shippingAddress: fact.shippingAddress,
            shippingCost: fact.shippingCost,
            tax: fact.tax,
            clientSecret: fact.clientSecret,
            error: undefined,
          };
      return {
        ...withState(ctx, state),
        shippingCost: fact.shippingCost,
        totalTax: fact.tax,
        totalPrice,
      };
    }

    case 'PaymentMethodSet':
      return withState(ctx, {
        ...ctx.state,
        step: 'review',
        paymentMethod: fact.paymentMethod,
        error: undefined,
      });

    case 'OrderCompleted':
      return withState(ctx, { ...ctx.state, step: 'complete', order: fact.order });

    case 'SubmitFailed':
      return withState(ctx, { ...ctx.state, step: 'payment', error: fact.error });

    case 'CheckoutCancelled':
      return {
        ...withState(ctx, { ...ctx.state, step: 'cancelled', error: undefined }),
        reservations: [],
      };

    case 'CartChangeAcknowledged':
      return withState(ctx, { ...ctx.state, cartVersionAcknowledged: fact.cartVersion });

    case 'ParentRetargeted':
      return { ...ctx, parentCartWorkflowId: fact.newParentCartWorkflowId };

    default:
      return ctx;
  }
}
