import { Cart } from '../contracts';
import { ReservationInfo } from './activities';

export type CartItem = Cart.CartItem;
export type Order = Cart.Order;
export type PaymentMethod = Cart.PaymentMethod;
export type ShippingAddress = Cart.ShippingAddress;

export type CheckoutStateName = 'validating' | 'shipping' | 'payment' | 'review';

export type CheckoutStep = CheckoutStateName | 'complete' | 'failed' | 'cancelled';

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
  checkoutVersion: number;
}

export interface CheckoutWorkflowResult {
  success: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  order?: Order;
  error?: string;
  finalState: CheckoutState;
  finalStep: CheckoutStep;
  checkoutVersion: number;
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

export type CheckoutInput =
  | { kind: 'setShipping'; shippingAddress: ShippingAddress }
  | { kind: 'setPayment'; paymentMethod: PaymentMethod }
  | { kind: 'submitOrder' }
  | { kind: 'cancelCheckout' }
  | { kind: 'acknowledgeCartChange'; cartVersion: number }
  | { kind: 'retargetParent'; newParentCartWorkflowId: string }
  | { kind: 'timeout' };

export interface CheckoutContext {
  readonly cartId: string;
  readonly parentCartWorkflowId: string;
  readonly items: CartItem[];
  readonly subtotalPrice: number;
  readonly totalDiscounts: number;
  readonly currency: string;
  readonly appliedCoupons: string[];
  readonly isGuest: boolean;
  readonly cartVersion: number;
  readonly checkoutVersion: number;
  readonly state: CheckoutState;
  readonly reservations: ReservationInfo[];
  readonly shippingCost: number;
  readonly totalTax: number;
  readonly totalPrice: number;
}
