import { Cart } from '../contracts';
import { ReservationInfo } from './activities';

export type CartItem = Cart.CartItem;
export type Order = Cart.Order;
export type PaymentMethod = Cart.PaymentMethod;
export type ShippingAddress = Cart.ShippingAddress;

export type CheckoutStateName = 'validating' | 'shipping' | 'payment' | 'review';

export type CheckoutStep = CheckoutStateName | 'complete' | 'failed' | 'cancelled';

/**
 * The contracts definition is the single source of truth (its `step` union is a superset —
 * it also carries the legacy 'processing' step used by cart-side display code).
 */
export type CheckoutState = Cart.CheckoutState;

/**
 * Checkout input carries no cart-content snapshot — contents are pulled live via the
 * queryCart activity at `validating` and re-pulled on each recompute nudge.
 */
export interface CheckoutWorkflowInput {
  cartId: string;
  parentCartWorkflowId: string;
  currency: string;
  isGuest: boolean;
  cartVersion: number;
  checkoutVersion: number;
}

/**
 * Inbound nudge from the parent cart when items changed during checkout. Trigger-only:
 * carries the new cartVersion; the checkout re-pulls contents via queryCart.
 */
export interface RecomputeSignal {
  cartVersion: number;
}

/** Live cart contents as returned by the queryCart activity. */
export interface QueriedCart {
  items: CartItem[];
  subtotalPrice: number;
  totalDiscounts: number;
  appliedCoupons: string[];
  cartVersion: number;
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

// Discriminated on `type` (framework TransitionMap convention). Driver timeouts arrive as
// their own input kind, not as an event member.
export type CheckoutInput =
  | { type: 'setShipping'; shippingAddress: ShippingAddress }
  | { type: 'setPayment'; paymentMethod: PaymentMethod }
  | { type: 'submitOrder' }
  | { type: 'cancelCheckout' }
  | { type: 'acknowledgeCartChange'; cartVersion: number }
  | { type: 'retargetParent'; newParentCartWorkflowId: string };

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
