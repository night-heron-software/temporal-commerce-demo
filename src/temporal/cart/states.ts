import {
  log,
  startChild,
  getExternalWorkflowHandle,
  defineSignal,
  ParentClosePolicy,
  uuid4,
  ApplicationFailure,
} from '@temporalio/workflow';
import { reserveCartItem, releaseCartItem } from './activities';
import { buildCheckoutInput } from './cart-logic';
import { cartDecider } from './cart-decider';
import type { CartEvent } from './cart-decider';
import type {
  CartCommand,
  CartUpdateResponse,
  CheckoutWorkflowResult,
  CheckoutWorkflowInput,
  CartStateName,
  CartWorkflowContext,
} from './types';
import { defineMachine, reject, terminal, SELF, workflowCorrelationId } from '../framework';
import type { CommandHandler, EffectsMap, Rejection, StateRegistry } from '../framework';
import { buildWorkflowId, buildWorkflowStartOptions, DEMO_STORE_ID } from '../contracts/constants';

// ==================
// The machine (ADR-0024 decider-native surface, aligned with nightheron-mono).
//
// The framework owns the fold: each accepted command runs guard → prepare → decide →
// evolve, and routing keys on the EMITTED EVENTS — the shell never re-derives what the
// decider said (emptying the cart routes on `CartAbandoned`, not on a re-checked
// `items.length === 0`). `evolve` stamps `updatedAt`/`cartVersion` on every fold, so the
// old onTransition bump-and-flush is gone. A command a state does not list is
// REJECTED: typed error to the caller, no transition, no recording, no projection.
// ==================

const m = defineMachine<
  CartStateName,
  CartCommand,
  CartEvent,
  CartWorkflowContext,
  CartUpdateResponse
>({
  decider: cartDecider,
  respond: (ctx) => ctx.cart,
});

/**
 * Reject a cart edit while the checkout child is placing the order. Shared by both
 * states: in `active` a submit is never in progress, so the guard is inert there; in
 * `checkout` it holds the cart still for the saga. Guards run BEFORE `prepare`, so no
 * reservation write can happen on a rejected edit — the old mirrored prepare/decide checks
 * are unnecessary by construction.
 */
function notWhileSubmitting(ctx: Readonly<CartWorkflowContext>): Rejection | undefined {
  return ctx.submitting ? reject('Order is being placed — please wait') : undefined;
}

type Handler<K extends CartCommand['type']> = CommandHandler<
  CartWorkflowContext,
  Extract<CartCommand, { type: K }>,
  CartEvent,
  CartUpdateResponse
>;

// ==================
// Shared command handlers — the cart stays editable in BOTH `active` and `checkout`;
// the handlers are genuinely identical, and each state's route table decides where the
// resulting events lead. The cart owns reservation writes (in `prepare`); a prepare
// throw is a rejection. Demo divergence from mono: reservations are per-variant
// release-then-re-reserve (no sku resolution, no ADR-0022 absolute holds), so a failed
// re-reserve compensates by restoring the old quantity before throwing.
// ==================

const addItem: Handler<'addItem'> = {
  guard: notWhileSubmitting,
  async prepare(ctx, command) {
    const lineItemId = uuid4();
    const existing = ctx.cart.items.find((i) => i.variantId === command.variantId);
    const oldQty = existing ? existing.quantity : 0;
    const newQty = oldQty + command.quantity;

    // Release existing reservation before re-reserving at the new quantity
    if (oldQty > 0) await releaseCartItem(ctx.cart.cartId, command.variantId);
    const reservationId = await reserveCartItem(ctx.cart.cartId, command.variantId, newQty);

    if (!reservationId) {
      // Reservation failed — re-reserve at the old quantity if we released
      if (oldQty > 0) await reserveCartItem(ctx.cart.cartId, command.variantId, oldQty);
      throw ApplicationFailure.nonRetryable(
        `Insufficient inventory for variant ${command.variantId}`,
        'OutOfStockError',
      );
    }
    return { lineItemId };
  },
};

const updateQuantity: Handler<'updateQuantity'> = {
  guard: notWhileSubmitting,
  async prepare(ctx, command) {
    const item = ctx.cart.items.find((i) => i.lineItemId === command.lineItemId);
    if (!item) return;
    const variantId = item.variantId;
    if (command.quantity <= 0) {
      await releaseCartItem(ctx.cart.cartId, variantId);
      return;
    }
    await releaseCartItem(ctx.cart.cartId, variantId);
    const reservationId = await reserveCartItem(ctx.cart.cartId, variantId, command.quantity);
    if (!reservationId) {
      // Re-reserve at the old quantity
      await reserveCartItem(ctx.cart.cartId, variantId, item.quantity);
      throw ApplicationFailure.nonRetryable(
        `Insufficient inventory to update quantity for variant ${variantId}`,
        'OutOfStockError',
      );
    }
  },
};

const removeItem: Handler<'removeItem'> = {
  guard: notWhileSubmitting,
  async prepare(ctx, command) {
    const removed = ctx.cart.items.find((i) => i.lineItemId === command.lineItemId);
    if (removed) await releaseCartItem(ctx.cart.cartId, removed.variantId);
  },
};

const applyCoupon: Handler<'applyCoupon'> = { guard: notWhileSubmitting };

const linkUser: Handler<'linkUser'> = {};

// ==================
// Outbound nudge to the checkout child when the cart changes mid-checkout —
// an EFFECT keyed by the item-edit events, replacing the old hand-maintained
// ITEM_EDIT_EVENTS list in workflows.ts. The nudge carries the post-fold cartVersion
// (evolve already bumped it); checkout re-pulls the cart live via queryCart.
// ==================

const recomputeSignal = defineSignal<[{ cartVersion: number }]>('recompute');

async function nudgeCheckout(_event: CartEvent, ctx: Readonly<CartWorkflowContext>): Promise<void> {
  if (!ctx.checkoutWorkflowId) return;
  try {
    const handle = getExternalWorkflowHandle(ctx.checkoutWorkflowId);
    await handle.signal(recomputeSignal, { cartVersion: ctx.cart.cartVersion });
  } catch (e) {
    log.warn('Failed to send recompute nudge to checkout child', { error: String(e) });
  }
}

const itemEditNudges: EffectsMap<CartEvent, CartWorkflowContext> = {
  ItemAdded: nudgeCheckout,
  ItemQuantityChanged: nudgeCheckout,
  ItemRemoved: nudgeCheckout,
  CouponApplied: nudgeCheckout,
};

// ==================
// State: active
// ==================

const active = m.state('active', {
  commands: {
    addItem,
    updateQuantity,
    removeItem,
    applyCoupon,
    linkUser,
    expireCart: {},

    beginCheckout: {
      // Purely (ctx, command)-derivable, so it lives in guard — and because guards run
      // before prepare, the checkout child is never started for an empty cart.
      guard: (ctx) =>
        ctx.cart.items.length === 0 ? reject('Cannot checkout with empty cart') : undefined,
      async prepare(ctx) {
        const parentCartWorkflowId = buildWorkflowId(DEMO_STORE_ID, 'cart', ctx.cart.cartId);
        const newCheckoutVersion = ctx.checkoutVersion + 1;

        // A fresh checkout id per attempt, tagged with the cart's correlation id so the
        // whole journey is queryable (ADR-0011). Read back from this workflow's own
        // CorrelationId Search Attribute (minted at cart creation); legacy carts started
        // before tagging fall back to the cartId.
        const checkoutStart = buildWorkflowStartOptions({
          storeId: DEMO_STORE_ID,
          domain: 'checkout',
          entityId: uuid4(),
          correlationId: workflowCorrelationId() ?? ctx.cart.cartId,
          cartId: ctx.cart.cartId,
        });
        const checkoutWorkflowId = checkoutStart.workflowId;

        await startChild<(input: CheckoutWorkflowInput) => Promise<CheckoutWorkflowResult>>(
          'checkoutWorkflow',
          {
            ...checkoutStart,
            taskQueue: 'checkout-queue',
            parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
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
          checkoutWorkflowId,
        });

        return { checkoutWorkflowId };
      },
    },
  },
  route: {
    CheckoutEntered: 'checkout',
    CartAbandoned: terminal('abandoned'),
    '*': SELF,
  },
  timeout: '30 days',
  onTimeout: () => ({ type: 'expireCart' }),
});

// ==================
// State: checkout — the cart stays editable (same handlers); edits nudge the checkout
// child via the item-edit effects. The submit freeze and the completion result arrive
// as signal-mapped commands.
// ==================

const checkout = m.state('checkout', {
  commands: {
    addItem,
    updateQuantity,
    removeItem,
    applyCoupon,
    linkUser,
    // Idempotent no-op mid-checkout: no prepare → no child id → the decider emits
    // nothing; the caller still gets the current cart back.
    beginCheckout: {},
    submitStarted: {},
    submitAborted: {},
    checkoutCompleted: {},
    checkoutTimedOut: {},
  },
  route: {
    CheckoutDisowned: 'active',
    CheckoutFailed: 'active',
    CartCompleted: terminal('completed'),
    CartAbandoned: terminal('abandoned'),
    '*': SELF,
  },
  effects: itemEditNudges,
  timeout: '1 hour',
  onTimeout: () => ({ type: 'checkoutTimedOut' }),
});

// ==================
// Registry — table of contents. timeout/transitional ride the state defs above.
// ==================

export const CART_STATES: StateRegistry<
  CartStateName,
  CartCommand,
  CartWorkflowContext,
  CartUpdateResponse,
  CartCommand
> = {
  active,
  checkout,
};
