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
  type: 'card' | 'mock' | 'stripe';
  last4?: string;
  token: string; // In real impl, this would be a tokenized payment reference
}

export interface Order {
  orderId: string;
  cartId: string;
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
// Cart Event Discriminated Union
// ==================

export type CartEvent =
  | { type: 'addItem';        variantId: string; quantity: number; price: number; properties?: Record<string, unknown> }
  | { type: 'updateQuantity'; lineItemId: string; quantity: number }
  | { type: 'removeItem';     lineItemId: string }
  | { type: 'applyCoupon';    code: string }
  | { type: 'linkUser';       userId: string }
  | { type: 'mergeCarts';     sourceCartId: string; sourceItems: CartItem[]; checkoutWorkflowId?: string }
  | { type: 'adoptCheckout';  checkoutWorkflowId: string }
  | { type: 'disownCheckout' }
  | { type: 'beginCheckout' }
  | { type: 'destroyCart' };

// Update response: either the updated cart state or void for terminal operations
export type CartUpdateResponse = CartDetails | void;

// ==================
// Checkout Workflow Input/Output
// ==================

export interface CheckoutWorkflowInput {
  cartId: string;
  parentCartWorkflowId: string;
  items: CartItem[];
  subtotalPrice: number;
  totalDiscounts: number;
  currency: string;
  appliedCoupons: string[];
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
export const cartUpdate = defineUpdate<CartUpdateResponse, [CartEvent]>('cartUpdate');

// Queries
export const getCartQuery = defineQuery<CartDetails>('getCart');
export const getCheckoutStateQuery = defineQuery<CheckoutState | null>('getCheckoutState');
export const getCheckoutWorkflowIdQuery = defineQuery<string | null>('getCheckoutWorkflowId');
export const getUserIdQuery = defineQuery<string | undefined>('getUserId');

// Signals (from checkout child → cart parent)
export const checkoutCompletedSignal = defineSignal<[CheckoutWorkflowResult]>('checkoutCompleted');
