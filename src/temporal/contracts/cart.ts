export interface CartItem {
  lineItemId: string;
  variantId: string;
  quantity: number;
  price: number;
  properties?: Record<string, unknown>;
}

export interface ShippingAddress {
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
  email: string;
}

export interface PaymentMethod {
  type: 'card' | 'mock';
  last4?: string;
  token: string; // In real impl, this would be a tokenized payment reference
}

export interface Order {
  orderId: string;
  cartId: string;
  /**
   * The journey's correlationId (ADR-0011) — its own UUID minted at cart creation,
   * captured from the ambient correlation context when the order is created.
   */
  correlationId: string;
  customerEmail: string;
  items: CartItem[];
  shippingAddress: ShippingAddress;
  paymentMethod: PaymentMethod;
  subtotal: number;
  shippingCost: number;
  tax: number;
  totalDiscounts: number;
  total: number;
  currency: string;
  status: 'pending' | 'paid' | 'fulfilled' | 'cancelled';
  createdAt: string;
  updatedAt?: string;
  confirmationNumber: string;
}

export type CheckoutStep =
  | 'validating'
  | 'shipping'
  | 'payment'
  | 'review'
  | 'processing'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface CheckoutState {
  step: CheckoutStep;
  isGuest: boolean;
  shippingAddress?: ShippingAddress;
  paymentMethod?: PaymentMethod;
  shippingCost: number;
  tax: number;
  cartVersionAtStart?: number;
  cartVersionAcknowledged?: number;
  order?: Order;
  error?: string;
  clientSecret?: string;
}

export interface CartDetails {
  cartId: string;
  email?: string;
  userId?: string; // Linked user ID if authenticated
  items: CartItem[];
  subtotalPrice: number;
  totalDiscounts: number;
  totalTax: number;
  totalPrice: number;
  shippingCost: number;
  currency: string;
  appliedCoupons: string[];
  cartVersion: number;
  status: 'active' | 'checkout' | 'processing' | 'completed' | 'failed' | 'abandoned';
  checkout?: CheckoutState;
  createdAt: string;
  updatedAt: string;
}

// ==================
// Cart Command — one union for every intent the machine accepts (ADR-0024).
//
// The first block is the WIRE union (what `cartUpdate` callers send). The second
// block is internal: signal-mapped commands from the checkout child (see `toSignal`
// in cart/workflows.ts) and the commands the two states' timers synthesize. The
// decider sees these enriched with prepared data + the deterministic timestamp
// (see `EnrichedCartCommand` in cart/states.ts).
// ==================

export type CartCommand =
  // — wire (cartUpdate) —
  | {
      type: 'addItem';
      variantId: string;
      quantity: number;
      price: number;
      properties?: Record<string, unknown>;
    }
  | { type: 'updateQuantity'; lineItemId: string; quantity: number }
  | { type: 'removeItem'; lineItemId: string }
  | { type: 'applyCoupon'; code: string }
  | { type: 'linkUser'; email: string; userId: string }
  | { type: 'beginCheckout' }
  // — from the checkout child (signal transport, mapped to commands at registration) —
  | { type: 'checkoutCompleted'; result: CheckoutWorkflowResult }
  | { type: 'submitStarted' }
  | { type: 'submitAborted' }
  // — synthesized by state timers (onTimeout) —
  | { type: 'expireCart' }
  | { type: 'checkoutTimedOut' };

// Update response: either the updated cart state or void for terminal operations
export type CartUpdateResponse = CartDetails | void;

// ==================
// Checkout Workflow Input/Output
// ==================

/**
 * Checkout child input. Cart contents are NOT snapshotted here — the checkout
 * pulls them live via the queryCart activity at `validating` (and again on each
 * recompute nudge), so a mid-checkout cart edit can never leave a stale snapshot.
 */
export interface CheckoutWorkflowInput {
  cartId: string;
  parentCartWorkflowId: string;
  currency: string;
  isGuest: boolean;
  cartVersion: number;
  checkoutVersion: number;
}

export interface CheckoutWorkflowResult {
  success: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  order?: Order;
  error?: string;
  finalState: CheckoutState;
  checkoutVersion: number;
}

// ==================
// Workflow Definitions
// ==================

import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';

// Single consolidated cart update
export const cartUpdate = defineUpdate<CartUpdateResponse, [CartCommand]>('cartUpdate');

// Queries
export const getCartQuery = defineQuery<CartDetails>('getCart');
export const getCheckoutStateQuery = defineQuery<CheckoutState | null>('getCheckoutState');
export const getCheckoutWorkflowIdQuery = defineQuery<string | null>('getCheckoutWorkflowId');
export const getUserIdQuery = defineQuery<string | undefined>('getUserId');

/**
 * Combined inbound signal from the checkout child to the cart parent (wire name
 * 'checkoutCompleted'): the completion result, plus the submit-freeze phases that
 * lock cart edits while the checkout child is placing the order.
 */
export type CartInboundSignal =
  | { kind: 'completed'; result: CheckoutWorkflowResult }
  | { kind: 'submitStarted' }
  | { kind: 'submitAborted' };

// Signals (from checkout child → cart parent)
export const checkoutCompletedSignal = defineSignal<[CartInboundSignal]>('checkoutCompleted');
