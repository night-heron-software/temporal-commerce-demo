// Re-export all entity types from contracts (single source of truth)
export type {
  CartItem,
  ShippingAddress,
  PaymentMethod,
  Order,
  CheckoutStep,
  CheckoutState,
  CartDetails,
  CartCommand,
  CartUpdateResponse,
  CartInboundSignal,
  CheckoutWorkflowInput,
  CheckoutWorkflowResult,
} from '../contracts/cart';

import type { CartDetails } from '../contracts/cart';

export type CartStateName = 'active' | 'checkout';

export interface CartWorkflowContext {
  cart: CartDetails;
  checkoutWorkflowId: string | null;
  checkoutVersion: number;
  /** Set while the checkout child is placing the order — cart edits are rejected. */
  submitting?: boolean;
}
