/**
 * Cart Decider — the pure Functional Core (ported pattern from nightheron-mono, ADR-0009).
 *
 * Expresses the cart's decision logic as Jérémie Chassaing's Functional Event Sourcing
 * Decider:
 *
 *   decide: (command, state) => Event[]      // what happened, as past-tense facts
 *   evolve: (state, event)   => State        // fold one fact into state (the ONLY writer)
 *
 * Both functions are pure and infrastructure-free — no I/O, no clock, no `uuid4`, no Temporal.
 * External data a decision needs (a generated line-item id, the started checkout child's id) is
 * injected into the *command* by the shell (`states.ts`) before it reaches `decide`.
 *
 * `State` is the whole `CartWorkflowContext` (cart + checkout link/version), so `evolve` folds
 * link/version changes as well as cart-content changes.
 *
 * Non-goal (ADR-0003): emitted events are transient in-memory facts folded within the same
 * call — never persisted. Temporal's history remains the sole durable log.
 */

import type { Decider } from '../framework';
import { addItem as addItemToCart, copyCart, recalculateTotals } from './cart-logic';
import type {
  CartDetails,
  CartWorkflowContext,
  CheckoutState,
  CheckoutWorkflowResult,
} from './types';

/**
 * The Chassaing "command": an intent enriched with external data in the shell (a generated
 * `lineItemId`, the started checkout child's id) before it reaches the pure core.
 */
export type CartCommand =
  | {
      type: 'addItem';
      variantId: string;
      quantity: number;
      price: number;
      properties?: Record<string, unknown>;
      lineItemId: string;
    }
  | { type: 'updateQuantity'; lineItemId: string; quantity: number }
  | { type: 'removeItem'; lineItemId: string }
  | { type: 'applyCoupon'; code: string }
  | { type: 'linkUser'; email: string; userId: string }
  | { type: 'beginCheckout'; checkoutWorkflowId: string }
  | { type: 'disownCheckout' }
  | { type: 'checkoutCompleted'; result: CheckoutWorkflowResult };

/** Past-tense domain facts. */
export type CartFact =
  | {
      type: 'ItemAdded';
      variantId: string;
      quantity: number;
      price: number;
      properties?: Record<string, unknown>;
      lineItemId: string;
    }
  | { type: 'ItemQuantityChanged'; lineItemId: string; quantity: number }
  | { type: 'ItemRemoved'; lineItemId: string }
  | { type: 'CouponApplied'; code: string }
  | { type: 'UserLinked'; email: string; userId: string }
  | { type: 'CheckoutEntered'; checkoutWorkflowId: string; checkoutVersion: number }
  | { type: 'CheckoutDisowned' }
  | { type: 'CartAbandoned' }
  | { type: 'CartCompleted'; finalState: CheckoutState };

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

/** Pure: would removing this line leave the cart empty? */
function emptiesCart(cart: CartDetails, lineItemId: string): boolean {
  return cart.items.filter((i) => i.lineItemId !== lineItemId).length === 0;
}

/**
 * decide(command, state) → facts.
 *
 * Pure: emits the facts implied by the command in the current state, and nothing else. It never
 * mutates and never reads a clock or generates ids (those arrive on the command). Reservation
 * guards and empty-cart rejection live in the shell; abandonment — a genuine domain decision —
 * is decided here by emitting `CartAbandoned` when the change empties the cart.
 */
export function decide(command: CartCommand, state: CartWorkflowContext): CartFact[] {
  const { cart } = state;
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
        },
      ];

    case 'updateQuantity': {
      const item = cart.items.find((i) => i.lineItemId === command.lineItemId);
      if (!item) return [];
      if (command.quantity <= 0) {
        return emptiesCart(cart, command.lineItemId)
          ? [{ type: 'ItemRemoved', lineItemId: command.lineItemId }, { type: 'CartAbandoned' }]
          : [{ type: 'ItemRemoved', lineItemId: command.lineItemId }];
      }
      return [
        { type: 'ItemQuantityChanged', lineItemId: command.lineItemId, quantity: command.quantity },
      ];
    }

    case 'removeItem': {
      const removed = cart.items.find((i) => i.lineItemId === command.lineItemId);
      if (!removed) return [];
      return emptiesCart(cart, command.lineItemId)
        ? [{ type: 'ItemRemoved', lineItemId: command.lineItemId }, { type: 'CartAbandoned' }]
        : [{ type: 'ItemRemoved', lineItemId: command.lineItemId }];
    }

    case 'applyCoupon':
      return cart.appliedCoupons.includes(command.code)
        ? []
        : [{ type: 'CouponApplied', code: command.code }];

    case 'linkUser':
      return [{ type: 'UserLinked', email: command.email, userId: command.userId }];

    case 'beginCheckout':
      return [
        {
          type: 'CheckoutEntered',
          checkoutWorkflowId: command.checkoutWorkflowId,
          checkoutVersion: state.checkoutVersion + 1,
        },
      ];

    case 'disownCheckout':
      return [{ type: 'CheckoutDisowned' }];

    case 'checkoutCompleted': {
      const r = command.result;
      // Stale signal from a superseded checkout attempt — no facts (the shell logs + stays put).
      if (r.checkoutVersion !== undefined && r.checkoutVersion !== state.checkoutVersion) return [];
      return r.success && r.order
        ? [{ type: 'CartCompleted', finalState: r.finalState }]
        : [{ type: 'CheckoutDisowned' }];
    }

    default:
      return [];
  }
}

/**
 * evolve(state, fact) → state.
 *
 * Pure fold of a single fact into the context. The ONLY function that writes cart contents,
 * `status`, or the checkout link/version.
 */
export function evolve(state: CartWorkflowContext, fact: CartFact): CartWorkflowContext {
  const next = copyCtx(state);
  const { cart } = next;
  switch (fact.type) {
    case 'ItemAdded':
      addItemToCart(cart, {
        variantId: fact.variantId,
        quantity: fact.quantity,
        price: fact.price,
        lineItemId: fact.lineItemId,
        properties: fact.properties,
      });
      return next;

    case 'ItemQuantityChanged': {
      const item = cart.items.find((i) => i.lineItemId === fact.lineItemId);
      if (item) {
        item.quantity = fact.quantity;
        recalculateTotals(cart);
      }
      return next;
    }

    case 'ItemRemoved':
      cart.items = cart.items.filter((i) => i.lineItemId !== fact.lineItemId);
      recalculateTotals(cart);
      return next;

    case 'CouponApplied':
      if (!cart.appliedCoupons.includes(fact.code)) {
        cart.appliedCoupons.push(fact.code);
        recalculateTotals(cart);
      }
      return next;

    case 'UserLinked':
      cart.email = fact.email;
      cart.userId = fact.userId;
      return next;

    case 'CheckoutEntered':
      initCheckoutFields(cart);
      next.checkoutWorkflowId = fact.checkoutWorkflowId;
      next.checkoutVersion = fact.checkoutVersion;
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
      cart.checkout = fact.finalState;
      cart.shippingCost = fact.finalState.shippingCost;
      cart.totalTax = fact.finalState.tax;
      cart.totalPrice =
        cart.subtotalPrice - cart.totalDiscounts + fact.finalState.shippingCost + fact.finalState.tax;
      return next;

    default:
      return next;
  }
}

/** Terminal statuses — the cart lifecycle's defined ends. */
function isTerminalStatus(state: CartWorkflowContext): boolean {
  return state.cart.status === 'completed' || state.cart.status === 'abandoned';
}

/**
 * The assembled Decider, conforming to the shared `Decider<Command, Event, State>` shape.
 * `initialState` documents the cart's birth shape; at runtime the real initial context is
 * built from workflow input (`cartWorkflow`).
 */
export const cartDecider: Decider<CartCommand, CartFact, CartWorkflowContext> = {
  decide,
  evolve,
  isTerminal: isTerminalStatus,
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
