import { Cart, Fulfillment } from '../contracts';
export type CartItem = Cart.CartItem;
export type Order = Cart.Order;
export type PaymentMethod = Cart.PaymentMethod;
export type ShippingAddress = Cart.ShippingAddress;

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

