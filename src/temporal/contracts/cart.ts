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

export interface AddItemSignal {
  variantId: string;
  quantity: number;
  price: number;
  properties?: Record<string, unknown>;
}

export interface addItemToCartUpdatePayload {
  variantId: string;
  quantity: number;
  price: number;
  properties?: Record<string, unknown>;
}

export interface UpdateQuantitySignal {
  lineItemId: string;
  quantity: number;
}

export interface RemoveItemSignal {
  lineItemId: string;
}

export interface ApplyCouponSignal {
  code: string;
}

export interface CheckoutSignal {
  checkoutUrl: string;
}

export type BeginCheckoutSignal = object;

// Checkout workflow input/output types (duplicated from checkout/types to avoid cross-module imports)
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
}

export interface CheckoutWorkflowResult {
  success: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  order?: Order;
  error?: string;
  finalState: CheckoutState;
}

// User-Cart linking signals
export interface LinkUserSignal {
  userId: string;
}

export interface MergeCartsSignal {
  sourceCartId: string; // Cart to merge items FROM
  sourceItems: CartItem[]; // Items to merge
  checkoutWorkflowId?: string; // If the source cart had a running checkout, transfer it
}

export interface AdoptCheckoutSignal {
  checkoutWorkflowId: string;
}

export interface CheckoutCompletedPayload {
  success: boolean;
  cancelled?: boolean;
  order?: Order;
  error?: string;
  finalState: CheckoutState;
}


import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';


// ==================
// Cart Workflow Updates & Queries
// ==================

// Cart management updates
export const addItemToCartUpdate = defineUpdate<CartDetails, [AddItemSignal]>(
  'addItemToCartUpdate'
);
export const updateQuantityUpdate = defineUpdate<CartDetails, [UpdateQuantitySignal]>(
  'updateQuantity'
);
export const removeItemUpdate = defineUpdate<CartDetails, [RemoveItemSignal]>('removeItemUpdate');
export const applyCouponUpdate = defineUpdate<CartDetails, [ApplyCouponSignal]>('applyCoupon');

// Begin checkout - spawns child workflow
export const beginCheckoutUpdate = defineUpdate<CartDetails, [BeginCheckoutSignal]>(
  'beginCheckout'
);

// Legacy checkout (kept for compatibility)
export const checkoutUpdate = defineUpdate<CartDetails, [CheckoutSignal]>('checkout');

// Queries
export const getCartQuery = defineQuery<CartDetails>('getCart');
export const getCheckoutStateQuery = defineQuery<CheckoutState | null>('getCheckoutState');
export const getCheckoutWorkflowIdQuery = defineQuery<string | null>('getCheckoutWorkflowId');
export const getUserIdQuery = defineQuery<string | undefined>('getUserId');

// User-cart linking updates
export const linkUserUpdate = defineUpdate<CartDetails, [LinkUserSignal]>('linkUser');
export const mergeCartsUpdate = defineUpdate<CartDetails, [MergeCartsSignal]>('mergeCarts');
export const destroyCartUpdate = defineUpdate<void, []>('destroyCart');
export const adoptCheckoutUpdate = defineUpdate<CartDetails, [AdoptCheckoutSignal]>('adoptCheckout');

// Signals
export const checkoutCompletedSignal = defineSignal<[CheckoutCompletedPayload]>('checkoutCompleted');


