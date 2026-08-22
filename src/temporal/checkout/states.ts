/**
 * The checkout machine, co-located in one file (ADR-0024 decider-native surface,
 * aligned with nightheron-mono's CommandBlock convention).
 *
 * Everything about the machine lives here, in reading order: the enriched command union
 * (with one `prepared` shape per I/O-bearing command) and the past-tense event union;
 * the evolve entries shared by several commands; then ONE `CommandBlock` PER COMMAND —
 * a single exported structure holding the command's whole story, code inlined: its
 * `prepare` (the only I/O), its `decide` case, and the `evolve` entries for the events
 * it emits (the doc-pinned sagas `prepareSetShipping` / `prepareSubmitOrder` stay named
 * functions the blocks reference); then the central `decide`/`evolve`, ASSEMBLED from
 * the blocks; and finally the machine assembly: effects, the `m.state` declarations
 * (whose commands tables reference the SAME blocks), and the registry.
 *
 *   decide: (command, context) => Event[]     // what happened, as past-tense events
 *   evolve: (context, event)   => Context     // apply one event — returns a NEW context
 *
 * All I/O (cart query, reservations, shipping/tax pricing, the PaymentIntent, the whole
 * submit-order pipeline) lives in the blocks' `prepare` phases (the submit saga stays a
 * prepare — the TOCTOU rule protects its atomic check-and-confirm sequence); their
 * results arrive enriched on the commands. `evolve` owns every
 * `CheckoutContext`/`CheckoutState` change, including the pricing math
 * `totalPrice = subtotal − discounts + shipping + tax`. Routing keys on the emitted
 * events, per state: `ValidationFailed` is terminal in `validating`, while the rejection
 * events in `collecting` write their error into `state.error` and stay put. Reservation
 * releases on cancellation are an event-keyed effect carrying the decided reason and the
 * pre-evolve reservation list.
 *
 * Topology matches the mono: `validating` (transitional escape hatch) → `collecting`, a
 * single prerequisite-accumulation state. The UI step (shipping → payment → review) is
 * *derived* from which prerequisites are satisfied (see `deriveStep` in `workflows.ts`),
 * not tracked as machine states.
 */
import { defineSignal, getExternalWorkflowHandle, log, workflowInfo } from '@temporalio/workflow';
import type { Cart } from '../contracts';
import {
  calculateShipping,
  calculateTax,
  processPayment,
  refundPayment,
  createOrder,
  createPaymentIntent,
  sendConfirmationEmail,
  startOrderManagementWorkflow,
  releaseReservations,
  confirmReservations,
  renewReservationsForCheckout,
  queryCart,
} from './activities';
import type { ReservationInfo } from './activities';
import type {
  CheckoutState,
  ShippingAddress,
  Order,
  PaymentMethod,
  QueriedCart,
  CheckoutCommand,
  CheckoutContext,
  CheckoutStateName,
} from './types';
import { assembleEvolve, deriveRoutes } from '../framework';
import { defineMachine, terminal, SELF } from '../framework';
import type {
  CommandBlock as FrameworkCommandBlock,
  EffectsMap,
  EvolveMap as FrameworkEvolveMap,
  MachineDecider,
  StateRegistry,
} from '../framework';

// ==================
// Commands and events — the machine's whole vocabulary
// ==================

// ── `prepare` result shapes (shared with the shell) ──────────────────────

/** Result of pulling the live cart + renewing reservations on checkout entry. */
export interface ValidatingPrepared {
  success: boolean;
  reservations: ReservationInfo[];
  error?: string;
  /** Live cart contents (queryCart) — applied to the context on success. */
  cart: QueriedCart;
}

/**
 * Result of a recompute nudge: the re-pulled cart, plus re-priced shipping/tax when a
 * shipping address was already set (otherwise pricing waits for setShipping).
 */
export interface RecomputePrepared {
  cart: QueriedCart;
  shippingCost?: number;
  tax?: number;
}

/** Result of pricing a shipping address (+ creating the PaymentIntent). */
export interface ShippingPrepared {
  calculatedShipping: number;
  calculatedTax: number;
  clientSecret?: string;
  paymentIntentError?: string;
}

/** Result of the submit-order pipeline (payment → reservations → order → email → OMS). */
export type SubmitOrderPrepared =
  | { success: true; order: Order; newState: CheckoutState }
  | {
      success: false;
      error: string;
      /**
       * The pipeline failed somewhere the charge state is unknowable (after payment,
       * before the order settled). Tells the `SubmitRejected` fold to RETAIN the
       * idempotency attempt so a retry replays the same key — the gateway returns the
       * first result instead of charging again. Absent everywhere the charge is settled:
       * declined, refunded, or never attempted.
       */
      mayHaveCharged?: true;
    };

/**
 * The command as the decider sees it: the base `CheckoutCommand` union with the fields
 * the blocks' `prepare` phases inject, plus the framework's deterministic timestamp
 * (the collapse ADR-0024 prescribes — one union, with enrichment expressed as
 * intersections on it rather than a hand-maintained parallel union).
 */
export type EnrichedCheckoutCommand = (
  | (Extract<CheckoutCommand, { type: 'validate' }> & { prepared: ValidatingPrepared })
  | (Extract<CheckoutCommand, { type: 'setShipping' }> & { prepared: ShippingPrepared })
  | (Extract<CheckoutCommand, { type: 'submitOrder' }> & { prepared: SubmitOrderPrepared })
  | (Extract<CheckoutCommand, { type: 'recompute' }> & { prepared: RecomputePrepared })
  | Exclude<CheckoutCommand, { type: 'validate' | 'setShipping' | 'submitOrder' | 'recompute' }>
) & { at: string };

/** Past-tense domain events. */
export type CheckoutEvent =
  | { type: 'CartLoaded'; cart: QueriedCart; reservations: ReservationInfo[] }
  | { type: 'ValidationFailed'; error: string }
  | {
      type: 'ShippingSet';
      shippingAddress: ShippingAddress;
      shipping: number;
      tax: number;
      clientSecret?: string;
    }
  | {
      type: 'ShippingFailed';
      shippingAddress: ShippingAddress;
      shipping: number;
      tax: number;
      error: string;
    }
  | { type: 'PaymentSet'; paymentMethod: PaymentMethod }
  | { type: 'CartChangeAcknowledged'; cartVersion: number }
  | { type: 'ParentRetargeted'; parentCartWorkflowId: string }
  /**
   * Carries the pre-evolve reservations so the release effect can act on them: `evolve`
   * clears `context.reservations` on this event (so `onTerminal` cannot double-release),
   * which means the post-evolve context no longer knows what to release — the event does.
   */
  | {
      type: 'Cancelled';
      reason: 'checkout-cancelled' | 'checkout-timeout';
      reservations: ReservationInfo[];
    }
  | { type: 'OrderSubmitted'; newState: CheckoutState }
  | { type: 'SubmitRejected'; error: string; mayHaveCharged?: true }
  | { type: 'Recomputed'; cart: QueriedCart; shipping: number; tax: number };

/** One member of the WIRE command union (pre-enrichment), by its `type` tag. */
type Wire<K extends CheckoutCommand['type']> = Extract<CheckoutCommand, { type: K }>;

/** One member of the enriched command union, by its `type` tag. */
type Cmd<K extends EnrichedCheckoutCommand['type']> = Extract<EnrichedCheckoutCommand, { type: K }>;

/** One member of the event union, by its `type` tag. */
type Ev<K extends CheckoutEvent['type']> = Extract<CheckoutEvent, { type: K }>;

/**
 * Combined signal sent to the parent cart (wire name 'checkoutCompleted'): the
 * completion result + the submit-freeze phases.
 */
export const cartInboundSignal = defineSignal<[Cart.CartInboundSignal]>('checkoutCompleted');

// ==================
// Shared evolve entries — the pieces referenced by MORE THAN ONE command block.
// Everything used by exactly one command lives INLINE in that command's block below
// (the inlining rule: the block IS the code, not an index of named functions).
// ==================

/** Emitted by cancelCheckout and by checkoutTimedOut — the decided reason and the
 *  pre-evolve reservation list ride the event to the release effect. */
function evolveCancelled(
  context: Readonly<CheckoutContext>,
  _event: Ev<'Cancelled'>,
): CheckoutContext {
  return { ...context, state: { ...context.state, error: undefined }, reservations: [] };
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
type EvolveMap = FrameworkEvolveMap<CheckoutEvent, CheckoutContext>;

/** One command's whole story: refusal, I/O, decision, and the evolve for what it emits. */
export type CommandBlock<K extends CheckoutCommand['type']> = FrameworkCommandBlock<
  CheckoutContext,
  Wire<K>,
  Cmd<K>,
  CheckoutEvent,
  CheckoutStateName,
  CheckoutState
>;

// ==================
// Command: validate — the whole story. Pull authoritative cart contents live (no
// snapshot), then reserve against them. `CartLoaded` advances to `collecting`;
// `ValidationFailed` is terminal in `validating`.
// ==================

export const validateBlock: CommandBlock<'validate'> = {
  // Both destinations are this block's alone — `validate` is only in `validating`, so
  // `ValidationFailed` cannot reach `collecting` and needs no stay-exception there.
  routes: { CartLoaded: 'collecting', ValidationFailed: terminal('failed') },
  prepare: async (context): Promise<{ prepared: ValidatingPrepared }> => {
    const cart = await queryCart(context.parentCartWorkflowId);
    const res = await renewReservationsForCheckout(context.cartId, cart.items);
    return { prepared: { ...res, cart } };
  },

  decide: (command, _context) => {
    const p = command.prepared;
    return p.success
      ? [{ type: 'CartLoaded', cart: p.cart, reservations: p.reservations }]
      : [{ type: 'ValidationFailed', error: p.error || 'Some items are no longer available' }];
  },

  evolve: {
    CartLoaded: (context, event) => {
      const { cart } = event;
      return {
        ...context,
        items: cart.items,
        subtotalPrice: cart.subtotalPrice,
        totalDiscounts: cart.totalDiscounts,
        appliedCoupons: cart.appliedCoupons,
        cartVersion: cart.cartVersion,
        totalPrice: cart.subtotalPrice - cart.totalDiscounts,
        reservations: event.reservations,
        // The approved baseline is the version validation actually pulled and priced.
        // The workflow-input snapshot predates the cart's own CheckoutEntered version
        // bump, so leaving atStart/acknowledged there marks every FRESH checkout as
        // "changed" — the R3 false positive the dead banner used to hide (backlog #3).
        state: {
          ...context.state,
          cartVersionAtStart: cart.cartVersion,
          cartVersionAcknowledged: cart.cartVersion,
        },
      };
    },
    ValidationFailed: (context, event) => ({
      ...context,
      state: { ...context.state, error: event.error },
    }),
  },
};

// ==================
// Command: setShipping — the whole story. `prepare` computes shipping/tax and creates
// the PaymentIntent; the decider turns the prepared result into `ShippingFailed`
// (intent failure — address stored) or `ShippingSet`.
// ==================

async function prepareSetShipping(
  context: Readonly<CheckoutContext>,
  shippingAddress: ShippingAddress,
): Promise<ShippingPrepared> {
  const calculatedShipping = await calculateShipping(
    `${shippingAddress.city}, ${shippingAddress.state} ${shippingAddress.postalCode}`,
  );
  const calculatedTax = await calculateTax(
    shippingAddress.state,
    context.subtotalPrice - context.totalDiscounts,
  );

  let clientSecret = context.state.clientSecret;
  let paymentIntentError: string | undefined;
  try {
    const totalPrice =
      context.subtotalPrice - context.totalDiscounts + calculatedShipping + calculatedTax;
    const result = await createPaymentIntent(totalPrice, context.currency);
    clientSecret = result.clientSecret;
  } catch (e) {
    log.error('Failed to create payment intent', { error: String(e) });
    paymentIntentError = 'Unable to initialize payment. Please try again.';
  }

  return { calculatedShipping, calculatedTax, clientSecret, paymentIntentError };
}

export const setShippingBlock: CommandBlock<'setShipping'> = {
  // Neither event moves the machine: `ShippingFailed` writes to `state.error` and stays,
  // `ShippingSet` accumulates a prerequisite. Absence means "stays".
  // The saga above is doc-pinned by name; the block's prepare wraps it.
  prepare: async (context, command) => ({
    prepared: await prepareSetShipping(context, command.shippingAddress),
  }),

  decide: (command, context) => {
    const p = command.prepared;
    if (p.paymentIntentError) {
      return [
        {
          type: 'ShippingFailed',
          shippingAddress: command.shippingAddress,
          shipping: p.calculatedShipping,
          tax: p.calculatedTax,
          error: p.paymentIntentError,
        },
      ];
    }
    return [
      {
        type: 'ShippingSet',
        shippingAddress: command.shippingAddress,
        shipping: p.calculatedShipping,
        tax: p.calculatedTax,
        clientSecret: p.clientSecret ?? context.state.clientSecret,
      },
    ];
  },

  evolve: {
    ShippingSet: (context, event) => {
      const state: CheckoutState = {
        ...context.state,
        shippingAddress: event.shippingAddress,
        shippingCost: event.shipping,
        tax: event.tax,
        clientSecret: event.clientSecret,
        error: undefined,
      };
      return {
        ...context,
        state,
        shippingCost: event.shipping,
        totalTax: event.tax,
        totalPrice: context.subtotalPrice - context.totalDiscounts + event.shipping + event.tax,
      };
    },

    ShippingFailed: (context, event) => {
      const state: CheckoutState = {
        ...context.state,
        shippingAddress: event.shippingAddress,
        shippingCost: event.shipping,
        tax: event.tax,
        error: event.error,
      };
      return {
        ...context,
        state,
        shippingCost: event.shipping,
        totalTax: event.tax,
        totalPrice: context.subtotalPrice - context.totalDiscounts + event.shipping + event.tax,
      };
    },
  },
};

// ==================
// Command: setPayment — the whole story (no prepare; the client's tokenized method)
// ==================

export const setPaymentBlock: CommandBlock<'setPayment'> = {
  decide: (command, _context) => [{ type: 'PaymentSet', paymentMethod: command.paymentMethod }],

  evolve: {
    PaymentSet: (context, event) => ({
      ...context,
      state: { ...context.state, paymentMethod: event.paymentMethod, error: undefined },
    }),
  },
};

// ==================
// Command: acknowledgeCartChange — the whole story (the review page saw the new version)
// ==================

export const acknowledgeCartChangeBlock: CommandBlock<'acknowledgeCartChange'> = {
  decide: (command, _context) => [
    { type: 'CartChangeAcknowledged', cartVersion: command.cartVersion },
  ],

  evolve: {
    CartChangeAcknowledged: (context, event) => ({
      ...context,
      state: { ...context.state, cartVersionAcknowledged: event.cartVersion },
    }),
  },
};

// ==================
// Command: retargetParent — the whole story (the parent cart workflow moved — e.g. a
// continued-as-new parent under a new workflow id)
// ==================

export const retargetParentBlock: CommandBlock<'retargetParent'> = {
  decide: (command, _context) => [
    { type: 'ParentRetargeted', parentCartWorkflowId: command.newParentCartWorkflowId },
  ],

  evolve: {
    ParentRetargeted: (context, event) => ({
      ...context,
      parentCartWorkflowId: event.parentCartWorkflowId,
    }),
  },
};

// ==================
// Commands: cancelCheckout / checkoutTimedOut — two blocks, one outcome. Both decide
// `Cancelled`, carrying WHICH reason for the audit trail plus the pre-evolve reservation
// list; the release is an event-keyed machine-level effect (see `defineMachine` below).
// ==================

export const cancelCheckoutBlock: CommandBlock<'cancelCheckout'> = {
  routes: { Cancelled: terminal('cancelled') },
  decide: (_command, context) => [
    { type: 'Cancelled', reason: 'checkout-cancelled', reservations: context.reservations },
  ],

  evolve: {
    Cancelled: evolveCancelled, // shared with checkoutTimedOut
  },
};

export const checkoutTimedOutBlock: CommandBlock<'checkoutTimedOut'> = {
  // Same destination `cancelCheckout` declares — a value-equal duplicate, which is the
  // premise of derivation rather than an exception to it.
  routes: { Cancelled: terminal('cancelled') },
  decide: (_command, context) => [
    { type: 'Cancelled', reason: 'checkout-timeout', reservations: context.reservations },
  ],

  evolve: {
    Cancelled: evolveCancelled,
  },
};

// ==================
// Command: submitOrder — the whole story. Non-mutating saga: the entire payment/order
// pipeline runs in `prepare`. The parent-cart freeze signals stay HERE deliberately:
// the freeze must precede the price query, so it cannot be a post-evolve effect. The
// decider is pure: `OrderSubmitted` routes to terminal('complete'), `SubmitRejected`
// writes the error and stays.
// ==================

async function prepareSubmitOrder(
  context: Readonly<CheckoutContext>,
): Promise<SubmitOrderPrepared> {
  try {
    const paymentSuccess = await processPayment(
      context.state.paymentMethod!.token,
      context.totalPrice,
      context.currency,
      // Idempotency key: this checkout's own workflow id plus the attempt ordinal — a nonce
      // naming the ATTEMPT, with the amount a parameter the gateway validates against it (a
      // replayed key with a different amount is an ERROR, not a new charge). Never derived
      // from mutable business data.
      //
      // Replaces `${cartId}-${totalPrice}` (mono #241 / `f42c3bda`): an amount is not an
      // identity — a same-total basket swap aliased to one key; the refund path left a
      // "charged" key that a same-total retry deduped against; and float-formatted money
      // makes unstable key strings. Deliberate divergence from the mono, ledgered in
      // docs/reference/mono-sync-2026-08-17.md as a backport candidate.
      //
      // The workflow id is used whole, never parsed (the id-parsing lesson), and is unique
      // per checkout instance; `paymentAttempt` moves only in the `SubmitRejected` fold,
      // and only when the rejected attempt's charge is settled.
      `${workflowInfo().workflowId}-pay-${context.paymentAttempt}`,
    );

    if (!paymentSuccess) {
      // Demo divergence from mono: reservations are KEPT for a submit retry (they
      // expire via the inventory TTL), not released on payment failure.
      return { success: false, error: 'Payment failed. Please try again.' };
    }

    // Two-phase resurrect-then-confirm (issue #34): a hold that expired while the
    // shopper parked at payment is re-acquired only if the stock is still there. If
    // any item is gone, refund and fail the submit BEFORE the order exists — no
    // order, no fulfillment, no phantom inventory.
    const { unavailable } = await confirmReservations(context.reservations);
    if (unavailable.length > 0) {
      await refundPayment(
        context.state.paymentMethod!.token,
        context.totalPrice,
        context.currency,
        context.cartId,
      );
      return {
        success: false,
        error:
          'Some items are no longer available. Your payment has been refunded — ' +
          'please adjust your cart and try again.',
      };
    }

    const order: Order = await createOrder({
      cartId: context.cartId,
      items: context.items,
      shippingAddress: context.state.shippingAddress!,
      paymentMethod: context.state.paymentMethod!,
      subtotal: context.subtotalPrice,
      shippingCost: context.shippingCost,
      tax: context.totalTax,
      totalDiscounts: context.totalDiscounts,
      total: context.totalPrice,
      currency: context.currency,
    });

    await sendConfirmationEmail(
      context.state.shippingAddress!.email,
      order.confirmationNumber,
      order,
    );

    await startOrderManagementWorkflow(order, context.state.shippingAddress!.email);

    return { success: true, order, newState: { ...context.state, order } };
  } catch (err) {
    log.error('Failed to process order', { error: String(err) });
    // Anywhere in payment → order → email → OMS may have failed, so the charge state is
    // unknowable here: retain the attempt. A retry replays the same key — first use if
    // nothing was charged, a no-op replay if it was.
    return { success: false, error: 'An error occurred. Please try again.', mayHaveCharged: true };
  }
}

export const submitOrderBlock: CommandBlock<'submitOrder'> = {
  // `SubmitRejected` is deliberately absent: it writes its error into `state.error` and the
  // checkout stays put for the caller to read off the response.
  routes: { OrderSubmitted: terminal('complete') },
  /**
   * The payment/order pipeline runs in `prepareSubmitOrder` above (doc-pinned by name);
   * this wrapper owns the cart freeze/abort orchestration.
   */
  prepare: async (context, command): Promise<{ prepared: SubmitOrderPrepared }> => {
    if (!context.state.shippingAddress || !context.state.paymentMethod) {
      return { prepared: { success: false, error: 'Shipping and payment required' } };
    }
    // Freeze the cart for the duration of the saga: edits are rejected while the
    // order is being placed, so pricing can't drift mid-pipeline. Best-effort — a
    // missing parent (already closed) must not block the submit itself. (Demo
    // divergence: mono signals unconditionally.)
    const freeze = async (kind: 'submitStarted' | 'submitAborted') => {
      try {
        await getExternalWorkflowHandle(context.parentCartWorkflowId).signal(cartInboundSignal, {
          kind,
        });
      } catch (err) {
        log.warn('Failed to signal cart submit-freeze phase', {
          parentCartWorkflowId: context.parentCartWorkflowId,
          kind,
          error: String(err),
        });
      }
    };
    await freeze('submitStarted');

    // Re-pull the live cart so the pipeline prices against current contents; the
    // price-integrity guard catches any edit that slipped in before the freeze.
    const cart = await queryCart(context.parentCartWorkflowId);
    if (command.reviewedCartVersion != null && command.reviewedCartVersion !== cart.cartVersion) {
      await freeze('submitAborted');
      return { prepared: { success: false, error: 'CART_CHANGED' } };
    }
    const totalPrice =
      cart.subtotalPrice - cart.totalDiscounts + context.shippingCost + context.totalTax;
    const result = await prepareSubmitOrder({
      ...context,
      items: cart.items,
      subtotalPrice: cart.subtotalPrice,
      totalDiscounts: cart.totalDiscounts,
      cartVersion: cart.cartVersion,
      totalPrice,
    });
    if (!result.success) {
      await freeze('submitAborted');
    }
    return { prepared: result };
  },

  decide: (command, _context) =>
    command.prepared.success
      ? [{ type: 'OrderSubmitted', newState: command.prepared.newState }]
      : [
          {
            type: 'SubmitRejected',
            error: command.prepared.error,
            mayHaveCharged: command.prepared.mayHaveCharged,
          },
        ],

  evolve: {
    OrderSubmitted: (context, event) => ({ ...context, state: event.newState }),

    SubmitRejected: (context, event) => ({
      ...context,
      // The attempt is consumed unless the pipeline failed with a possible charge
      // outstanding — then the key is retained so a retry replays it (the gateway
      // returns the first result) instead of billing a second time.
      paymentAttempt: event.mayHaveCharged ? context.paymentAttempt : context.paymentAttempt + 1,
      state: { ...context.state, error: event.error },
    }),
  },
};

// ==================
// Command: recompute — the whole story. The cart changed during checkout (nudge from
// the parent cart, signal transport mapped to this command): re-pull the cart live,
// re-price shipping/tax when an address is set, and un-check the payment method so the
// shopper re-confirms against the new total. All I/O in prepare.
// ==================

export const recomputeBlock: CommandBlock<'recompute'> = {
  prepare: async (context): Promise<{ prepared: RecomputePrepared }> => {
    const cart = await queryCart(context.parentCartWorkflowId);
    if (!context.state.shippingAddress) {
      return { prepared: { cart } };
    }
    const addr = context.state.shippingAddress;
    const shippingCost = await calculateShipping(`${addr.city}, ${addr.state} ${addr.postalCode}`);
    const tax = await calculateTax(addr.state, cart.subtotalPrice - cart.totalDiscounts);
    return { prepared: { cart, shippingCost, tax } };
  },

  decide: (command, context) => {
    const p = command.prepared;
    return [
      {
        type: 'Recomputed',
        cart: p.cart,
        shipping: p.shippingCost ?? context.shippingCost,
        tax: p.tax ?? context.totalTax,
      },
    ];
  },

  evolve: {
    Recomputed: (context, event) => {
      const { cart } = event;
      // Un-check payment on the amount-affecting cart change so the shopper re-confirms.
      const state: CheckoutState = {
        ...context.state,
        paymentMethod: undefined,
        shippingCost: event.shipping,
        tax: event.tax,
        error: undefined,
      };
      return {
        ...context,
        items: cart.items,
        subtotalPrice: cart.subtotalPrice,
        totalDiscounts: cart.totalDiscounts,
        appliedCoupons: cart.appliedCoupons,
        cartVersion: cart.cartVersion,
        shippingCost: event.shipping,
        totalTax: event.tax,
        totalPrice: cart.subtotalPrice - cart.totalDiscounts + event.shipping + event.tax,
        state,
      };
    },
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
const blocks: { [K in CheckoutCommand['type']]: CommandBlock<K> } = {
  validate: validateBlock,
  setShipping: setShippingBlock,
  setPayment: setPaymentBlock,
  acknowledgeCartChange: acknowledgeCartChangeBlock,
  retargetParent: retargetParentBlock,
  cancelCheckout: cancelCheckoutBlock,
  checkoutTimedOut: checkoutTimedOutBlock,
  submitOrder: submitOrderBlock,
  recompute: recomputeBlock,
};

/** A block's decide, widened for dispatch (the `blocks` mapped type guarantees the match). */
type AnyDecide = (
  command: EnrichedCheckoutCommand,
  context: Readonly<CheckoutContext>,
) => CheckoutEvent[];

/** An evolve entry, widened for dispatch (the assembled map keys guarantee the match). */
type AnyEvolveEntry = (context: Readonly<CheckoutContext>, event: CheckoutEvent) => CheckoutContext;

const evolveByEvent: EvolveMap = assembleEvolve('checkout', Object.values(blocks));

/**
 * decide(command, context) → events. Pure. This is a thin dispatcher: each command's
 * decision code lives inline in its block above.
 */
export function decide(
  command: EnrichedCheckoutCommand,
  context: Readonly<CheckoutContext>,
): CheckoutEvent[] {
  return (blocks[command.type].decide as AnyDecide)(command, context);
}

/**
 * evolve(context, event) → context. Pure application of a single event — the ONLY writer
 * of `CheckoutContext` / `CheckoutState`, and it writes them by returning a NEW context
 * built by structural sharing. The dispatcher hands the event to the emitting block's
 * evolve entry (assembled above); an event with no entry leaves the context as-is.
 */
export function evolve(context: Readonly<CheckoutContext>, event: CheckoutEvent): CheckoutContext {
  const entry = evolveByEvent[event.type];
  return entry ? (entry as AnyEvolveEntry)(context, event) : context;
}

/**
 * The assembled decider, conforming to the framework's `MachineDecider` shape (ADR-0024:
 * `isTerminal` is gone — terminality is the route tables' job; `initialState` remains as
 * the canonical empty shape for decider unit tests, never consulted at runtime).
 */
export const checkoutDecider: MachineDecider<
  EnrichedCheckoutCommand,
  CheckoutEvent,
  CheckoutContext
> = {
  decide,
  evolve,
  initialState: {
    cartId: '',
    parentCartWorkflowId: '',
    items: [],
    subtotalPrice: 0,
    totalDiscounts: 0,
    currency: 'USD',
    appliedCoupons: [],
    isGuest: true,
    cartVersion: 0,
    checkoutVersion: 0,
    state: { step: 'validating', isGuest: true, shippingCost: 0, tax: 0 },
    reservations: [],
    shippingCost: 0,
    totalTax: 0,
    totalPrice: 0,
    paymentAttempt: 1,
  },
};

// ==================
// The machine (ADR-0024 decider-native surface) — binds the decider + shared type
// params once.
// ==================

const m = defineMachine<
  CheckoutStateName,
  CheckoutCommand,
  CheckoutEvent,
  CheckoutContext,
  CheckoutState
>({
  decider: checkoutDecider,
  // Errors land in `state.error` (ShippingFailed, SubmitRejected, …); the caller
  // receives the state either way — matching the old formatError contract exactly.
  respond: (context) => context.state,
  effects: {
    Cancelled: async (event) => {
      // Demo divergence from mono: reservations are explicit per-variant holds, so the
      // release needs the list — carried on the event (decided from pre-evolve state;
      // `evolve` clears `context.reservations` so `onTerminal` cannot double-release).
      if (event.reservations.length > 0) {
        await releaseReservations(event.reservations);
      }
    },
  } satisfies EffectsMap<CheckoutEvent, CheckoutContext>,
});

// ==================
// State: validating (escape hatch — transitional; the tick synthesizes `validate`).
// The commands table references the SAME block the dispatchers are assembled from; the
// framework reads only its `guard`/`prepare`.
// ==================

const validatingCommands = { validate: validateBlock };

const validating = m.state('validating', {
  commands: validatingCommands,
  route: deriveRoutes('checkout', validatingCommands),
  transitional: true,
  onTimeout: () => ({ type: 'validate' }),
});

// ==================
// State: collecting — single prerequisite-accumulation state
// ==================

const collectingCommands = {
  setShipping: setShippingBlock,
  setPayment: setPaymentBlock,
  cancelCheckout: cancelCheckoutBlock,
  acknowledgeCartChange: acknowledgeCartChangeBlock,
  retargetParent: retargetParentBlock,
  checkoutTimedOut: checkoutTimedOutBlock,
  submitOrder: submitOrderBlock,
  recompute: recomputeBlock,
};

const collecting = m.state('collecting', {
  commands: collectingCommands,
  route: deriveRoutes('checkout', collectingCommands, { '*': SELF }),
  timeout: '1 hour',
  onTimeout: () => ({ type: 'checkoutTimedOut' }),
});

// ==================
// Registry — table of contents. timeout/transitional ride the state defs above.
// ==================

export const CHECKOUT_STATES: StateRegistry<
  CheckoutStateName,
  CheckoutCommand,
  CheckoutContext,
  CheckoutState,
  CheckoutCommand
> = {
  validating,
  collecting,
};
