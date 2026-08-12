import { Cart } from '../contracts';
import { ReservationInfo } from './activities';

export type CartItem = Cart.CartItem;
export type Order = Cart.Order;
export type PaymentMethod = Cart.PaymentMethod;
export type ShippingAddress = Cart.ShippingAddress;

export type CheckoutStateName = 'validating' | 'collecting';

/**
 * UI-facing checkout step. Decoupled from the machine state: the workflow has a single
 * `collecting` state and the step is *derived* from which prerequisites are satisfied
 * (shipping → payment → review). Kept as the stable external contract the storefront
 * reads, independent of internal state names.
 */
export type CheckoutStep =
  | 'validating'
  | 'shipping'
  | 'payment'
  | 'review'
  | 'complete'
  | 'failed'
  | 'cancelled';

/**
 * The contracts definition is the single source of truth (its `step` union is a superset —
 * it also carries the legacy 'processing' step used by cart-side display code).
 */
export type CheckoutState = Cart.CheckoutState;

// Re-export the shared wire contract (single source of truth: contracts/checkout.ts) —
// including the merged CheckoutCommand union (ADR-0024).
export type {
  CheckoutCommand,
  RecomputeSignal,
  SetShippingSignal,
  SetPaymentSignal,
  SubmitOrderSignal,
  CancelCheckoutSignal,
  RetargetParentSignal,
} from '../contracts/checkout';

/**
 * Checkout input carries no cart-content snapshot — contents are pulled live via the
 * queryCart activity at `validating` and re-pulled on each recompute nudge.
 * Single declaration in contracts/cart.ts (backlog #7 — this file held an identical copy).
 */
export type CheckoutWorkflowInput = Cart.CheckoutWorkflowInput;

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
