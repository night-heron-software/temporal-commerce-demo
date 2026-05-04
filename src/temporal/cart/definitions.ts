import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';
import type {
  AddItemSignal,
  AdoptCheckoutSignal,
  ApplyCouponSignal,
  BeginCheckoutSignal,
  CartDetails,
  CheckoutCompletedPayload,
  CheckoutSignal,
  CheckoutState,
  LinkUserSignal,
  MergeCartsSignal,
  RemoveItemSignal,
  UpdateQuantitySignal
} from './types';

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
