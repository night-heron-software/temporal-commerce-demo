import { defineQuery, defineUpdate } from '@temporalio/workflow';
import type {
  CancelCheckoutSignal,
  CheckoutState,
  RetargetParentSignal,
  SetShippingSignal,
  SetPaymentSignal,
  SubmitOrderSignal
} from './types';

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
