/**
 * Cart Decider — the pure Functional Core, on the ADR-0024 decider-native surface
 * (aligned with nightheron-mono).
 *
 *   decide: (command, state) => Event[]     // what happened, as past-tense events
 *   evolve: (state, event)   => State       // fold one event into state (the ONLY writer)
 *
 * Both functions are pure and infrastructure-free — no I/O, no clock, no `uuid4`, no Temporal.
 * External data a decision needs (a generated line-item id, the started checkout child's id, the
 * deterministic timestamp) arrives ON the command: the framework enriches each accepted command
 * with the handler's `prepare` result and `at` before it reaches `decide` — exactly Chassaing's
 * rule for keeping the core pure and replay-safe.
 *
 * `State` is the whole `CartWorkflowContext` (cart + checkout link + submit flag), so `evolve`
 * folds link/version/submit changes as well as cart-content changes. Every event carries `at`,
 * and `evolve` stamps `updatedAt`/bumps `cartVersion` on each fold — the version/timestamp
 * lifecycle lives HERE, not in a workflow hook (this retires the onTransition bump-and-flush).
 *
 * Non-goal (ADR-0003, reaffirmed by ADR-0024): emitted events are transient in-memory values
 * folded within the same call — never persisted. Temporal's history remains the sole durable log.
 */

import type { MachineDecider } from '../framework';
import { addItem as addItemToCart, copyCart, recalculateTotals } from './cart-logic';
import type { CartCommand, CartDetails, CartWorkflowContext, CheckoutState } from './types';

/**
 * The command as the decider sees it: the base `CartCommand` union with the fields the
 * handlers' `prepare` phases inject (the collapse ADR-0024 prescribes — one union, with
 * enrichment expressed as intersections on it rather than a hand-maintained parallel union).
 */
export type EnrichedCartCommand = (
  | (Extract<CartCommand, { type: 'addItem' }> & { lineItemId: string })
  | (Extract<CartCommand, { type: 'beginCheckout' }> & { checkoutWorkflowId?: string })
  | Exclude<CartCommand, { type: 'addItem' | 'beginCheckout' }>
) & { at: string };

/** Past-tense domain events. Each carries the timestamp at which it happened. */
export type CartEvent =
  | {
      type: 'ItemAdded';
      variantId: string;
      quantity: number;
      price: number;
      properties?: Record<string, unknown>;
      lineItemId: string;
      at: string;
    }
  | { type: 'ItemQuantityChanged'; lineItemId: string; quantity: number; at: string }
  | { type: 'ItemRemoved'; lineItemId: string; at: string }
  | { type: 'CouponApplied'; code: string; at: string }
  | { type: 'UserLinked'; email: string; userId: string; at: string }
  | { type: 'CheckoutEntered'; checkoutWorkflowId: string; checkoutVersion: number; at: string }
  | { type: 'CheckoutDisowned'; at: string }
  | { type: 'CartAbandoned'; at: string }
  | { type: 'CartCompleted'; finalState: CheckoutState; at: string }
  | { type: 'CheckoutFailed'; error: string; at: string }
  | { type: 'SubmitFreezeStarted'; at: string }
  | { type: 'SubmitFreezeCleared'; at: string };

/** Deep-copy the context (cart + its items + coupons) for immutability. */
function copyCtx(state: Readonly<CartWorkflowContext>): CartWorkflowContext {
  return { ...state, cart: copyCart(state.cart) };
}

/** Set the checkout fields on a cart when it enters checkout. */
function initCheckoutFields(cart: CartDetails): void {
  cart.status = 'checkout';
  cart.checkout = {
    step: 'validating',
    isGuest: !cart.userId,
    shippingCost: 0,
    tax: 0,
  };
}

/**
 * decide(command, state) → events.
 *
 * Pure: emits the events implied by the command in the current state, and nothing else. It never
 * mutates and never reads a clock or generates ids (those arrive on the command). Rejection
 * (submit-freeze, empty-cart checkout, out-of-stock) lives in the states' `guard`/`prepare`;
 * abandonment — a genuine domain decision — is decided HERE by emitting `CartAbandoned` when the
 * change empties the cart, and routing keys on that event.
 */
export function decide(command: EnrichedCartCommand, state: CartWorkflowContext): CartEvent[] {
  const { cart } = state;
  const at = command.at;
  switch (command.type) {
    case 'addItem':
      return [
        {
          type: 'ItemAdded',
          variantId: command.variantId,
          quantity: command.quantity,
          price: command.price,
          properties: command.properties,
          lineItemId: command.lineItemId,
          at,
        },
      ];

    case 'updateQuantity': {
      const item = cart.items.find((i) => i.lineItemId === command.lineItemId);
      if (!item) return [];
      if (command.quantity <= 0) {
        return emptiesCart(cart, command.lineItemId)
          ? [
              { type: 'ItemRemoved', lineItemId: command.lineItemId, at },
              { type: 'CartAbandoned', at },
            ]
          : [{ type: 'ItemRemoved', lineItemId: command.lineItemId, at }];
      }
      return [
        {
          type: 'ItemQuantityChanged',
          lineItemId: command.lineItemId,
          quantity: command.quantity,
          at,
        },
      ];
    }

    case 'removeItem':
      return emptiesCart(cart, command.lineItemId)
        ? [
            { type: 'ItemRemoved', lineItemId: command.lineItemId, at },
            { type: 'CartAbandoned', at },
          ]
        : [{ type: 'ItemRemoved', lineItemId: command.lineItemId, at }];

    case 'applyCoupon':
      return cart.appliedCoupons.includes(command.code)
        ? []
        : [{ type: 'CouponApplied', code: command.code, at }];

    case 'linkUser':
      return [{ type: 'UserLinked', email: command.email, userId: command.userId, at }];

    case 'beginCheckout':
      // In `checkout`, beginCheckout is an idempotent no-op: the state's handler has no
      // prepare, so no child id arrives and no event is emitted (the caller still gets
      // the current cart back).
      if (!command.checkoutWorkflowId || cart.status === 'checkout') return [];
      return [
        {
          type: 'CheckoutEntered',
          checkoutWorkflowId: command.checkoutWorkflowId,
          checkoutVersion: state.checkoutVersion + 1,
          at,
        },
      ];

    case 'expireCart':
      return [{ type: 'CartAbandoned', at }];

    case 'checkoutTimedOut':
      // Checkout timed out — protect the cart (disown, not abandon).
      return cart.status === 'checkout' ? [{ type: 'CheckoutDisowned', at }] : [];

    case 'submitStarted':
      return [{ type: 'SubmitFreezeStarted', at }];

    case 'submitAborted':
      return [{ type: 'SubmitFreezeCleared', at }];

    case 'checkoutCompleted': {
      const r = command.result;
      // Stale signal from a superseded checkout attempt — no events, machine stays put.
      if (r.checkoutVersion !== undefined && r.checkoutVersion !== state.checkoutVersion) return [];
      return r.success && r.order
        ? [{ type: 'CartCompleted', finalState: r.finalState, at }]
        : [{ type: 'CheckoutFailed', error: r.error || 'Checkout failed', at }];
    }

    default:
      return [];
  }
}

/** Pure: would removing this line leave the cart empty? */
function emptiesCart(cart: CartDetails, lineItemId: string): boolean {
  return cart.items.filter((i) => i.lineItemId !== lineItemId).length === 0;
}

/**
 * evolve(state, event) → state.
 *
 * Pure fold of a single event into the context — the ONLY function that writes cart contents,
 * `status`, the checkout link/version, the submit flag, `updatedAt`, or `cartVersion`. Every
 * fold stamps `updatedAt` from the event's `at` and bumps `cartVersion` (versions are freshness
 * tokens — monotonicity is what consumers compare, so a two-event command bumping twice is fine).
 */
export function evolve(state: CartWorkflowContext, event: CartEvent): CartWorkflowContext {
  const next = copyCtx(state);
  const { cart } = next;
  cart.updatedAt = event.at;
  cart.cartVersion = (cart.cartVersion || 0) + 1;
  switch (event.type) {
    case 'ItemAdded':
      addItemToCart(cart, {
        variantId: event.variantId,
        quantity: event.quantity,
        price: event.price,
        lineItemId: event.lineItemId,
        properties: event.properties,
      });
      return next;

    case 'ItemQuantityChanged': {
      const item = cart.items.find((i) => i.lineItemId === event.lineItemId);
      if (item) {
        item.quantity = event.quantity;
        recalculateTotals(cart);
      }
      return next;
    }

    case 'ItemRemoved':
      cart.items = cart.items.filter((i) => i.lineItemId !== event.lineItemId);
      recalculateTotals(cart);
      return next;

    case 'CouponApplied':
      if (!cart.appliedCoupons.includes(event.code)) {
        cart.appliedCoupons.push(event.code);
        recalculateTotals(cart);
      }
      return next;

    case 'UserLinked':
      cart.email = event.email;
      cart.userId = event.userId;
      return next;

    case 'CheckoutEntered':
      initCheckoutFields(cart);
      next.checkoutWorkflowId = event.checkoutWorkflowId;
      next.checkoutVersion = event.checkoutVersion;
      return next;

    case 'CheckoutDisowned':
      cart.checkout = undefined;
      cart.status = 'active';
      next.checkoutWorkflowId = null;
      return next;

    case 'CartAbandoned':
      cart.status = 'abandoned';
      return next;

    case 'CartCompleted':
      cart.status = 'completed';
      cart.checkout = event.finalState;
      cart.shippingCost = event.finalState.shippingCost;
      cart.totalTax = event.finalState.tax;
      cart.totalPrice =
        cart.subtotalPrice -
        cart.totalDiscounts +
        event.finalState.shippingCost +
        event.finalState.tax;
      // The checkout child already closed (it sent this completion) — clear the link so
      // terminal cleanup doesn't request-cancel a finished workflow. (Demo divergence:
      // mono keeps the link; the demo's onTerminal cancel would otherwise warn.)
      next.checkoutWorkflowId = null;
      return next;

    case 'CheckoutFailed':
      cart.status = 'active';
      cart.checkout = {
        step: 'failed',
        isGuest: !cart.userId,
        shippingCost: 0,
        tax: 0,
        error: event.error,
      };
      next.checkoutWorkflowId = null;
      return next;

    case 'SubmitFreezeStarted':
      next.submitting = true;
      return next;

    case 'SubmitFreezeCleared':
      next.submitting = false;
      return next;

    default:
      return next;
  }
}

/**
 * The assembled decider, conforming to the framework's `MachineDecider` shape (ADR-0024:
 * `isTerminal` is gone — terminality is the route tables' job; `initialState` remains as
 * the canonical empty shape for decider unit tests, never consulted at runtime).
 */
export const cartDecider: MachineDecider<EnrichedCartCommand, CartEvent, CartWorkflowContext> = {
  decide,
  evolve,
  initialState: {
    cart: {
      cartId: '',
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
      createdAt: '',
      updatedAt: '',
    },
    checkoutWorkflowId: null,
    checkoutVersion: 0,
  },
};
