import {
  allHandlersFinished,
  CancelledFailure,
  CancellationScope,
  condition,
  continueAsNew,
  getExternalWorkflowHandle,
  log,
  ParentClosePolicy,
  setHandler,
  startChild,
  uuid4
} from '@temporalio/workflow';
import { reserveCartItem, releaseCartItem, indexCart } from './activities';

import { buildCartDocument } from './document-builder';
import type {
  CartDetails,
  CartEvent,
  CartUpdateResponse,
  CheckoutWorkflowInput,
  CheckoutWorkflowResult
} from './types';

import {
  cartUpdate,
  checkoutCompletedSignal,
  getCartQuery,
  getCheckoutStateQuery,
  getCheckoutWorkflowIdQuery,
  getUserIdQuery
} from './definitions';

// Re-export definitions for worker registration compatibility
export {
  cartUpdate,
  checkoutCompletedSignal,
  getCartQuery,
  getCheckoutStateQuery,
  getCheckoutWorkflowIdQuery,
  getUserIdQuery
};

// ==================
// Continue-as-New Configuration
// ==================
const CONTINUE_AS_NEW_THRESHOLD = 100;

// Input type for Continue-as-New (preserves state across executions)
interface CartWorkflowInput {
  cartId: string;
  initialCart?: CartDetails;
  createdAt?: string;
  updateCount?: number;
  checkoutVersion?: number;
}

// UpdateExchange: the mechanism for the single cartUpdate handler to communicate with the main loop
interface UpdateExchange {
  event: CartEvent;
}

// ==================
// Cart Workflow
// ==================

export async function cartWorkflow(input: CartWorkflowInput | string): Promise<CartDetails> {
  // Handle both legacy string input and new object input
  const {
    cartId,
    initialCart,
    createdAt: inputCreatedAt,
    updateCount: inputUpdateCount,
    checkoutVersion: inputCheckoutVersion
  } = typeof input === 'string'
    ? { cartId: input, initialCart: undefined, createdAt: undefined, updateCount: 0, checkoutVersion: 0 }
    : input;

  // Initialize or restore cart state
  const now = new Date().toISOString();

  const cart: CartDetails = initialCart || {
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
  let checkoutVersion = inputCheckoutVersion || 0;
  let checkoutInProgress = cart.status === 'checkout';
  let checkoutWorkflowId: string | null = null;
  let orderComplete = false;
  let shouldExit = false;

  // UpdateExchange slot — written by the update handler, consumed by the main loop
  const updateExchange: { current: UpdateExchange | null } = { current: null };

  // Checkout completion signal slot
  let checkoutResult: CheckoutWorkflowResult | null = null;

  // ==================
  // Helpers
  // ==================

  const recalculateTotals = () => {
    cart.subtotalPrice = cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    cart.totalDiscounts = 0;
    if (cart.appliedCoupons.includes('SAVE20')) {
      cart.totalDiscounts = cart.subtotalPrice * 0.2;
    }
    cart.totalTax = (cart.subtotalPrice - cart.totalDiscounts) * 0.08;
    cart.totalPrice = cart.subtotalPrice - cart.totalDiscounts + cart.shippingCost + cart.totalTax;
  };

  const flushCart = async () => {
    // Always index — preserve historical data
    await indexCart(buildCartDocument(cart, cart.createdAt));
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

  // ==================
  // Query Handlers
  // ==================
  setHandler(getCartQuery, () => cart);
  setHandler(getCheckoutStateQuery, () => cart.checkout || null);
  setHandler(getCheckoutWorkflowIdQuery, () => checkoutWorkflowId);
  setHandler(getUserIdQuery, () => cart.userId);

  // ==================
  // Signal Handler: Checkout Completed
  // ==================
  setHandler(checkoutCompletedSignal, (result) => {
    log.info('Received checkoutCompleted signal', {
      cartId,
      success: result.success,
      cancelled: result.cancelled,
      signalVersion: result.checkoutVersion,
      currentVersion: checkoutVersion
    });
    // Validate version — ignore stale signals from previous checkout attempts
    if (result.checkoutVersion !== checkoutVersion) {
      log.warn('Ignoring stale checkout signal', {
        cartId,
        signalVersion: result.checkoutVersion,
        currentVersion: checkoutVersion
      });
      return;
    }
    checkoutResult = result;
  });

  // ==================
  // Update Handler: Single entry point for all cart mutations
  // ==================
  setHandler(cartUpdate, async (event: CartEvent): Promise<CartUpdateResponse> => {
    // Write the event to the exchange slot — the main loop will process it
    updateExchange.current = { event };

    // Wait until the main loop has consumed the exchange
    await condition(() => updateExchange.current === null);

    // Return the updated cart state (or void for terminal operations)
    if (event.type === 'destroyCart') return;
    return cart;
  });

  // ==================
  // Main Event Loop
  // ==================
  log.info('cartWorkflow STARTED', { cartId, updateCount, checkoutVersion });

  try {
    while (!orderComplete && !shouldExit) {
    // Wait for: an update event, a checkout completion signal, or 30 day timeout
    const woke = await condition(
      () => updateExchange.current !== null || checkoutResult !== null,
      '30 days'
    );

    if (!woke) {
      // 30-day idle timeout — abandon cart
      log.warn('Cart idle timeout, abandoning', { cartId });
      cart.status = 'abandoned';
      await flushCart();
      shouldExit = true;
      continue;
    }

    // ── Process checkout completion signal ──
    // (getResult helper avoids TypeScript narrowing checkoutResult to 'never' after null-checks,
    // since condition() yields allow signal handlers to reassign it)
    const getResult = () => checkoutResult;
    if (getResult() !== null) {
      const result = getResult()!;
      checkoutResult = null;

      if (result.success && result.order) {
        cart.checkout = result.finalState;
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
        checkoutInProgress = false;
        log.info('Checkout cancelled, returning to active', { cartId });
      } else {
        // Checkout failed (timeout, missing items, bad payment)
        cart.status = 'active';
        cart.checkout = undefined;
        checkoutWorkflowId = null;
        checkoutInProgress = false;
        log.info('Checkout failed, protecting cart by returning to active', { cartId, error: result.error });
      }
      await flushCart();
      continue;
    }

    // ── Process update event ──
    if (updateExchange.current !== null) {
      const { event } = updateExchange.current;

      try {
        switch (event.type) {
          // ── Item Management ──
          case 'addItem': {
            if (event.quantity <= 0) break;
            const MAX_ITEMS = 10;
            const MAX_QUANTITY_PER_ITEM = 100;

            const existingItem = cart.items.find((i) => i.variantId === event.variantId);
            const oldQuantity = existingItem ? existingItem.quantity : 0;

            if (existingItem) {
              const newQuantity = existingItem.quantity + event.quantity;
              if (newQuantity > MAX_QUANTITY_PER_ITEM) {
                throw new Error(`Maximum quantity per item is ${MAX_QUANTITY_PER_ITEM}`);
              }
              existingItem.quantity = newQuantity;
            } else {
              if (cart.items.length >= MAX_ITEMS) {
                throw new Error(`Maximum ${MAX_ITEMS} items allowed in cart`);
              }
              if (event.quantity > MAX_QUANTITY_PER_ITEM) {
                throw new Error(`Maximum quantity per item is ${MAX_QUANTITY_PER_ITEM}`);
              }
              cart.items.push(createItem(event.variantId, event.quantity, event.price, event.properties));
            }
            recalculateTotals();

            // Reserve inventory: release old reservation (if any) then reserve new total
            if (oldQuantity > 0) {
              await releaseCartItem(cartId, event.variantId);
            }
            await reserveCartItem(cartId, event.variantId, oldQuantity + event.quantity);
            break;
          }

          case 'updateQuantity': {
            const item = cart.items.find((i) => i.lineItemId === event.lineItemId);
            if (item) {
              const variantId = item.variantId;
              if (event.quantity <= 0) {
                cart.items = cart.items.filter((i) => i.lineItemId !== event.lineItemId);
                await releaseCartItem(cartId, variantId);
              } else {
                await releaseCartItem(cartId, variantId);
                item.quantity = event.quantity;
                await reserveCartItem(cartId, variantId, event.quantity);
              }
              recalculateTotals();
            }
            if (cart.items.length === 0) {
              cart.status = 'abandoned';
              shouldExit = true;
            }
            break;
          }

          case 'removeItem': {
            const removedItem = cart.items.find((i) => i.lineItemId === event.lineItemId);
            cart.items = cart.items.filter((i) => i.lineItemId !== event.lineItemId);
            recalculateTotals();
            if (removedItem) {
              await releaseCartItem(cartId, removedItem.variantId);
            }
            if (cart.items.length === 0) {
              cart.status = 'abandoned';
              shouldExit = true;
            }
            break;
          }

          case 'applyCoupon': {
            if (!cart.appliedCoupons.includes(event.code)) {
              cart.appliedCoupons.push(event.code);
              recalculateTotals();
            }
            break;
          }

          // ── User-Cart Linking ──
          case 'linkUser': {
            cart.userId = event.userId;
            break;
          }

          case 'mergeCarts': {
            for (const sourceItem of event.sourceItems) {
              const existingItem = cart.items.find((item) => item.variantId === sourceItem.variantId);
              if (existingItem) {
                existingItem.quantity += sourceItem.quantity;
              } else {
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
            recalculateTotals();

            // If the source cart had a running checkout, adopt it
            if (event.checkoutWorkflowId) {
              log.info('Merge: adopting checkout from source cart', { cartId, checkoutWorkflowId: event.checkoutWorkflowId });
              checkoutWorkflowId = event.checkoutWorkflowId;
              checkoutInProgress = true;
              checkoutVersion++;
              cart.status = 'checkout';
              cart.checkout = {
                step: 'validating',
                isGuest: !cart.userId,
                shippingCost: 0,
                tax: 0
              };
            }
            break;
          }

          // ── Checkout Lifecycle ──
          case 'beginCheckout': {
            if (cart.items.length === 0) {
              throw new Error('Cannot checkout with empty cart');
            }
            // Duplicate checkout guard
            if (checkoutInProgress) {
              log.warn('beginCheckout rejected: checkout already in progress', { cartId, checkoutWorkflowId });
              break;
            }

            checkoutVersion++;
            checkoutWorkflowId = `checkout-${uuid4()}`;
            checkoutInProgress = true;
            const parentCartWorkflowId = `cart-${cartId}`;

            cart.status = 'checkout';
            cart.checkout = {
              step: 'validating',
              isGuest: !cart.userId,
              shippingCost: 0,
              tax: 0
            };

            // Start checkout as child — REQUEST_CANCEL so cart cleanup cancels checkout
            await startChild<
              (input: CheckoutWorkflowInput) => Promise<CheckoutWorkflowResult>
            >('checkoutWorkflow', {
              workflowId: checkoutWorkflowId,
              taskQueue: 'checkout-queue',
              parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_REQUEST_CANCEL,
              args: [
                {
                  cartId: cart.cartId,
                  parentCartWorkflowId,
                  items: cart.items,
                  subtotalPrice: cart.subtotalPrice,
                  totalDiscounts: cart.totalDiscounts,
                  currency: cart.currency,
                  appliedCoupons: cart.appliedCoupons,
                  isGuest: !cart.userId,
                  cartVersion: cart.cartVersion,
                  checkoutVersion
                }
              ],
              workflowExecutionTimeout: '2 hours'
            });

            log.info('Started checkout child workflow', { cartId, checkoutWorkflowId, checkoutVersion });
            break;
          }

          case 'adoptCheckout': {
            log.info('Adopting checkout workflow', { cartId, checkoutWorkflowId: event.checkoutWorkflowId });
            checkoutWorkflowId = event.checkoutWorkflowId;
            checkoutInProgress = true;
            checkoutVersion++;
            cart.status = 'checkout';
            cart.checkout = {
              step: 'validating',
              isGuest: !cart.userId,
              shippingCost: 0,
              tax: 0
            };
            break;
          }

          case 'disownCheckout': {
            log.info('Disowning checkout — will not cancel', { cartId, checkoutWorkflowId });
            checkoutWorkflowId = null;
            checkoutInProgress = false;
            cart.status = 'active';
            cart.checkout = undefined;
            break;
          }

          case 'destroyCart': {
            log.info('destroyCart', { cartId });
            // Cancel child checkout if still running
            if (checkoutInProgress && checkoutWorkflowId) {
              try {
                const handle = getExternalWorkflowHandle(checkoutWorkflowId);
                await handle.cancel();
              } catch {
                log.warn('Failed to cancel checkout during destroy', { cartId, checkoutWorkflowId });
              }
            }
            // Release all inventory reservations
            for (const item of cart.items) {
              await releaseCartItem(cartId, item.variantId);
            }
            cart.status = 'abandoned';
            shouldExit = true;
            break;
          }
        }
      } catch (err) {
        if (err instanceof CancelledFailure) throw err;
        log.error('Error processing cart event', { cartId, eventType: event.type, error: String(err) });
      }

      // Clear the exchange — signals the update handler to return
      updateExchange.current = null;

      // Flush projections
      await flushCart();

      // Increment update count and check ContinueAsNew threshold
      updateCount++;
      cart.cartVersion = (cart.cartVersion || 0) + 1;
      cart.updatedAt = new Date().toISOString();

      if (updateCount >= CONTINUE_AS_NEW_THRESHOLD && !orderComplete && !shouldExit) {
        await condition(allHandlersFinished);
        await continueAsNew<typeof cartWorkflow>({
          cartId,
          initialCart: cart,
          createdAt: cart.createdAt,
          updateCount: 0,
          checkoutVersion
        });
      }
    }
  }
} catch (err) {
    if (err instanceof CancelledFailure) {
      log.warn('Cart workflow cancelled', { cartId });
      cart.status = 'abandoned';
      shouldExit = true;
    } else {
      throw err;
    }
  } finally {
    await CancellationScope.nonCancellable(async () => {
      log.info('cartWorkflow EXITING: waiting for final allHandlersFinished', { cartId, orderComplete, shouldExit });
      try {
        await condition(allHandlersFinished);
      } catch {
        // ignore
      }

      // Cancel child checkout if we're exiting without order completion
      if (!orderComplete && checkoutInProgress && checkoutWorkflowId) {
        try {
          const handle = getExternalWorkflowHandle(checkoutWorkflowId);
          await handle.cancel();
        } catch {
          log.warn('Failed to cancel checkout on exit', { cartId, checkoutWorkflowId });
        }
      }

      // Release all inventory reservations if abandoned or cancelled
      if (!orderComplete && (cart.status === 'abandoned' || shouldExit)) {
        log.info('Releasing all cart reservations on workflow exit', { cartId });
        for (const item of cart.items) {
          try {
            await releaseCartItem(cartId, item.variantId);
          } catch (e) {
            log.error('Failed to release item reservation on exit', { cartId, variantId: item.variantId, error: String(e) });
          }
        }
      }

      // Final projection
      try {
        await flushCart();
      } catch {
        // ignore
      }
    });
  }

  log.info('cartWorkflow EXITED', { cartId, orderComplete, shouldExit, status: cart.status });
  return cart;
}
