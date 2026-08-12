import type { CheckoutState, PaymentMethod, ShippingAddress } from './cart';

// The checkout lifecycle types have ONE declaration, in contracts/cart.ts (backlog #7:
// this file used to carry identical copies of CheckoutStep/CheckoutState and DIVERGED
// copies of CheckoutWorkflowInput/Result — the Input here still claimed an item
// snapshot the live design abandoned). Re-exported so `Checkout.*` consumers keep working.
export type {
  CheckoutStep,
  CheckoutState,
  CheckoutWorkflowInput,
  CheckoutWorkflowResult,
} from './cart';

export interface SetShippingSignal {
  shippingAddress: ShippingAddress;
}

export interface SetPaymentSignal {
  paymentMethod: PaymentMethod;
}

export interface SubmitOrderSignal {
  /** The cartVersion the buyer reviewed; submit is rejected if the cart changed since. */
  reviewedCartVersion?: number;
}

export type CancelCheckoutSignal = object;

export interface RetargetParentSignal {
  newParentCartWorkflowId: string;
}

/**
 * Sent by the parent cart when the cart changed during checkout (a trigger, not
 * data — checkout re-pulls via the queryCart activity). Carries only the new cartVersion.
 */
export interface RecomputeSignal {
  cartVersion: number;
}

// ==================
// Checkout Command — one union for every intent the checkout machine accepts (ADR-0024).
//
// The first block is the WIRE union (mapped from Temporal updates at registration in
// checkout/workflows.ts). `recompute` arrives on the cart's nudge signal (signal
// transport, mapped to a command via `toSignal`); the last two are synthesized by
// state timers (onTimeout). The decider sees these enriched with prepared data + the
// deterministic timestamp (see `EnrichedCheckoutCommand` in checkout/states.ts).
// ==================

export type CheckoutCommand =
  // — wire (Temporal updates) —
  | { type: 'setShipping'; shippingAddress: ShippingAddress }
  | { type: 'setPayment'; paymentMethod: PaymentMethod }
  | { type: 'submitOrder'; reviewedCartVersion?: number }
  | { type: 'cancelCheckout' }
  | { type: 'acknowledgeCartChange'; cartVersion: number }
  | { type: 'retargetParent'; newParentCartWorkflowId: string }
  // — the cart's recompute nudge (signal transport, mapped to a command at registration) —
  | { type: 'recompute'; cartVersion?: number }
  // — synthesized by state timers (onTimeout) —
  | { type: 'validate' }
  | { type: 'checkoutTimedOut' };

// Re-export types from cart that checkout needs
export type { CartItem, Order, PaymentMethod, ShippingAddress } from './cart';

import { defineQuery, defineUpdate } from '@temporalio/workflow';

// ==================
// Checkout Workflow Updates & Queries
// ==================

export const setShippingUpdate = defineUpdate<CheckoutState, [SetShippingSignal]>('setShipping');
export const setPaymentUpdate = defineUpdate<CheckoutState, [SetPaymentSignal]>('setPayment');
export const submitOrderUpdate = defineUpdate<CheckoutState, [SubmitOrderSignal]>('submitOrder');
export const cancelCheckoutUpdate = defineUpdate<CheckoutState, [CancelCheckoutSignal]>(
  'cancelCheckout',
);
export const acknowledgeCartChangeUpdate = defineUpdate<CheckoutState, [{ cartVersion: number }]>(
  'acknowledgeCartChange',
);
export const retargetParentUpdate = defineUpdate<void, [RetargetParentSignal]>('retargetParent');
export const getCheckoutStateQuery = defineQuery<CheckoutState>('getCheckoutStateForCheckout');
