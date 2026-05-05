import { CartItem, Order, PaymentMethod, ShippingAddress } from './cart';

export type CheckoutStep =
  | 'validating'
  | 'auth'
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

export interface SetShippingSignal {
  shippingAddress: ShippingAddress;
}

export interface SetPaymentSignal {
  paymentMethod: PaymentMethod;
}

export type SubmitOrderSignal = object;

export type CancelCheckoutSignal = object;

export interface RetargetParentSignal {
  newParentCartWorkflowId: string;
}

// Re-export types from cart that checkout needs
export type { CartItem, Order, PaymentMethod, ShippingAddress } from './cart';


import { defineQuery, defineUpdate } from '@temporalio/workflow';


// ==================
// Checkout Workflow Updates & Queries
// ==================

export const setShippingUpdate = defineUpdate<CheckoutState, [SetShippingSignal]>('setShipping');
export const setPaymentUpdate = defineUpdate<CheckoutState, [SetPaymentSignal]>('setPayment');
export const submitOrderUpdate = defineUpdate<CheckoutState, [SubmitOrderSignal]>('submitOrder');
export const cancelCheckoutUpdate = defineUpdate<CheckoutState, [CancelCheckoutSignal]>('cancelCheckout');
export const acknowledgeCartChangeUpdate = defineUpdate<CheckoutState, [{ cartVersion: number }]>('acknowledgeCartChange');
export const retargetParentUpdate = defineUpdate<void, [RetargetParentSignal]>('retargetParent');
export const getCheckoutStateQuery = defineQuery<CheckoutState>('getCheckoutStateForCheckout');


