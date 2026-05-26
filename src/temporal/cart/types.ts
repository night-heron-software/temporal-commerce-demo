// Re-export all entity types from contracts (single source of truth)
export type {
  CartItem,
  ShippingAddress,
  PaymentMethod,
  Order,
  CheckoutStep,
  CheckoutState,
  CartDetails,
  CartEvent,
  CartUpdateResponse,
  CheckoutWorkflowInput,
  CheckoutWorkflowResult
} from '../contracts/cart';

import type { CartDetails } from '../contracts/cart';

export type CartStateName = 'active' | 'checkout';

export interface CartWorkflowContext {
  cart: CartDetails;
  checkoutWorkflowId: string | null;
  checkoutVersion: number;
}
