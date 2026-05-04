import {
  allHandlersFinished,
  condition,
  getExternalWorkflowHandle,
  log,
  setHandler
} from '@temporalio/workflow';
const getFeatureFlag = async (flag: string) => false;
import {
  calculateShipping,
  calculateTax,
  processPayment,
  createOrder,
  createPaymentIntent,
  sendConfirmationEmail,
  startOrderManagementWorkflow,
  renewReservationsForCheckout,
  confirmReservations,
  releaseReservations,
  ReservationInfo
} from './activities';
import type {
  CheckoutState,
  CheckoutWorkflowInput,
  CheckoutWorkflowResult,
  Order,
} from './types';

import {
  setShippingUpdate,
  setPaymentUpdate,
  submitOrderUpdate,
  cancelCheckoutUpdate,
  acknowledgeCartChangeUpdate,
  retargetParentUpdate,
  getCheckoutStateQuery
} from './definitions';

import { Cart } from '../contracts';
const checkoutCompletedSignal = Cart.checkoutCompletedSignal;

// Re-export definitions for worker registration compatibility
export {
  setShippingUpdate,
  setPaymentUpdate,
  submitOrderUpdate,
  cancelCheckoutUpdate,
  acknowledgeCartChangeUpdate,
  retargetParentUpdate,
  getCheckoutStateQuery
};

// ==================
// Checkout Workflow
// ==================

export async function checkoutWorkflow(
  input: CheckoutWorkflowInput
): Promise<CheckoutWorkflowResult> {
  const state: CheckoutState = {
    step: 'validating',
    isGuest: input.isGuest,
    shippingCost: 0,
    tax: 0,
    cartVersionAtStart: input.cartVersion,
    cartVersionAcknowledged: input.cartVersion
  };

  const dataFlowEnabled = await getFeatureFlag('DATA_FLOW_LOGGING');
  if (dataFlowEnabled) {
    log.info('[DataFlow] T5: CartItem[] → Order — input.CheckoutWorkflowInput', {
      dataFlow: true, stage: 'T5: CartItem[] → Order', label: 'input.CheckoutWorkflowInput',
      data: JSON.stringify({ cartId: input.cartId, itemCount: input.items.length, items: input.items, subtotalPrice: input.subtotalPrice, totalDiscounts: input.totalDiscounts, currency: input.currency }, null, 2)
    });
  }

  // Track cart totals for order creation
  const subtotalPrice = input.subtotalPrice;
  const totalDiscounts = input.totalDiscounts;
  let totalTax = 0;
  let shippingCost = 0;
  let totalPrice = subtotalPrice - totalDiscounts;

  let orderComplete = false;
  let checkoutCancelled = false;
  let reservations: ReservationInfo[] = [];
  let parentCartWorkflowId = input.parentCartWorkflowId;

  // Query for current checkout state
  setHandler(getCheckoutStateQuery, () => state);

  // Retarget parent cart (used when carts merge during sign-in)
  setHandler(retargetParentUpdate, (signal) => {
    log.info('Retargeting parent cart', { from: parentCartWorkflowId, to: signal.newParentCartWorkflowId });
    parentCartWorkflowId = signal.newParentCartWorkflowId;
  });

  // Handle acknowledgement of cart changes during checkout
  setHandler(acknowledgeCartChangeUpdate, (input) => {
    state.cartVersionAcknowledged = input.cartVersion;
    return state;
  });

  // Set shipping address and calculate costs
  // Allow updates from shipping, payment, or review steps (for back navigation)
  setHandler(setShippingUpdate, async (signalInput) => {
    await condition(() => state.step !== 'validating');
    const allowedSteps = ['shipping', 'payment', 'review'];
    if (!allowedSteps.includes(state.step)) {
      return { ...state, error: `Cannot set shipping from step: ${state.step}` };
    }

    state.shippingAddress = signalInput.shippingAddress;

    // Calculate shipping cost
    const calculatedShipping = await calculateShipping(
      `${signalInput.shippingAddress.city}, ${signalInput.shippingAddress.state} ${signalInput.shippingAddress.postalCode}`
    );
    state.shippingCost = calculatedShipping;
    shippingCost = calculatedShipping;

    // Calculate tax based on shipping address
    const calculatedTax = await calculateTax(
      signalInput.shippingAddress.state,
      subtotalPrice - totalDiscounts
    );
    state.tax = calculatedTax;
    totalTax = calculatedTax;

    // Update total price with shipping and tax
    totalPrice = subtotalPrice - totalDiscounts + shippingCost + totalTax;

    // Create PaymentIntent if using Stripe
    try {
      const { clientSecret } = await createPaymentIntent(totalPrice, input.currency);
      state.clientSecret = clientSecret;
    } catch (e) {
      log.error('Failed to create payment intent', { error: String(e) });
    }

    state.step = 'payment';
    return state;
  });

  // Set payment method
  setHandler(setPaymentUpdate, async (signalInput) => {
    await condition(() => state.step !== 'validating');
    const allowedSteps = ['payment', 'review'];
    if (!allowedSteps.includes(state.step)) {
      return { ...state, error: `Cannot set payment from step: ${state.step}` };
    }
    if (!state.shippingAddress) {
      return { ...state, error: 'Shipping address required before payment' };
    }

    state.paymentMethod = signalInput.paymentMethod;
    state.step = 'review';
    return state;
  });

  // Submit order - process payment, create order, send confirmation
  setHandler(submitOrderUpdate, async () => {
    await condition(() => state.step !== 'validating');
    if (state.step !== 'review') {
      return { ...state, error: `Cannot submit order from step: ${state.step}` };
    }
    if (!state.shippingAddress || !state.paymentMethod) {
      return { ...state, error: 'Shipping and payment required' };
    }

    state.step = 'processing';

    try {
      // Process payment
      // If Stripe is enabled, the 'token' in paymentMethod is the PaymentIntent ID
      // Pass cartId as idempotency key for mock payments
      const paymentSuccess = await processPayment(
        state.paymentMethod.token,
        totalPrice,
        input.currency,
        input.cartId
      );

      if (!paymentSuccess) {
        state.step = 'payment';
        state.error = 'Payment failed. Please try again.';
        return state;
      }

      // Confirm inventory reservations after successful payment
      await confirmReservations(input.storeId, reservations);

      // Create order
      const order: Order = await createOrder({
        storeId: input.storeId,
        cartId: input.cartId,
        items: input.items,
        shippingAddress: state.shippingAddress,
        paymentMethod: state.paymentMethod,
        subtotal: subtotalPrice,
        shippingCost: shippingCost,
        tax: totalTax,
        totalDiscounts: totalDiscounts,
        total: totalPrice,
        currency: input.currency
      });

      // Send confirmation email
      await sendConfirmationEmail(state.shippingAddress.email, order.confirmationNumber, order);

      // Start the Order Management workflow for this order
      await startOrderManagementWorkflow(order, state.shippingAddress.email);

      state.order = order;
      state.step = 'complete';
      orderComplete = true;

      if (dataFlowEnabled) {
        log.info('[DataFlow] T5: CartItem[] → Order — output.Order', {
          dataFlow: true, stage: 'T5: CartItem[] → Order', label: 'output.Order',
          data: JSON.stringify(order, null, 2)
        });
      }

      return state;
    } catch {
      state.step = 'payment';
      state.error = 'An error occurred. Please try again.';
      return state;
    }
  });

  // Cancel checkout - releases reservations and returns cart to active state
  setHandler(cancelCheckoutUpdate, async () => {
    await condition(() => state.step !== 'validating');
    const allowedSteps = ['shipping', 'payment', 'review'];
    if (!allowedSteps.includes(state.step)) {
      return { ...state, error: `Cannot cancel checkout from step: ${state.step}` };
    }

    // Release all reservations
    if (reservations.length > 0) {
      await releaseReservations(reservations);
      reservations = [];
    }

    state.step = 'cancelled';
    checkoutCancelled = true;
    return state;
  });

  // ==================
  // Renew Inventory Reservations at Checkout Start
  // ==================
  const reserveResult = await renewReservationsForCheckout(input.storeId, input.cartId, input.items);

  if (!reserveResult.success) {
    state.step = 'auth';
    state.error = reserveResult.error || 'Some items are no longer available';
    return {
      success: false,
      error: state.error,
      finalState: state
    };
  }

  reservations = reserveResult.reservations;
  state.step = 'shipping';

  // Wait for order completion or cancellation (1 hour timeout)
  const completedBeforeTimeout = await condition(() => orderComplete || checkoutCancelled, '1 hour');
  await condition(allHandlersFinished);

  // If checkout times out or is cancelled, release reservations
  if (!orderComplete && reservations.length > 0) {
    await releaseReservations(reservations);
  }

  const result: CheckoutWorkflowResult = {
    success: orderComplete,
    cancelled: checkoutCancelled,
    timedOut: !completedBeforeTimeout && !orderComplete && !checkoutCancelled,
    order: state.order,
    error: state.error,
    finalState: state
  };

  // Signal the parent cart with the result
  try {
    const parentHandle = getExternalWorkflowHandle(parentCartWorkflowId);
    await parentHandle.signal(checkoutCompletedSignal, result);
  } catch (err) {
    log.warn('Failed to signal parent cart with checkout result', { parentCartWorkflowId, err });
  }

  return result;
}
