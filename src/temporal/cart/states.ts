/**
 * Cart states — the shell around the pure cart Decider (prepare → decide → finalize).
 *
 * `decide` (cart-decider.ts) emits facts; `evolve` folds them — the ONLY writer of cart
 * contents / status / checkout link. Every side effect (inventory reservations, the checkout
 * child, id generation) stays in the shell `prepare` handlers below. The command is enriched
 * here with shell-provided data (a generated lineItemId, the started child's id) before it
 * reaches decide.
 */
import { log, startChild, ParentClosePolicy, uuid4 } from '@temporalio/workflow';
import { reserveCartItem, releaseCartItem } from './activities';
import { buildCheckoutInput } from './cart-logic';
import { decide as cartDecide, evolve } from './cart-decider';
import type { CartCommand } from './cart-decider';
import type {
  CartEvent,
  CartUpdateResponse,
  CheckoutWorkflowResult,
  CheckoutWorkflowInput,
  CartStateName,
  CartWorkflowContext,
} from './types';
import { defineDomain, terminal, SELF } from '../framework';
import type { StateRegistry, TransitionMap } from '../framework';
import { buildWorkflowId, buildWorkflowStartOptions, DEMO_STORE_ID } from '../contracts/constants';

// ==================
// Domain factory — binds the shared type params once
// ==================

const cart = defineDomain<
  CartStateName,
  CartEvent,
  CartWorkflowContext,
  CartUpdateResponse,
  CheckoutWorkflowResult
>();

type CartTransitions = TransitionMap<
  CartStateName,
  CartWorkflowContext,
  CartUpdateResponse,
  CartEvent
>;

// ==================
// Shell adapter — runs the pure Decider behind the driver.
// ==================

function apply(ctx: Readonly<CartWorkflowContext>, command: CartCommand): CartWorkflowContext {
  const state = ctx as CartWorkflowContext;
  return cartDecide(command, state).reduce(evolve, state);
}

// ==================
// State: active — co-located per-event transitions
//
// The cart owns reservation writes (in `prepare`). A failed reservation is reported as a
// prepared error (never thrown) so decide can reject the edit and keep the cart unchanged —
// matching the pre-refactor behavior where the Server Action receives `error`, not a failure.
// Emptying the cart routes to `terminal('abandoned')` (the decider emits `CartAbandoned`);
// the cart's onTerminal then cancels any checkout child.
// ==================

const activeTransitions: CartTransitions = {
  addItem: {
    async prepare(ctx, event) {
      const lineItemId = uuid4();
      const existing = ctx.cart.items.find((i) => i.variantId === event.variantId);
      const oldQty = existing ? existing.quantity : 0;
      const newQty = oldQty + event.quantity;

      // Release existing reservation before re-reserving at the new quantity
      if (oldQty > 0) await releaseCartItem(ctx.cart.cartId, event.variantId);
      const reservationId = await reserveCartItem(ctx.cart.cartId, event.variantId, newQty);

      if (!reservationId) {
        // Reservation failed — re-reserve at the old quantity if we released
        if (oldQty > 0) await reserveCartItem(ctx.cart.cartId, event.variantId, oldQty);
        return { lineItemId, reserveError: `Insufficient inventory for variant ${event.variantId}` };
      }
      return { lineItemId, reserveError: undefined };
    },
    decide(ctx, event, _meta, prepared) {
      if (prepared.reserveError) {
        return { context: ctx as CartWorkflowContext, next: SELF, error: prepared.reserveError };
      }
      const context = apply(ctx, {
        type: 'addItem',
        variantId: event.variantId,
        quantity: event.quantity,
        price: event.price,
        properties: event.properties,
        lineItemId: prepared.lineItemId,
      });
      return { context, next: SELF, response: context.cart };
    },
  },

  updateQuantity: {
    async prepare(ctx, event) {
      const item = ctx.cart.items.find((i) => i.lineItemId === event.lineItemId);
      if (!item) return { reserveError: undefined };
      const variantId = item.variantId;
      if (event.quantity <= 0) {
        await releaseCartItem(ctx.cart.cartId, variantId);
        return { reserveError: undefined };
      }
      await releaseCartItem(ctx.cart.cartId, variantId);
      const reservationId = await reserveCartItem(ctx.cart.cartId, variantId, event.quantity);
      if (!reservationId) {
        // Re-reserve at the old quantity
        await reserveCartItem(ctx.cart.cartId, variantId, item.quantity);
        return {
          reserveError: `Insufficient inventory to update quantity for variant ${variantId}`,
        };
      }
      return { reserveError: undefined };
    },
    decide(ctx, event, _meta, prepared) {
      if (prepared.reserveError) {
        return { context: ctx as CartWorkflowContext, next: SELF, error: prepared.reserveError };
      }
      const context = apply(ctx, {
        type: 'updateQuantity',
        lineItemId: event.lineItemId,
        quantity: event.quantity,
      });
      if (context.cart.items.length === 0) {
        return { context, next: terminal('abandoned'), response: context.cart };
      }
      return { context, next: SELF, response: context.cart };
    },
  },

  removeItem: {
    async prepare(ctx, event) {
      const removed = ctx.cart.items.find((i) => i.lineItemId === event.lineItemId);
      if (removed) await releaseCartItem(ctx.cart.cartId, removed.variantId);
    },
    decide(ctx, event) {
      const context = apply(ctx, { type: 'removeItem', lineItemId: event.lineItemId });
      if (context.cart.items.length === 0) {
        return { context, next: terminal('abandoned'), response: context.cart };
      }
      return { context, next: SELF, response: context.cart };
    },
  },

  applyCoupon: {
    decide(ctx, event) {
      const context = apply(ctx, { type: 'applyCoupon', code: event.code });
      return { context, next: SELF, response: context.cart };
    },
  },

  linkUser: {
    decide(ctx, event) {
      const context = apply(ctx, { type: 'linkUser', email: event.email, userId: event.userId });
      return { context, next: SELF, response: context.cart };
    },
  },

  beginCheckout: {
    async prepare(ctx) {
      if (ctx.cart.items.length === 0) {
        return { empty: true as const };
      }

      const parentCartWorkflowId = buildWorkflowId(DEMO_STORE_ID, 'cart', ctx.cart.cartId);
      // A fresh checkout id per attempt, tagged with the cart's correlation id so the
      // whole journey is queryable (ADR-0011).
      const checkoutStart = buildWorkflowStartOptions({
        storeId: DEMO_STORE_ID,
        domain: 'checkout',
        entityId: uuid4(),
        cartId: ctx.cart.cartId,
      });
      const newCheckoutWorkflowId = checkoutStart.workflowId;
      const newCheckoutVersion = ctx.checkoutVersion + 1;

      await startChild<(input: CheckoutWorkflowInput) => Promise<CheckoutWorkflowResult>>(
        'checkoutWorkflow',
        {
          ...checkoutStart,
          taskQueue: 'checkout-queue',
          parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_REQUEST_CANCEL,
          args: [
            {
              ...buildCheckoutInput(ctx.cart, parentCartWorkflowId),
              checkoutVersion: newCheckoutVersion,
            },
          ],
          workflowExecutionTimeout: '2 hours',
        },
      );

      log.info('Started checkout child workflow', {
        cartId: ctx.cart.cartId,
        checkoutWorkflowId: newCheckoutWorkflowId,
      });

      return { empty: false as const, newCheckoutWorkflowId };
    },
    decide(ctx, _event, _meta, prepared) {
      if (prepared.empty) {
        return {
          context: ctx as CartWorkflowContext,
          next: 'active' as const,
          error: 'Cannot checkout with empty cart',
        };
      }
      const context = apply(ctx, {
        type: 'beginCheckout',
        checkoutWorkflowId: prepared.newCheckoutWorkflowId,
      });
      return { context, next: 'checkout' as const, response: context.cart };
    },
  },
};

const active = cart.transitions('active', activeTransitions, {
  onTimeout: {
    decide(ctx) {
      // Idle timeout: abandon cart
      const context = evolve(ctx as CartWorkflowContext, { type: 'CartAbandoned' });
      return { context, next: terminal('abandoned') };
    },
  },
  onSignal: {
    decide(ctx) {
      // Ignore completion signals from stale checkouts in active state
      return { context: ctx as CartWorkflowContext, next: 'active' as const };
    },
  },
});

// ==================
// State: checkout — cart edits are rejected while the checkout child drives the order;
// the completion signal (or a timeout protecting the cart) moves the machine on.
// ==================

/** Reject any cart edit while checkout is in progress (pre-refactor behavior). */
function rejectDuringCheckout(ctx: Readonly<CartWorkflowContext>, eventType: CartEvent['type']) {
  return {
    context: ctx as CartWorkflowContext,
    next: SELF,
    error: `Cannot '${eventType}' while checkout is in progress`,
  };
}

const checkoutTransitions: CartTransitions = {
  addItem: { decide: (ctx, e) => rejectDuringCheckout(ctx, e.type) },
  updateQuantity: { decide: (ctx, e) => rejectDuringCheckout(ctx, e.type) },
  removeItem: { decide: (ctx, e) => rejectDuringCheckout(ctx, e.type) },
  applyCoupon: { decide: (ctx, e) => rejectDuringCheckout(ctx, e.type) },
  linkUser: { decide: (ctx, e) => rejectDuringCheckout(ctx, e.type) },
  beginCheckout: { decide: (ctx, e) => rejectDuringCheckout(ctx, e.type) },
};

const checkout = cart.transitions('checkout', checkoutTransitions, {
  onTimeout: {
    decide(ctx) {
      // Checkout timed out — return to active state (preserve the cart, not abandon).
      log.warn('Checkout completion signal timed out, protecting cart', {
        cartId: ctx.cart.cartId,
      });
      const context = evolve(ctx as CartWorkflowContext, { type: 'CheckoutDisowned' });
      return { context, next: 'active' as const };
    },
  },
  onSignal: {
    decide(ctx, result) {
      // Ignore stale signals from a previous checkout attempt.
      if (result.checkoutVersion !== undefined && result.checkoutVersion !== ctx.checkoutVersion) {
        log.warn('Ignoring stale checkout signal', {
          cartId: ctx.cart.cartId,
          expected: ctx.checkoutVersion,
          received: result.checkoutVersion,
        });
        return { context: ctx as CartWorkflowContext, next: 'checkout' as const };
      }

      const context = apply(ctx, { type: 'checkoutCompleted', result });
      if (context.cart.status === 'completed') {
        return { context, next: terminal('completed') };
      }
      log.info('Checkout cancelled/failed, returning to active', { cartId: ctx.cart.cartId });
      return { context, next: 'active' as const };
    },
  },
});

// ==================
// Registry
// ==================

export const CART_STATES: StateRegistry<
  CartStateName,
  CartEvent,
  CartWorkflowContext,
  CartUpdateResponse,
  CheckoutWorkflowResult
> = {
  active: { ...active, timeout: '30 days' },
  checkout: { ...checkout, timeout: '1 hour' },
};
