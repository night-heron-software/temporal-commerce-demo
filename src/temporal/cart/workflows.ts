import {
  allHandlersFinished,
  condition,
  continueAsNew,
  log,
  ParentClosePolicy,
  setHandler,
  startChild,
  uuid4
} from '@temporalio/workflow';
import { reserveCartItem, releaseCartItem, indexCart, deleteCart } from './activities';

import { buildCartDocument } from './document-builder';
import type {
  AddItemSignal,
  CartDetails,
  CheckoutWorkflowInput,
  CheckoutWorkflowResult,
} from './types';

import {
  addItemToCartUpdate,
  adoptCheckoutUpdate,
  updateQuantityUpdate,
  removeItemUpdate,
  applyCouponUpdate,
  beginCheckoutUpdate,
  checkoutUpdate,
  checkoutCompletedSignal,
  getCartQuery,
  getCheckoutStateQuery,
  getCheckoutWorkflowIdQuery,
  getUserIdQuery,
  linkUserUpdate,
  mergeCartsUpdate,
  destroyCartUpdate
} from './definitions';

// Re-export definitions for worker registration compatibility
export {
  addItemToCartUpdate,
  adoptCheckoutUpdate,
  updateQuantityUpdate,
  removeItemUpdate,
  applyCouponUpdate,
  beginCheckoutUpdate,
  checkoutUpdate,
  checkoutCompletedSignal,
  getCartQuery,
  getCheckoutStateQuery,
  getCheckoutWorkflowIdQuery,
  getUserIdQuery,
  linkUserUpdate,
  mergeCartsUpdate,
  destroyCartUpdate
};

// ==================
// Continue-as-New Configuration
// ==================
const CONTINUE_AS_NEW_THRESHOLD = 100;

// Input type for Continue-as-New (preserves state across executions)
interface CartWorkflowInput {
  storeId: string;
  cartId: string;
  initialCart?: CartDetails;
  createdAt?: string;
  updateCount?: number;
}


// ==================
// Cart Workflow (Parent)
// ==================

export async function cartWorkflow(input: CartWorkflowInput | string): Promise<CartDetails> {
  // Handle both legacy string input and new object input
  // Extract storeId safely. Legacy executions might not provide it at start,
  // but they will need it for some operations.
  const {
    storeId,
    cartId,
    initialCart,
    createdAt: inputCreatedAt,
    updateCount: inputUpdateCount
  } = typeof input === 'string'
    ? { storeId: 'legacy-store', cartId: input, initialCart: undefined, createdAt: undefined, updateCount: 0 }
    : input;

  // Initialize or restore cart state
  const now = new Date().toISOString();
  
  const cart: CartDetails = initialCart || {
    storeId,
    cartId,
    items: [],
    subtotalPrice: 0,
    totalDiscounts: 0,
    totalTax: 0,
    totalPrice: 0,
    shippingCost: 0,
    currency: 'USD',
    appliedCoupons: [],
    cartVersion: 0,
    status: 'active',
    checkout: undefined,
    createdAt: inputCreatedAt || now,
    updatedAt: now
  };

  let updateCount = inputUpdateCount || 0;

  // Non-blocking projection sync: set flag for main loop to flush
  let projectionDirty = false;
  function syncProjections(): void {
    projectionDirty = true;
  }
  // Helper: Increment update count and trigger Continue-as-New if threshold reached
  const incrementUpdateCount = async () => {
    updateCount++;
    cart.cartVersion = (cart.cartVersion || 0) + 1;
    if (updateCount >= CONTINUE_AS_NEW_THRESHOLD) {
      // Wait for pending handlers before continuing as new
      await condition(allHandlersFinished);
      await continueAsNew<typeof cartWorkflow>({
        storeId,
        cartId,
        initialCart: cart,
        createdAt: cart.createdAt,
        updateCount: 0 // Reset counter for new execution
      });
    }
  };

  let orderComplete = false;
  let shouldExit = false;
  let checkoutWorkflowId: string | null = null;

  // ==================
  // Helpers
  // ==================

  const finalizeUpdate = async () => {
    syncProjections();
    await incrementUpdateCount();
  };

  const abandonCart = async (reason: string) => {
    log.info(`abandonCart: ${reason}`, { cartId });
    cart.status = 'abandoned';
    syncProjections();
    shouldExit = true;
  };

  const createItem = (
    variantId: string,
    quantity: number,
    price: number,
    properties?: Record<string, unknown>
  ) => ({
    lineItemId: uuid4(),
    variantId,
    quantity,
    price,
    properties
  });

  // Query Handlers
  setHandler(getCartQuery, () => cart);
  setHandler(getCheckoutStateQuery, () => cart.checkout || null);
  setHandler(getCheckoutWorkflowIdQuery, () => checkoutWorkflowId);
  setHandler(getUserIdQuery, () => cart.userId);

  // ==================
  // User-Cart Linking
  // ==================

  setHandler(linkUserUpdate, async (input) => {
    cart.userId = input.userId;
    await finalizeUpdate();
    return cart;
  });

  setHandler(mergeCartsUpdate, async (input) => {
    // Merge items from source cart into this cart
    for (const sourceItem of input.sourceItems) {
      const existingItem = cart.items.find((item) => item.variantId === sourceItem.variantId);
      if (existingItem) {
        // Add quantities together for duplicate items
        existingItem.quantity += sourceItem.quantity;
      } else {
        // Add new item with fresh lineItemId
        cart.items.push(
          createItem(
            sourceItem.variantId,
            sourceItem.quantity,
            sourceItem.price,
            sourceItem.properties
          )
        );
      }
    }
    recalculateTotals(cart);

    // If the source cart had a running checkout, adopt it
    if (input.checkoutWorkflowId) {
      log.info('Merge: adopting checkout from source cart', { cartId, checkoutWorkflowId: input.checkoutWorkflowId });
      checkoutWorkflowId = input.checkoutWorkflowId;
      cart.status = 'checkout';
      cart.checkout = {
        step: 'validating',
        isGuest: !cart.userId,
        shippingCost: 0,
        tax: 0
      };
    }

    await finalizeUpdate();
    return cart;
  });

  setHandler(destroyCartUpdate, async () => {
    log.info('destroyCartUpdate ENTER', { cartId });
    // Release all inventory reservations
    for (const item of cart.items) {
      await releaseCartItem(cartId, item.variantId);
    }
    await abandonCart('explicit destroy');
    log.info('destroyCartUpdate EXIT', { cartId });
  });

  // ==================
  // Cart Management
  // ==================

  const addItem = (input: AddItemSignal) => {
    if (input.quantity <= 0) return;

    // Cart item limits
    const MAX_ITEMS = 10;
    const MAX_QUANTITY_PER_ITEM = 100;

    const existingItem = cart.items.find((item) => item.variantId === input.variantId);
    if (existingItem) {
      const newQuantity = existingItem.quantity + input.quantity;
      if (newQuantity > MAX_QUANTITY_PER_ITEM) {
        throw new Error(`Maximum quantity per item is ${MAX_QUANTITY_PER_ITEM}`);
      }
      existingItem.quantity = newQuantity;
    } else {
      if (cart.items.length >= MAX_ITEMS) {
        throw new Error(`Maximum ${MAX_ITEMS} items allowed in cart`);
      }
      if (input.quantity > MAX_QUANTITY_PER_ITEM) {
        throw new Error(`Maximum quantity per item is ${MAX_QUANTITY_PER_ITEM}`);
      }
      cart.items.push(createItem(input.variantId, input.quantity, input.price, input.properties));
    }
    recalculateTotals(cart);
  };

  setHandler(addItemToCartUpdate, async (input) => {
    log.info('addItemToCartUpdate ENTER', {
      cartId,
      variantId: input.variantId,
      quantity: input.quantity,
      orderComplete,
      shouldExit,
      itemCount: cart.items.length
    });

    const existingItem = cart.items.find((i) => i.variantId === input.variantId);
    const oldQuantity = existingItem ? existingItem.quantity : 0;
    addItem(input);
    const newQuantity = oldQuantity + input.quantity;

    // Reserve inventory: release old reservation (if any) then reserve new total
    if (oldQuantity > 0) {
      await releaseCartItem(cartId, input.variantId);
    }
    await reserveCartItem(storeId, cartId, input.variantId, newQuantity);

    await finalizeUpdate();
    log.info('addItemToCartUpdate EXIT', {
      cartId,
      orderComplete,
      shouldExit,
      itemCount: cart.items.length
    });
    return cart;
  });

  setHandler(updateQuantityUpdate, async (input) => {
    log.info('updateQuantityUpdate ENTER', {
      cartId,
      lineItemId: input.lineItemId,
      quantity: input.quantity,
      orderComplete,
      shouldExit,
      itemCount: cart.items.length
    });
    const item = cart.items.find((i) => i.lineItemId === input.lineItemId);
    if (item) {
      const variantId = item.variantId;
      if (input.quantity <= 0) {
        // Removing item — release reservation
        cart.items = cart.items.filter((i) => i.lineItemId !== input.lineItemId);
        await releaseCartItem(cartId, variantId);
      } else {
        // Quantity change — release old, reserve new
        await releaseCartItem(cartId, variantId);
        item.quantity = input.quantity;
        await reserveCartItem(storeId, cartId, variantId, input.quantity);
      }
      recalculateTotals(cart);
    }
    if (cart.items.length === 0) {
      await abandonCart('updateQuantityUpdate: cart empty');
    } else {
      await finalizeUpdate();
    }
    log.info('updateQuantityUpdate EXIT', {
      cartId,
      orderComplete,
      shouldExit,
      itemCount: cart.items.length,
      status: cart.status
    });
    return cart;
  });

  setHandler(removeItemUpdate, async (input) => {
    log.info('removeItemUpdate ENTER', {
      cartId,
      lineItemId: input.lineItemId,
      orderComplete,
      shouldExit,
      itemCount: cart.items.length
    });
    const removedItem = cart.items.find((i) => i.lineItemId === input.lineItemId);
    cart.items = cart.items.filter((i) => i.lineItemId !== input.lineItemId);
    recalculateTotals(cart);

    // Release inventory reservation for removed item
    if (removedItem) {
      await releaseCartItem(cartId, removedItem.variantId);
    }

    if (cart.items.length === 0) {
      await abandonCart('removeItemUpdate: cart empty');
    } else {
      await finalizeUpdate();
    }
    log.info('removeItemUpdate EXIT', {
      cartId,
      orderComplete,
      shouldExit,
      itemCount: cart.items.length,
      status: cart.status
    });
    return cart;
  });

  setHandler(applyCouponUpdate, async (input) => {
    if (!cart.appliedCoupons.includes(input.code)) {
      cart.appliedCoupons.push(input.code);
      recalculateTotals(cart);
    }
    await finalizeUpdate();
    return cart;
  });

  // ==================
  // Checkout Flow - Spawns Child Workflow
  // ==================

  setHandler(beginCheckoutUpdate, async () => {
    if (cart.items.length === 0) {
      throw new Error('Cannot checkout with empty cart');
    }

    // If already in checkout, clear the stale state so we can start fresh
    if (cart.status === 'checkout' && checkoutWorkflowId) {
      log.info('Re-entering checkout — clearing stale checkout state', { cartId, oldCheckoutWorkflowId: checkoutWorkflowId });
      checkoutWorkflowId = null;
      cart.status = 'active';
    }

    // Generate a UUID-based checkout workflow ID (not tied to cartId)
    checkoutWorkflowId = `checkout-${uuid4()}`;
    const parentCartWorkflowId = `cart-${cartId}`;

    cart.status = 'checkout';
    cart.checkout = {
      step: 'validating',
      isGuest: !cart.userId,
      shippingCost: 0,
      tax: 0
    };

    // Start checkout as a child with ABANDON policy — it survives if this cart is destroyed
    await startChild<
      (input: CheckoutWorkflowInput) => Promise<CheckoutWorkflowResult>
    >('checkoutWorkflow', {
      workflowId: checkoutWorkflowId,
      taskQueue: 'checkout-queue',
      parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
      args: [
        {
          storeId: cart.storeId,
          cartId: cart.cartId,
          parentCartWorkflowId,
          items: cart.items,
          subtotalPrice: cart.subtotalPrice,
          totalDiscounts: cart.totalDiscounts,
          currency: cart.currency,
          appliedCoupons: cart.appliedCoupons,
          isGuest: !cart.userId,
          cartVersion: cart.cartVersion
        }
      ],
      workflowExecutionTimeout: '2 hours'
    });

    log.info('Started checkout child workflow', { cartId, checkoutWorkflowId });

    await finalizeUpdate();
    return cart;
  });

  // Legacy checkout handler (for backwards compatibility)
  setHandler(checkoutUpdate, async () => {
    cart.status = 'completed';
    orderComplete = true;
    await finalizeUpdate();
    return cart;
  });

  // Helper: apply checkout result to cart state
  const applyCheckoutResult = (result: CheckoutWorkflowResult) => {
    cart.checkout = result.finalState;

    if (result.success && result.order) {
      cart.status = 'completed';
      cart.shippingCost = result.finalState.shippingCost;
      cart.totalTax = result.finalState.tax;
      cart.totalPrice =
        cart.subtotalPrice - cart.totalDiscounts + cart.shippingCost + cart.totalTax;
      orderComplete = true;
      log.info('Checkout success, orderComplete=true', { cartId });
    } else if (result.cancelled) {
      cart.status = 'active';
      cart.checkout = undefined;
      checkoutWorkflowId = null;
      log.info('Checkout cancelled, returning to active', { cartId });
    } else {
      // Checkout failed (e.g. timeout, missing items, bad payment)
      // Return to active instead of failing the workflow, so the user doesn't lose their cart items.
      cart.status = 'active';
      cart.checkout = undefined;
      checkoutWorkflowId = null;
      log.info('Checkout failed, protecting cart by returning to active', { cartId, error: result.error });
    }
    syncProjections();
  };

  // Signal handler: checkout workflow signals us with its result
  let checkoutResult: CheckoutWorkflowResult | null = null;
  setHandler(checkoutCompletedSignal, (result) => {
    log.info('Received checkoutCompleted signal', { cartId, success: result.success, cancelled: result.cancelled });
    checkoutResult = result;
  });

  // Adopt a running checkout workflow (used during cart merge)
  setHandler(adoptCheckoutUpdate, async (input) => {
    log.info('Adopting checkout workflow', { cartId, checkoutWorkflowId: input.checkoutWorkflowId });
    checkoutWorkflowId = input.checkoutWorkflowId;
    cart.status = 'checkout';
    cart.checkout = {
      step: 'validating',
      isGuest: !cart.userId,
      shippingCost: 0,
      tax: 0
    };
    await finalizeUpdate();
    return cart;
  });

  // Main workflow loop - keep running until complete or abandoned
  log.info('MAIN LOOP START', { cartId, orderComplete, shouldExit, itemCount: cart.items.length });
  while (!orderComplete && !shouldExit) {
    log.info('LOOP ITERATION: waiting for condition', { cartId, orderComplete, shouldExit, status: cart.status, checkoutWorkflowId });

    // Wait for a state change, checkout completion signal, or checkout initiation
    await condition(
      () =>
        orderComplete || shouldExit || checkoutResult !== null ||
        (cart.status === 'checkout' && checkoutWorkflowId !== null),
      '30 days'
    );

    log.info('LOOP: condition satisfied, waiting for allHandlersFinished', { cartId, orderComplete, shouldExit, status: cart.status, allFinished: allHandlersFinished() });
    await condition(allHandlersFinished);
    log.info('LOOP: allHandlersFinished complete', { cartId, orderComplete, shouldExit, status: cart.status, hasCheckoutResult: checkoutResult !== null });

    // Flush projections
    if (projectionDirty) {
      projectionDirty = false;
      if (cart.items.length === 0 || cart.status === 'abandoned') {
        await deleteCart(cart.cartId);
      } else {
        await indexCart(buildCartDocument(storeId, cart, cart.createdAt));
      }
    }

    // Handle checkout completion signal
    // (getResult helper avoids TypeScript narrowing checkoutResult to 'never' after null-checks,
    // since condition() yields allow signal handlers to reassign it)
    const getResult = () => checkoutResult;
    if (getResult() !== null) {
      const result = getResult()!;
      log.info('LOOP: processing checkout result from signal', { cartId, success: result.success });
      applyCheckoutResult(result);
      checkoutResult = null;
    }

    // If in checkout and no result yet, wait for the signal with a timeout
    if (cart.status === 'checkout' && checkoutWorkflowId !== null && !orderComplete && !shouldExit) {
      log.info('LOOP: waiting for checkout completion signal', { cartId, checkoutWorkflowId });

      const signalReceived = await condition(
        () => checkoutResult !== null || orderComplete || shouldExit,
        '1 hour'
      );

      if (getResult() !== null) {
        const result = getResult()!;
        log.info('LOOP: checkout signal received', { cartId, success: result.success });
        applyCheckoutResult(result);
        checkoutResult = null;
      } else if (!signalReceived && !orderComplete && !shouldExit) {
        // Timeout — the checkout workflow handles its own reservation cleanup on timeout,
        // so we just mark this cart as active again so items are not lost.
        log.warn('Checkout completion signal timed out, protecting cart', { cartId, checkoutWorkflowId });
        cart.status = 'active';
        cart.checkout = undefined;
        checkoutWorkflowId = null;
        syncProjections();
      }
    }
    log.info('LOOP ITERATION END', { cartId, orderComplete, shouldExit });
  }

  log.info('MAIN LOOP EXITED: waiting for final allHandlersFinished', { cartId, orderComplete, shouldExit, allFinished: allHandlersFinished() });
  // Final wait for any handlers still in-flight before workflow completes
  await condition(allHandlersFinished);

  // Final ES cleanup: remove completed/abandoned carts from the index
  if (cart.status === 'completed' || cart.status === 'abandoned') {
    await deleteCart(cart.cartId);
  } else if (projectionDirty) {
    await indexCart(buildCartDocument(storeId, cart, cart.createdAt));
  }

  log.info('cartWorkflow EXITING', { cartId, orderComplete, shouldExit, status: cart.status });
  return cart;
}

function recalculateTotals(cart: CartDetails) {
  cart.subtotalPrice = cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  // Mock discount logic
  cart.totalDiscounts = 0;
  if (cart.appliedCoupons.includes('SAVE20')) {
    cart.totalDiscounts = cart.subtotalPrice * 0.2;
  }

  // Tax is calculated during checkout with shipping address
  // For cart view, we show estimated tax
  cart.totalTax = (cart.subtotalPrice - cart.totalDiscounts) * 0.08;
  cart.totalPrice = cart.subtotalPrice - cart.totalDiscounts + cart.shippingCost + cart.totalTax;
}
