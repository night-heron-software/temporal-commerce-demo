import { log, startChild, ParentClosePolicy, uuid4 } from '@temporalio/workflow';
import { reserveCartItem, releaseCartItem } from './activities';
import type {
  CartDetails,
  CartEvent,
  CartUpdateResponse,
  CheckoutWorkflowResult,
  CheckoutWorkflowInput,
  CartStateName,
  CartWorkflowContext,
} from './types';
import { StateInput, StateOutput, StateRegistry } from '../framework';

// ==================
// Helpers
// ==================

/** Deep-copy just the cart for immutability. */
function copyCart(cart: CartDetails): CartDetails {
  return { ...cart, items: cart.items.map((i) => ({ ...i })) };
}

/** Set checkout fields on a cart draft. */
function initCheckoutFields(cart: CartDetails): void {
  cart.status = 'checkout';
  cart.checkout = { step: 'validating', isGuest: !cart.userId, shippingCost: 0, tax: 0 };
}

function recalculateTotals(cart: CartDetails): void {
  cart.subtotalPrice = cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  cart.totalDiscounts = 0;
  if (cart.appliedCoupons.includes('SAVE20')) {
    cart.totalDiscounts = cart.subtotalPrice * 0.2;
  }
  cart.totalTax = (cart.subtotalPrice - cart.totalDiscounts) * 0.08;
  cart.totalPrice = cart.subtotalPrice - cart.totalDiscounts + cart.shippingCost + cart.totalTax;
}

function createItem(
  variantId: string,
  quantity: number,
  price: number,
  properties?: Record<string, unknown>
) {
  return {
    lineItemId: uuid4(),
    variantId,
    quantity,
    price,
    properties
  };
}

function buildCheckoutInput(cart: CartDetails, parentCartWorkflowId: string) {
  return {
    cartId: cart.cartId,
    parentCartWorkflowId,
    items: cart.items,
    subtotalPrice: cart.subtotalPrice,
    totalDiscounts: cart.totalDiscounts,
    currency: cart.currency,
    appliedCoupons: cart.appliedCoupons,
    isGuest: !cart.userId,
    cartVersion: cart.cartVersion,
  };
}

// ==================
// State Functions
// ==================

export async function activeState(
  ctx: Readonly<CartWorkflowContext>,
  input: StateInput<CartEvent, CheckoutWorkflowResult>,
): Promise<StateOutput<CartStateName, CartWorkflowContext, CartUpdateResponse>> {
  if (input.kind === 'timeout') {
    // Idle timeout: abandon cart
    const draft = copyCart(ctx.cart);
    draft.status = 'abandoned';
    return {
      context: { ...ctx, cart: draft },
      next: '__terminal:abandoned',
    };
  }

  if (input.kind === 'signal') {
    // Ignore completion signals from stale checkouts in active state
    return { context: ctx, next: 'active' };
  }

  const event = input.event;
  const draft = copyCart(ctx.cart);

  switch (event.type) {
    case 'addItem': {
      const existing = draft.items.find((i) => i.variantId === event.variantId);
      const oldQty = existing ? existing.quantity : 0;

      if (existing) {
        existing.quantity += event.quantity;
      } else {
        draft.items.push(createItem(event.variantId, event.quantity, event.price, event.properties));
      }
      const newQty = oldQty + event.quantity;

      if (oldQty > 0) await releaseCartItem(ctx.cart.cartId, event.variantId);
      await reserveCartItem(ctx.cart.cartId, event.variantId, newQty);

      recalculateTotals(draft);
      const nextCtx = { ...ctx, cart: draft };
      return { context: nextCtx, next: 'active', response: draft };
    }

    case 'updateQuantity': {
      const item = draft.items.find((i) => i.lineItemId === event.lineItemId);
      let nextState: CartStateName | '__terminal:abandoned' = 'active';
      if (item) {
        const variantId = item.variantId;
        if (event.quantity <= 0) {
          draft.items = draft.items.filter((i) => i.lineItemId !== event.lineItemId);
          await releaseCartItem(ctx.cart.cartId, variantId);
        } else {
          await releaseCartItem(ctx.cart.cartId, variantId);
          item.quantity = event.quantity;
          await reserveCartItem(ctx.cart.cartId, variantId, event.quantity);
        }
        recalculateTotals(draft);
      }

      if (draft.items.length === 0) {
        draft.status = 'abandoned';
        nextState = '__terminal:abandoned';
      }

      const nextCtx = { ...ctx, cart: draft };
      return { context: nextCtx, next: nextState, response: draft };
    }

    case 'removeItem': {
      const removed = draft.items.find((i) => i.lineItemId === event.lineItemId);
      draft.items = draft.items.filter((i) => i.lineItemId !== event.lineItemId);
      recalculateTotals(draft);
      if (removed) await releaseCartItem(ctx.cart.cartId, removed.variantId);

      let nextState: CartStateName | '__terminal:abandoned' = 'active';
      if (draft.items.length === 0) {
        draft.status = 'abandoned';
        nextState = '__terminal:abandoned';
      }

      const nextCtx = { ...ctx, cart: draft };
      return { context: nextCtx, next: nextState, response: draft };
    }

    case 'applyCoupon': {
      if (!draft.appliedCoupons.includes(event.code)) {
        draft.appliedCoupons.push(event.code);
        recalculateTotals(draft);
      }
      const nextCtx = { ...ctx, cart: draft };
      return { context: nextCtx, next: 'active', response: draft };
    }

    case 'linkUser': {
      draft.userId = event.userId;
      const nextCtx = { ...ctx, cart: draft };
      return { context: nextCtx, next: 'active', response: draft };
    }

    case 'mergeCarts': {
      for (const sourceItem of event.sourceItems) {
        const existing = draft.items.find((i) => i.variantId === sourceItem.variantId);
        if (existing) {
          existing.quantity += sourceItem.quantity;
        } else {
          draft.items.push(createItem(sourceItem.variantId, sourceItem.quantity, sourceItem.price, sourceItem.properties));
        }
      }
      recalculateTotals(draft);

      let next: CartStateName = 'active';
      let checkoutWorkflowId = ctx.checkoutWorkflowId;
      let checkoutVersion = ctx.checkoutVersion;
      if (event.checkoutWorkflowId) {
        initCheckoutFields(draft);
        checkoutWorkflowId = event.checkoutWorkflowId;
        checkoutVersion++;
        next = 'checkout';
      }
      const nextCtx = { cart: draft, checkoutWorkflowId, checkoutVersion };
      return { context: nextCtx, next, response: draft };
    }

    case 'adoptCheckout': {
      initCheckoutFields(draft);
      const nextCtx = {
        cart: draft,
        checkoutWorkflowId: event.checkoutWorkflowId,
        checkoutVersion: ctx.checkoutVersion + 1,
      };
      return { context: nextCtx, next: 'checkout', response: draft };
    }

    case 'beginCheckout': {
      if (draft.items.length === 0) {
        return { context: ctx, next: 'active', error: 'Cannot checkout with empty cart' };
      }

      const newCheckoutWorkflowId = `checkout-${uuid4()}`;
      const parentCartWorkflowId = `cart-${ctx.cart.cartId}`;
      const newCheckoutVersion = ctx.checkoutVersion + 1;

      initCheckoutFields(draft);

      // Start child checkout workflow
      await startChild<(input: CheckoutWorkflowInput) => Promise<CheckoutWorkflowResult>>(
        'checkoutWorkflow',
        {
          workflowId: newCheckoutWorkflowId,
          taskQueue: 'checkout-queue',
          parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_REQUEST_CANCEL,
          args: [{ ...buildCheckoutInput(draft, parentCartWorkflowId), checkoutVersion: newCheckoutVersion }],
          workflowExecutionTimeout: '2 hours',
        },
      );

      log.info('Started checkout child workflow', {
        cartId: ctx.cart.cartId,
        checkoutWorkflowId: newCheckoutWorkflowId,
      });

      const nextCtx = {
        cart: draft,
        checkoutWorkflowId: newCheckoutWorkflowId,
        checkoutVersion: newCheckoutVersion,
      };
      return { context: nextCtx, next: 'checkout', response: draft };
    }

    case 'destroyCart': {
      for (const item of draft.items) {
        await releaseCartItem(ctx.cart.cartId, item.variantId);
      }
      draft.status = 'abandoned';
      const nextCtx = { ...ctx, cart: draft };
      return { context: nextCtx, next: '__terminal:abandoned', response: draft };
    }

    default:
      return { context: ctx, next: 'active', error: `Unexpected event in active state` };
  }
}

export async function checkoutState(
  ctx: Readonly<CartWorkflowContext>,
  input: StateInput<CartEvent, CheckoutWorkflowResult>,
): Promise<StateOutput<CartStateName, CartWorkflowContext, CartUpdateResponse>> {
  const draft = copyCart(ctx.cart);

  if (input.kind === 'timeout') {
    // Checkout timed out — return to active state
    log.warn('Checkout completion signal timed out, protecting cart', {
      cartId: ctx.cart.cartId,
    });
    draft.status = 'active';
    draft.checkout = undefined;
    const nextCtx = { ...ctx, cart: draft, checkoutWorkflowId: null };
    return { context: nextCtx, next: 'active' };
  }

  // Handle Signal
  if (input.kind === 'signal') {
    const result = input.result;

    // Ignore stale signals from a previous checkout attempt
    if (result.checkoutVersion !== undefined && result.checkoutVersion !== ctx.checkoutVersion) {
      log.warn('Ignoring stale checkout signal', {
        cartId: ctx.cart.cartId,
        expected: ctx.checkoutVersion,
        received: result.checkoutVersion,
      });
      return { context: ctx, next: 'checkout' };
    }

    if (result.success && result.order) {
      draft.status = 'completed';
      draft.checkout = result.finalState;
      draft.shippingCost = result.finalState.shippingCost;
      draft.totalTax = result.finalState.tax;
      draft.totalPrice =
        ctx.cart.subtotalPrice -
        ctx.cart.totalDiscounts +
        result.finalState.shippingCost +
        result.finalState.tax;
      const nextCtx = { ...ctx, cart: draft };
      return { context: nextCtx, next: '__terminal:completed' };
    }

    // Cancelled or failed — return to active state
    draft.status = 'active';
    draft.checkout = undefined;
    log.info('Checkout cancelled/failed, returning to active', { cartId: ctx.cart.cartId });
    const nextCtx = { ...ctx, cart: draft, checkoutWorkflowId: null };
    return { context: nextCtx, next: 'active' };
  }

  const event = input.event;
  switch (event.type) {
    case 'disownCheckout': {
      draft.checkout = undefined;
      draft.status = 'active';
      const nextCtx = { ...ctx, cart: draft, checkoutWorkflowId: null };
      return { context: nextCtx, next: 'active', response: draft };
    }

    case 'destroyCart': {
      for (const item of draft.items) {
        await releaseCartItem(ctx.cart.cartId, item.variantId);
      }
      draft.status = 'abandoned';
      const nextCtx = { ...ctx, cart: draft };
      return { context: nextCtx, next: '__terminal:abandoned', response: draft };
    }

    case 'linkUser': {
      draft.userId = event.userId;
      const nextCtx = { ...ctx, cart: draft };
      return { context: nextCtx, next: 'checkout', response: draft };
    }

    default: {
      return {
        context: ctx,
        next: 'checkout',
        error: `Cannot '${event.type}' while checkout is in progress`,
      };
    }
  }
}

export const CART_STATES: StateRegistry<
  CartStateName,
  CartEvent,
  CartWorkflowContext,
  CartUpdateResponse,
  CheckoutWorkflowResult
> = {
  active: { fn: activeState, timeout: '30 days' },
  checkout: { fn: checkoutState, timeout: '1 hour' },
};
