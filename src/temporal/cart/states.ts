/**
 * The cart machine, co-located in one file (ADR-0024 decider-native surface,
 * aligned with nightheron-mono's CommandBlock convention).
 *
 * Everything about the machine lives here, in reading order: the enriched command union
 * and the past-tense event union; the pure cart helpers (totals, add, checkout input);
 * the shared guard and the evolve entries shared by several commands; then ONE
 * `CommandBlock` PER COMMAND — a single exported structure holding the command's whole
 * story, code inlined: its `guard` (pure rejection), its `prepare` (the only I/O), its
 * `decide` case, and the `evolve` entries for the events it emits; then the central
 * `decide`/`evolve`, ASSEMBLED from the blocks; and finally the machine assembly:
 * effects, the `m.state` declarations (whose commands tables reference the SAME
 * blocks), and the registry.
 *
 *   decide: (command, context) => Event[]     // what happened, as past-tense events
 *   evolve: (context, event)   => Context     // apply one event — returns a NEW context
 *
 * Both functions are pure and infrastructure-free — no I/O, no clock, no `uuid4`, no Temporal.
 * External data a decision needs (a generated line-item id, the started checkout child's id, the
 * deterministic timestamp) arrives ON the command: the framework enriches each accepted command
 * with the handler's `prepare` result and `at` before it reaches `decide` — exactly Chassaing's
 * rule for keeping the core pure and replay-safe.
 *
 * Purity is structural, not conventional: every state-writing function takes a `Readonly<...>`
 * parameter and returns a NEW value built by structural sharing. Nothing mutates a live
 * context, so the old blanket deep-copy barrier (`copyCart`/`copyCtx`) is gone entirely.
 *
 * `State` is the whole `CartWorkflowContext` (cart + checkout link + submit flag), so `evolve`
 * applies link/version/submit changes as well as cart-content changes. Every event carries `at`,
 * and `evolve` stamps `updatedAt`/bumps `cartVersion` on each event — the version/timestamp
 * lifecycle lives HERE, not in a workflow hook.
 *
 * The framework owns the pipeline: each accepted command runs guard → prepare → decide →
 * evolve, and routing keys on the EMITTED EVENTS — the shell never re-derives what the
 * decider said (emptying the cart routes on `CartAbandoned`, not on a re-checked
 * `items.length === 0`). A command a state does not list is REJECTED: typed error to the
 * caller, no transition, no recording, no projection.
 *
 * Non-goal (ADR-0003, reaffirmed by ADR-0024): emitted events are transient in-memory values
 * applied within the same call — never persisted. Temporal's history remains the sole durable log.
 */

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
import type {
  CartCommand,
  CartDetails,
  CartItem,
  CartStateName,
  CartUpdateResponse,
  CartWorkflowContext,
  CheckoutState,
  CheckoutWorkflowInput,
  CheckoutWorkflowResult,
} from './types';
import { defineMachine, reject, terminal, SELF, workflowCorrelationId } from '../framework';
import type { EffectsMap, MachineDecider, Rejection, StateRegistry } from '../framework';
import { buildWorkflowId, buildWorkflowStartOptions, DEMO_STORE_ID } from '../contracts/constants';

// ==================
// Commands and events — the machine's whole vocabulary
// ==================

/**
 * The command as the decider sees it: the base `CartCommand` union with the fields the
 * blocks' `prepare` phases inject (the collapse ADR-0024 prescribes — one union, with
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

/** One member of the WIRE command union (pre-enrichment), by its `type` tag. */
type Wire<K extends CartCommand['type']> = Extract<CartCommand, { type: K }>;

/** One member of the ENRICHED command union (wire + prepared data + `at`), by its `type` tag. */
type Enriched<K extends EnrichedCartCommand['type']> = Extract<EnrichedCartCommand, { type: K }>;

/** One member of the event union, by its `type` tag. */
type Ev<K extends CartEvent['type']> = Extract<CartEvent, { type: K }>;

// ==================
// Pure cart helpers — no I/O, no Temporal imports, and no side effects at all: each
// takes a `Readonly` cart and returns a NEW cart built by structural sharing. All ID
// generation is the caller's responsibility. (Formerly `cart-logic.ts`; merged here by
// the co-location sweep.)
// ==================

/**
 * Pure: return the cart with subtotal / discounts / tax / total recalculated from its
 * items and coupons. (Demo model: plain numbers, flat SAVE20 = 20%, tax = 8%.)
 */
export function recalculateTotals(cart: Readonly<CartDetails>): CartDetails {
  const subtotalPrice = cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const totalDiscounts = cart.appliedCoupons.includes('SAVE20') ? subtotalPrice * 0.2 : 0;
  const totalTax = (subtotalPrice - totalDiscounts) * 0.08;
  const totalPrice = subtotalPrice - totalDiscounts + cart.shippingCost + totalTax;
  return { ...cart, subtotalPrice, totalDiscounts, totalTax, totalPrice };
}

/**
 * Pure: return a new cart with the item added, merging by variantId (quantity sums
 * rather than duplicating the line), totals recalculated. Caller must provide
 * lineItemId (e.g. from uuid4() in the workflow sandbox).
 */
export function addItem(cart: Readonly<CartDetails>, item: CartItem): CartDetails {
  const existing = cart.items.find((i) => i.variantId === item.variantId);
  const items = existing
    ? cart.items.map((i) =>
        i.variantId === item.variantId ? { ...i, quantity: i.quantity + item.quantity } : i,
      )
    : [...cart.items, { ...item }];
  return recalculateTotals({ ...cart, items });
}

/**
 * Pure: build the checkout child workflow's input from the current cart. No item/price
 * snapshot — the checkout pulls cart contents live via queryCart at `validating`.
 */
export function buildCheckoutInput(
  cart: Readonly<CartDetails>,
  parentCartWorkflowId: string,
): Omit<CheckoutWorkflowInput, 'checkoutVersion'> {
  return {
    cartId: cart.cartId,
    parentCartWorkflowId,
    currency: cart.currency,
    isGuest: !cart.userId,
    cartVersion: cart.cartVersion,
  };
}

/** Pure: the cart as it enters checkout — status flipped, checkout fields initialized. */
function withCheckoutFields(cart: Readonly<CartDetails>): CartDetails {
  return {
    ...cart,
    status: 'checkout',
    checkout: {
      step: 'validating',
      isGuest: !cart.userId,
      shippingCost: 0,
      tax: 0,
    },
  };
}

/** Pure: would removing this line leave the cart empty? */
function emptiesCart(cart: Readonly<CartDetails>, lineItemId: string): boolean {
  return cart.items.filter((i) => i.lineItemId !== lineItemId).length === 0;
}

// ==================
// Shared guard + shared evolve entries — the pieces referenced by MORE THAN ONE command
// block. Everything used by exactly one command lives INLINE in that command's block
// below (the inlining rule: the block IS the code, not an index of named functions).
// ==================

/**
 * Reject a cart edit while the checkout child is placing the order. Shared by both
 * states: in `active` a submit is never in progress, so the guard is inert there; in
 * `checkout` it holds the cart still for the saga. Guards run BEFORE `prepare`, so no
 * reservation write can happen on a rejected edit — the old mirrored prepare/decide checks
 * are unnecessary by construction.
 */
function notWhileSubmitting(context: Readonly<CartWorkflowContext>): Rejection | undefined {
  return context.submitting ? reject('Order is being placed — please wait') : undefined;
}

/** Emitted by removeItem and by updateQuantity-to-zero. */
function evolveItemRemoved(
  context: Readonly<CartWorkflowContext>,
  event: Ev<'ItemRemoved'>,
): CartWorkflowContext {
  return {
    ...context,
    cart: recalculateTotals({
      ...context.cart,
      items: context.cart.items.filter((i) => i.lineItemId !== event.lineItemId),
    }),
  };
}

/** Emitted by updateQuantity-to-zero, removeItem-of-the-last-line, and expireCart. */
function evolveCartAbandoned(
  context: Readonly<CartWorkflowContext>,
  _event: Ev<'CartAbandoned'>,
): CartWorkflowContext {
  return { ...context, cart: { ...context.cart, status: 'abandoned' } };
}

// ==================
// Command blocks — ONE exported structure per command, every field that defines the
// command in one value, with the code INLINED. The `m.state` declarations at the bottom
// reference these SAME blocks (the framework reads only `guard`/`prepare`; structural
// typing admits the extra fields), the central `decide`/`evolve` dispatchers are
// assembled from them, and tests exercise their fields directly.
// ==================

/**
 * A block's evolve — keyed by EVENT TYPE, because evolve's unit is the event, not the
 * command: one command may emit several event types, and some events are shared across
 * commands (those reference one shared evolve function instead of inlining twice). The
 * machine's single `evolve(context, event)` is assembled by merging every block's map.
 */
type EvolveMap = {
  [E in CartEvent['type']]?: (
    context: Readonly<CartWorkflowContext>,
    event: Ev<E>,
  ) => CartWorkflowContext;
};

/** One command's whole story: refusal, I/O, decision, and the evolve for what it emits. */
export interface CommandBlock<K extends CartCommand['type']> {
  guard?: (context: Readonly<CartWorkflowContext>, command: Wire<K>) => Rejection | void;
  prepare?: (context: Readonly<CartWorkflowContext>, command: Wire<K>) => Promise<object | void>;
  decide: (command: Enriched<K>, context: Readonly<CartWorkflowContext>) => CartEvent[];
  evolve?: EvolveMap;
}

// ==================
// Command: addItem — the whole story, in one value
//
// The cart stays editable in BOTH `active` and `checkout` — both states' commands
// tables reference the same edit blocks (guarded by `notWhileSubmitting`), and each
// state's route table decides where the resulting events lead. The cart owns
// reservation writes (in `prepare`); a prepare throw is a rejection. Demo divergence
// from mono: reservations are per-variant release-then-re-reserve (no sku resolution,
// no ADR-0022 absolute holds), so a failed re-reserve compensates by restoring the old
// quantity before throwing.
// ==================

export const addItemBlock: CommandBlock<'addItem'> = {
  guard: notWhileSubmitting, // shared guard — referenced, not duplicated

  // I/O phase — a throw is a rejection.
  prepare: async (context, command) => {
    const lineItemId = uuid4();
    const existing = context.cart.items.find((i) => i.variantId === command.variantId);
    const oldQty = existing ? existing.quantity : 0;
    const newQty = oldQty + command.quantity;

    // Release existing reservation before re-reserving at the new quantity
    if (oldQty > 0) await releaseCartItem(context.cart.cartId, command.variantId);
    const reservationId = await reserveCartItem(context.cart.cartId, command.variantId, newQty);

    if (!reservationId) {
      // Reservation failed — re-reserve at the old quantity if we released
      if (oldQty > 0) await reserveCartItem(context.cart.cartId, command.variantId, oldQty);
      throw ApplicationFailure.nonRetryable(
        `Insufficient inventory for variant ${command.variantId}`,
        'OutOfStockError',
      );
    }
    return { lineItemId };
  },

  // Pure decision — the enriched command (wire fields + prepared { lineItemId } + at).
  decide: (command, _context) => [
    {
      type: 'ItemAdded',
      variantId: command.variantId,
      quantity: command.quantity,
      price: command.price,
      properties: command.properties,
      lineItemId: command.lineItemId,
      at: command.at,
    },
  ],

  // The evolve for the event this command emits: the shared pure helper returns a NEW
  // cart; the entry returns a NEW context.
  evolve: {
    ItemAdded: (context, event) => ({
      ...context,
      cart: addItem(context.cart, {
        lineItemId: event.lineItemId,
        variantId: event.variantId,
        quantity: event.quantity,
        price: event.price,
        properties: event.properties,
      }),
    }),
  },
};

// ==================
// Command: updateQuantity — the whole story
// ==================

export const updateQuantityBlock: CommandBlock<'updateQuantity'> = {
  guard: notWhileSubmitting,

  prepare: async (context, command) => {
    const item = context.cart.items.find((i) => i.lineItemId === command.lineItemId);
    if (!item) return;
    const variantId = item.variantId;
    if (command.quantity <= 0) {
      await releaseCartItem(context.cart.cartId, variantId);
      return;
    }
    await releaseCartItem(context.cart.cartId, variantId);
    const reservationId = await reserveCartItem(context.cart.cartId, variantId, command.quantity);
    if (!reservationId) {
      // Re-reserve at the old quantity
      await reserveCartItem(context.cart.cartId, variantId, item.quantity);
      throw ApplicationFailure.nonRetryable(
        `Insufficient inventory to update quantity for variant ${variantId}`,
        'OutOfStockError',
      );
    }
  },

  decide: (command, context) => {
    const { cart } = context;
    const at = command.at;
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
  },

  evolve: {
    // Substitute the one line, then re-total; an unknown line leaves the context unchanged.
    ItemQuantityChanged: (context, event) => {
      const item = context.cart.items.find((i) => i.lineItemId === event.lineItemId);
      if (!item) return context;
      return {
        ...context,
        cart: recalculateTotals({
          ...context.cart,
          items: context.cart.items.map((i) =>
            i.lineItemId === event.lineItemId ? { ...i, quantity: event.quantity } : i,
          ),
        }),
      };
    },
    ItemRemoved: evolveItemRemoved, // shared with removeItem
    CartAbandoned: evolveCartAbandoned, // shared with removeItem/expireCart
  },
};

// ==================
// Command: removeItem — the whole story. Emits `ItemRemoved` (+ `CartAbandoned` when the
// removal empties the cart) — the same events updateQuantity-to-zero emits, so both
// blocks reference the same shared evolve entries.
// ==================

export const removeItemBlock: CommandBlock<'removeItem'> = {
  guard: notWhileSubmitting,

  prepare: async (context, command) => {
    const removed = context.cart.items.find((i) => i.lineItemId === command.lineItemId);
    if (removed) await releaseCartItem(context.cart.cartId, removed.variantId);
  },

  decide: (command, context) => {
    const at = command.at;
    return emptiesCart(context.cart, command.lineItemId)
      ? [
          { type: 'ItemRemoved', lineItemId: command.lineItemId, at },
          { type: 'CartAbandoned', at },
        ]
      : [{ type: 'ItemRemoved', lineItemId: command.lineItemId, at }];
  },

  evolve: {
    ItemRemoved: evolveItemRemoved,
    CartAbandoned: evolveCartAbandoned,
  },
};

// ==================
// Command: applyCoupon — the whole story (no prepare; a duplicate coupon emits nothing)
// ==================

export const applyCouponBlock: CommandBlock<'applyCoupon'> = {
  guard: notWhileSubmitting,

  decide: (command, context) =>
    context.cart.appliedCoupons.includes(command.code)
      ? []
      : [{ type: 'CouponApplied', code: command.code, at: command.at }],

  evolve: {
    CouponApplied: (context, event) =>
      context.cart.appliedCoupons.includes(event.code)
        ? context
        : {
            ...context,
            cart: recalculateTotals({
              ...context.cart,
              appliedCoupons: [...context.cart.appliedCoupons, event.code],
            }),
          },
  },
};

// ==================
// Command: linkUser — the whole story (unguarded: linking a user is always safe).
// Demo divergence: carries `email` + `userId` (mono: `userId` only).
// ==================

export const linkUserBlock: CommandBlock<'linkUser'> = {
  decide: (command, _context) => [
    { type: 'UserLinked', email: command.email, userId: command.userId, at: command.at },
  ],

  evolve: {
    UserLinked: (context, event) => ({
      ...context,
      cart: { ...context.cart, email: event.email, userId: event.userId },
    }),
  },
};

// ==================
// Command: beginCheckout — the whole story
// ==================

export const beginCheckoutBlock: CommandBlock<'beginCheckout'> = {
  // Purely (context, command)-derivable, so it lives in guard — and because guards run
  // before prepare, the checkout child is never started for an empty cart.
  guard: (context) =>
    context.cart.items.length === 0 ? reject('Cannot checkout with empty cart') : undefined,

  prepare: async (context) => {
    const parentCartWorkflowId = buildWorkflowId(DEMO_STORE_ID, 'cart', context.cart.cartId);
    const newCheckoutVersion = context.checkoutVersion + 1;

    // A fresh checkout id per attempt, tagged with the cart's correlation id so the
    // whole journey is queryable (ADR-0011). Read back from this workflow's own
    // CorrelationId Search Attribute (minted at cart creation); legacy carts started
    // before tagging fall back to the cartId.
    const checkoutStart = buildWorkflowStartOptions({
      storeId: DEMO_STORE_ID,
      domain: 'checkout',
      entityId: uuid4(),
      correlationId: workflowCorrelationId() ?? context.cart.cartId,
      cartId: context.cart.cartId,
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
            ...buildCheckoutInput(context.cart, parentCartWorkflowId),
            checkoutVersion: newCheckoutVersion,
          },
        ],
        workflowExecutionTimeout: '2 hours',
      },
    );

    log.info('Started checkout child workflow', {
      cartId: context.cart.cartId,
      checkoutWorkflowId,
    });

    return { checkoutWorkflowId };
  },

  decide: (command, context) => {
    // In `checkout`, beginCheckout is an idempotent no-op: that state's handler is a bare
    // `{}` (deliberately NOT this block), so no child id arrives and no event is emitted
    // (the caller still gets the current cart back).
    if (!command.checkoutWorkflowId || context.cart.status === 'checkout') return [];
    return [
      {
        type: 'CheckoutEntered',
        checkoutWorkflowId: command.checkoutWorkflowId,
        checkoutVersion: context.checkoutVersion + 1,
        at: command.at,
      },
    ];
  },

  evolve: {
    CheckoutEntered: (context, event) => ({
      ...context,
      cart: withCheckoutFields(context.cart),
      checkoutWorkflowId: event.checkoutWorkflowId,
      checkoutVersion: event.checkoutVersion,
    }),
  },
};

// ==================
// Command: expireCart — the whole story (synthesized by the active state's 30-day timer)
// ==================

export const expireCartBlock: CommandBlock<'expireCart'> = {
  decide: (command, _context) => [{ type: 'CartAbandoned', at: command.at }],

  evolve: {
    CartAbandoned: evolveCartAbandoned,
  },
};

// ==================
// Command: checkoutTimedOut — the whole story
// ==================

export const checkoutTimedOutBlock: CommandBlock<'checkoutTimedOut'> = {
  // Checkout timed out — protect the cart (disown, not abandon).
  decide: (command, context) =>
    context.cart.status === 'checkout' ? [{ type: 'CheckoutDisowned', at: command.at }] : [],

  evolve: {
    CheckoutDisowned: (context, _event) => ({
      ...context,
      cart: { ...context.cart, checkout: undefined, status: 'active' },
      checkoutWorkflowId: null,
    }),
  },
};

// ==================
// Commands: submitStarted / submitAborted — the submit freeze, signal-mapped from the
// checkout child
// ==================

export const submitStartedBlock: CommandBlock<'submitStarted'> = {
  decide: (command, _context) => [{ type: 'SubmitFreezeStarted', at: command.at }],

  evolve: {
    SubmitFreezeStarted: (context, _event) => ({ ...context, submitting: true }),
  },
};

export const submitAbortedBlock: CommandBlock<'submitAborted'> = {
  decide: (command, _context) => [{ type: 'SubmitFreezeCleared', at: command.at }],

  evolve: {
    SubmitFreezeCleared: (context, _event) => ({ ...context, submitting: false }),
  },
};

// ==================
// Command: checkoutCompleted — the whole story (the checkout child's combined result
// signal; a stale checkoutVersion is ignored)
// ==================

export const checkoutCompletedBlock: CommandBlock<'checkoutCompleted'> = {
  decide: (command, context) => {
    const at = command.at;
    const r = command.result;
    // Stale signal from a superseded checkout attempt — no events, machine stays put.
    if (r.checkoutVersion !== undefined && r.checkoutVersion !== context.checkoutVersion) {
      return [];
    }
    return r.success && r.order
      ? [{ type: 'CartCompleted', finalState: r.finalState, at }]
      : [{ type: 'CheckoutFailed', error: r.error || 'Checkout failed', at }];
  },

  evolve: {
    // Aliasing the event's finalState into `checkout` is not a live hazard: events are
    // transient per ADR-0003, never persisted or shared.
    CartCompleted: (context, event) => ({
      ...context,
      cart: {
        ...context.cart,
        status: 'completed',
        checkout: event.finalState,
        shippingCost: event.finalState.shippingCost,
        totalTax: event.finalState.tax,
        totalPrice:
          context.cart.subtotalPrice -
          context.cart.totalDiscounts +
          event.finalState.shippingCost +
          event.finalState.tax,
      },
      // The checkout child already closed (it sent this completion) — clear the link so
      // terminal cleanup doesn't request-cancel a finished workflow. (Demo divergence:
      // mono keeps the link; the demo's onTerminal cancel would otherwise warn.)
      checkoutWorkflowId: null,
    }),

    CheckoutFailed: (context, event) => ({
      ...context,
      cart: {
        ...context.cart,
        status: 'active',
        checkout: {
          step: 'failed',
          isGuest: !context.cart.userId,
          shippingCost: 0,
          tax: 0,
          error: event.error,
        },
      },
      checkoutWorkflowId: null,
    }),
  },
};

// ==================
// The central decide / evolve — dispatchers ASSEMBLED from the blocks above, conforming
// to the framework's `MachineDecider`.
// ==================

/**
 * Every command's block, keyed by command type — the machine's whole command surface.
 * The mapped type pins each key to ITS OWN block, so a mixed-up entry is a type error.
 */
const blocks: { [K in CartCommand['type']]: CommandBlock<K> } = {
  addItem: addItemBlock,
  updateQuantity: updateQuantityBlock,
  removeItem: removeItemBlock,
  applyCoupon: applyCouponBlock,
  linkUser: linkUserBlock,
  beginCheckout: beginCheckoutBlock,
  expireCart: expireCartBlock,
  checkoutTimedOut: checkoutTimedOutBlock,
  submitStarted: submitStartedBlock,
  submitAborted: submitAbortedBlock,
  checkoutCompleted: checkoutCompletedBlock,
};

/** A block's decide, widened for dispatch (the `blocks` mapped type guarantees the match). */
type AnyDecide = (
  command: EnrichedCartCommand,
  context: Readonly<CartWorkflowContext>,
) => CartEvent[];

/** An evolve entry, widened for dispatch (the assembled map keys guarantee the match). */
type AnyEvolveEntry = (
  context: Readonly<CartWorkflowContext>,
  event: CartEvent,
) => CartWorkflowContext;

/**
 * Merge every block's evolve map into the machine's single event → entry table.
 * Duplicate keys must be the IDENTICAL function reference (the shared evolve functions
 * above) — two blocks inlining different code for one event throws here, at module
 * load, so shared events cannot silently diverge.
 */
function assembleEvolve(blockList: ReadonlyArray<{ evolve?: EvolveMap }>): EvolveMap {
  const merged: EvolveMap = {};
  for (const block of blockList) {
    if (!block.evolve) continue;
    for (const type of Object.keys(block.evolve) as CartEvent['type'][]) {
      const entry = block.evolve[type];
      if (!entry) continue;
      const existing = merged[type];
      if (existing && existing !== entry) {
        throw new Error(
          `cart evolve assembly: event '${type}' has two different evolve entries — ` +
            'share one named evolve function between the blocks instead',
        );
      }
      (merged as Record<CartEvent['type'], unknown>)[type] = entry;
    }
  }
  return merged;
}

const evolveByEvent: EvolveMap = assembleEvolve(Object.values(blocks));

/**
 * decide(command, context) → events.
 *
 * Pure: emits the events implied by the command in the current state, and nothing else. It never
 * mutates and never reads a clock or generates ids (those arrive on the command). Rejection
 * (submit-freeze, empty-cart checkout, out-of-stock) lives in the blocks' `guard`/`prepare`;
 * abandonment — a genuine domain decision — is decided by emitting `CartAbandoned` when the
 * change empties the cart, and routing keys on that event. This is a thin dispatcher: each
 * command's decision code lives inline in its block above.
 */
export function decide(
  command: EnrichedCartCommand,
  context: Readonly<CartWorkflowContext>,
): CartEvent[] {
  return (blocks[command.type].decide as AnyDecide)(command, context);
}

/**
 * evolve(context, event) → context.
 *
 * Pure application of a single event — the ONLY function that writes cart contents, `status`,
 * the checkout link/version, the submit flag, `updatedAt`, or `cartVersion` — and it writes
 * them by returning a NEW context. The dispatcher stamps `updatedAt` from the event's `at` and
 * bumps `cartVersion` on every event (versions are freshness tokens — monotonicity is what
 * consumers compare, so a two-event command bumping twice is fine), then hands the stamped
 * context to the emitting block's evolve entry, which builds its result by structural sharing.
 * No deep copy, no mutation anywhere.
 */
export function evolve(
  context: Readonly<CartWorkflowContext>,
  event: CartEvent,
): CartWorkflowContext {
  const stamped: CartWorkflowContext = {
    ...context,
    cart: {
      ...context.cart,
      updatedAt: event.at,
      cartVersion: (context.cart.cartVersion || 0) + 1,
    },
  };
  const entry = evolveByEvent[event.type];
  return entry ? (entry as AnyEvolveEntry)(stamped, event) : stamped;
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

// ==================
// The machine (ADR-0024 decider-native surface)
// ==================

const m = defineMachine<
  CartStateName,
  CartCommand,
  CartEvent,
  CartWorkflowContext,
  CartUpdateResponse
>({
  decider: cartDecider,
  respond: (context) => context.cart,
});

// ==================
// Outbound nudge to the checkout child when the cart changes mid-checkout —
// an EFFECT keyed by the item-edit events, replacing the old hand-maintained
// ITEM_EDIT_EVENTS list in workflows.ts. The nudge carries the post-evolve cartVersion
// (evolve already bumped it); checkout re-pulls the cart live via queryCart.
// ==================

const recomputeSignal = defineSignal<[{ cartVersion: number }]>('recompute');

async function nudgeCheckout(
  _event: CartEvent,
  context: Readonly<CartWorkflowContext>,
): Promise<void> {
  if (!context.checkoutWorkflowId) return;
  try {
    const handle = getExternalWorkflowHandle(context.checkoutWorkflowId);
    await handle.signal(recomputeSignal, { cartVersion: context.cart.cartVersion });
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
// State: active — the commands tables reference the SAME blocks the dispatchers are
// assembled from; the framework reads only their `guard`/`prepare`.
// ==================

const active = m.state('active', {
  commands: {
    addItem: addItemBlock,
    updateQuantity: updateQuantityBlock,
    removeItem: removeItemBlock,
    applyCoupon: applyCouponBlock,
    linkUser: linkUserBlock,
    expireCart: expireCartBlock,
    beginCheckout: beginCheckoutBlock,
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
// State: checkout — the cart stays editable (same blocks); edits nudge the checkout
// child via the item-edit effects. The submit freeze and the completion result arrive
// as signal-mapped commands.
// ==================

const checkout = m.state('checkout', {
  commands: {
    addItem: addItemBlock,
    updateQuantity: updateQuantityBlock,
    removeItem: removeItemBlock,
    applyCoupon: applyCouponBlock,
    linkUser: linkUserBlock,
    // Idempotent no-op mid-checkout: deliberately NOT the beginCheckout block — no
    // guard, no prepare → no child id → the decider emits nothing; the caller still
    // gets the current cart back.
    beginCheckout: {},
    submitStarted: submitStartedBlock,
    submitAborted: submitAbortedBlock,
    checkoutCompleted: checkoutCompletedBlock,
    checkoutTimedOut: checkoutTimedOutBlock,
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
