import { describe, it, expect } from 'vitest';

// Pure Functional Core: no Temporal sandbox, no activity mocks, no uuid4 — the whole point of
// the Chassaing rollout. `decide` is asserted on the events it emits; `evolve` on the fold.
// The per-command blocks are exported structures, so each command's guard / decide / evolve
// entries are exercised directly in addition to the assembled dispatchers.
import {
  decide,
  deriveRoutes,
  evolve,
  cartDecider,
  addItemBlock,
  updateQuantityBlock,
  removeItemBlock,
  applyCouponBlock,
  linkUserBlock,
  beginCheckoutBlock,
  expireCartBlock,
  checkoutTimedOutBlock,
  submitStartedBlock,
  submitAbortedBlock,
  checkoutCompletedBlock,
} from './states';
import type { CartEvent, EnrichedCartCommand } from './states';
import type { CartDetails, CartWorkflowContext, CheckoutWorkflowResult } from './types';
import { terminal } from '../framework';

// ── Builders ────────────────────────────────────────────────────────────────
function makeCart(overrides: Partial<CartDetails> = {}): CartDetails {
  return {
    cartId: 'cart-1',
    items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 1, price: 10 }],
    subtotalPrice: 10,
    totalDiscounts: 0,
    totalTax: 0.8,
    totalPrice: 10.8,
    shippingCost: 0,
    currency: 'USD',
    appliedCoupons: [],
    cartVersion: 1,
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<CartWorkflowContext> = {}): CartWorkflowContext {
  return { cart: makeCart(), checkoutWorkflowId: null, checkoutVersion: 0, ...overrides };
}

const at = '2026-08-09T00:00:00.000Z';

const apply = (ctx: CartWorkflowContext, cmd: EnrichedCartCommand): CartWorkflowContext =>
  decide(cmd, ctx).reduce(evolve, ctx);

const okResult = (over: Partial<CheckoutWorkflowResult> = {}): CheckoutWorkflowResult => ({
  success: true,
  finalState: { step: 'complete', isGuest: true, shippingCost: 5, tax: 0.8 },
  order: { orderId: 'o-1' } as never,
  checkoutVersion: 0,
  ...over,
});

// ── decide ──────────────────────────────────────────────────────────────────
describe('decide', () => {
  it('addItem emits ItemAdded with the injected lineItemId', () => {
    const events = decide(
      { type: 'addItem', variantId: 'v2', quantity: 2, price: 5, lineItemId: 'li-new', at },
      makeCtx(),
    );
    expect(events).toEqual([
      {
        type: 'ItemAdded',
        variantId: 'v2',
        quantity: 2,
        price: 5,
        properties: undefined,
        lineItemId: 'li-new',
        at,
      },
    ]);
  });

  it('updateQuantity of an unknown line emits nothing', () => {
    expect(
      decide({ type: 'updateQuantity', lineItemId: 'nope', quantity: 2, at }, makeCtx()),
    ).toEqual([]);
  });

  it('updateQuantity to 0 on the last line also abandons the cart', () => {
    const events = decide(
      { type: 'updateQuantity', lineItemId: 'li-1', quantity: 0, at },
      makeCtx(),
    );
    expect(events.map((f: CartEvent) => f.type)).toEqual(['ItemRemoved', 'CartAbandoned']);
  });

  it('removeItem of one of several lines emits only ItemRemoved', () => {
    const ctx = makeCtx({
      cart: makeCart({
        items: [
          { lineItemId: 'li-1', variantId: 'v1', quantity: 1, price: 10 },
          { lineItemId: 'li-2', variantId: 'v2', quantity: 1, price: 5 },
        ],
      }),
    });
    const events = decide({ type: 'removeItem', lineItemId: 'li-1', at }, ctx);
    expect(events.map((f) => f.type)).toEqual(['ItemRemoved']);
  });

  it('applyCoupon deduplicates', () => {
    const ctx = makeCtx({ cart: makeCart({ appliedCoupons: ['SAVE20'] }) });
    expect(decide({ type: 'applyCoupon', code: 'SAVE20', at }, ctx)).toEqual([]);
  });

  it('beginCheckout bumps the checkout version', () => {
    const events = decide(
      { type: 'beginCheckout', checkoutWorkflowId: 'demo.checkout.x', at },
      makeCtx({ checkoutVersion: 2 }),
    );
    expect(events).toEqual([
      { type: 'CheckoutEntered', checkoutWorkflowId: 'demo.checkout.x', checkoutVersion: 3, at },
    ]);
  });

  it('beginCheckout without a child id (mid-checkout no-op) emits nothing', () => {
    expect(decide({ type: 'beginCheckout', at }, makeCtx())).toEqual([]);
  });

  it('checkoutTimedOut disowns only while in checkout', () => {
    const inCheckout = makeCtx({ cart: makeCart({ status: 'checkout' }) });
    expect(decide({ type: 'checkoutTimedOut', at }, inCheckout).map((f) => f.type)).toEqual([
      'CheckoutDisowned',
    ]);
    expect(decide({ type: 'checkoutTimedOut', at }, makeCtx())).toEqual([]);
  });

  it('expireCart abandons the cart', () => {
    expect(decide({ type: 'expireCart', at }, makeCtx())).toEqual([{ type: 'CartAbandoned', at }]);
  });

  it('checkoutCompleted with a stale version emits nothing', () => {
    const events = decide(
      { type: 'checkoutCompleted', result: okResult({ checkoutVersion: 1 }), at },
      makeCtx({ checkoutVersion: 5 }),
    );
    expect(events).toEqual([]);
  });

  it('checkoutCompleted success emits CartCompleted; failure emits CheckoutFailed with the error', () => {
    expect(
      decide({ type: 'checkoutCompleted', result: okResult(), at }, makeCtx()).map((f) => f.type),
    ).toEqual(['CartCompleted']);
    expect(
      decide(
        {
          type: 'checkoutCompleted',
          result: okResult({ success: false, order: undefined, error: 'declined' }),
          at,
        },
        makeCtx(),
      ),
    ).toEqual([{ type: 'CheckoutFailed', error: 'declined', at }]);
  });

  it('submitStarted / submitAborted drive the freeze events', () => {
    expect(decide({ type: 'submitStarted', at }, makeCtx())).toEqual([
      { type: 'SubmitFreezeStarted', at },
    ]);
    expect(decide({ type: 'submitAborted', at }, makeCtx())).toEqual([
      { type: 'SubmitFreezeCleared', at },
    ]);
  });

  it('decide never mutates the input state', () => {
    const s = makeCtx();
    const snapshot = structuredClone(s);
    decide({ type: 'removeItem', lineItemId: 'li-1', at }, s);
    expect(s).toEqual(snapshot);
  });
});

// ── evolve ──────────────────────────────────────────────────────────────────
describe('evolve', () => {
  it('ItemAdded merges quantity for an existing variant', () => {
    const ctx = apply(makeCtx(), {
      type: 'addItem',
      variantId: 'v1',
      quantity: 2,
      price: 10,
      lineItemId: 'li-x',
      at,
    });
    expect(ctx.cart.items).toHaveLength(1);
    expect(ctx.cart.items[0].quantity).toBe(3);
    expect(ctx.cart.subtotalPrice).toBe(30);
  });

  it('ItemAdded appends a new variant line', () => {
    const ctx = apply(makeCtx(), {
      type: 'addItem',
      variantId: 'v2',
      quantity: 1,
      price: 5,
      lineItemId: 'li-2',
      at,
    });
    expect(ctx.cart.items.map((i) => i.variantId)).toEqual(['v1', 'v2']);
    expect(ctx.cart.subtotalPrice).toBe(15);
  });

  // ── display snapshot (backlog #1 / R1) ────────────────────────────────────
  const snapshot = {
    productId: 'p1',
    productTitle: 'California Surf — Tee [Simulated]',
    variantTitle: 'Baby Blue / 4XL',
    optionLabels: ['Baby Blue', '4XL'],
    thumbnailUrl: 'https://img/front.webp',
  };

  it('ItemAdded stores the display snapshot on the new line', () => {
    const ctx = apply(makeCtx(), {
      type: 'addItem',
      variantId: 'v2',
      quantity: 1,
      price: 5,
      lineItemId: 'li-2',
      at,
      ...snapshot,
    });
    const line = ctx.cart.items.find((i) => i.lineItemId === 'li-2')!;
    expect(line).toMatchObject(snapshot);
  });

  it('ItemAdded without a snapshot stores NO snapshot keys (not explicit undefined)', () => {
    const ctx = apply(makeCtx(), {
      type: 'addItem',
      variantId: 'v2',
      quantity: 1,
      price: 5,
      lineItemId: 'li-2',
      at,
    });
    const line = ctx.cart.items.find((i) => i.lineItemId === 'li-2')!;
    // Explicit `undefined` keys would defeat the backfill merge below.
    expect('productTitle' in line).toBe(false);
    expect('thumbnailUrl' in line).toBe(false);
  });

  it('ItemAdded merge backfills a pre-snapshot line without disturbing its identity', () => {
    // makeCtx()'s existing li-1/v1 line predates the snapshot fields.
    const ctx = apply(makeCtx(), {
      type: 'addItem',
      variantId: 'v1',
      quantity: 2,
      price: 10,
      lineItemId: 'li-ignored',
      at,
      ...snapshot,
    });
    expect(ctx.cart.items).toHaveLength(1);
    const line = ctx.cart.items[0];
    expect(line.lineItemId).toBe('li-1'); // existing identity wins
    expect(line.quantity).toBe(3);
    expect(line.productTitle).toBe(snapshot.productTitle); // backfilled
    expect(line.variantTitle).toBe(snapshot.variantTitle);
  });

  it('does not mutate the input state', () => {
    const ctx = makeCtx();
    apply(ctx, { type: 'removeItem', lineItemId: 'li-1', at });
    expect(ctx.cart.items).toHaveLength(1);
    expect(ctx.cart.status).toBe('active');
  });

  it('CouponApplied recalculates SAVE20 discount and tax', () => {
    const ctx = apply(makeCtx(), { type: 'applyCoupon', code: 'SAVE20', at });
    expect(ctx.cart.appliedCoupons).toEqual(['SAVE20']);
    expect(ctx.cart.totalDiscounts).toBe(2); // 20% of 10
    expect(ctx.cart.totalTax).toBeCloseTo(0.64); // 8% of 8
  });

  it('UserLinked sets email and userId', () => {
    const ctx = apply(makeCtx(), { type: 'linkUser', email: 'a@b.c', userId: 'u-1', at });
    expect(ctx.cart.email).toBe('a@b.c');
    expect(ctx.cart.userId).toBe('u-1');
  });

  it('UserLinked leaves cartVersion unchanged — identity is not content (run -008 F-3)', () => {
    // Through the CENTRAL evolve, so the dispatcher's generic freshness bump is in play:
    // the fold must compensate it, exactly as CheckoutEntered does. Uncompensated, the
    // guest email attach at the address step bumps the version with no content change and
    // the cart-changed banner false-positives at review on every guest checkout.
    const before = makeCtx();
    const ctx = apply(before, { type: 'linkUser', email: 'a@b.c', userId: 'u-1', at });
    expect(ctx.cart.cartVersion).toBe(before.cart.cartVersion);
  });

  it('CheckoutEntered sets checkout fields and the link', () => {
    const ctx = apply(makeCtx({ checkoutVersion: 1 }), {
      type: 'beginCheckout',
      checkoutWorkflowId: 'demo.checkout.y',
      at,
    });
    expect(ctx.cart.status).toBe('checkout');
    expect(ctx.cart.checkout?.step).toBe('validating');
    expect(ctx.checkoutWorkflowId).toBe('demo.checkout.y');
    expect(ctx.checkoutVersion).toBe(2);
  });

  it('CheckoutFailed returns the cart to active, keeps the failure visible, drops the link', () => {
    const inCheckout = apply(makeCtx(), { type: 'beginCheckout', checkoutWorkflowId: 'x', at });
    const ctx = apply(inCheckout, {
      type: 'checkoutCompleted',
      // checkoutVersion 1 matches the version beginCheckout just bumped to (0 → 1).
      result: okResult({ success: false, order: undefined, error: 'declined', checkoutVersion: 1 }),
      at,
    });
    expect(ctx.cart.status).toBe('active');
    expect(ctx.cart.checkout?.step).toBe('failed');
    expect(ctx.cart.checkout?.error).toBe('declined');
    expect(ctx.checkoutWorkflowId).toBeNull();
  });

  it('CheckoutDisowned (checkoutTimedOut) clears the checkout fields entirely', () => {
    const inCheckout = apply(makeCtx(), { type: 'beginCheckout', checkoutWorkflowId: 'x', at });
    const ctx = apply(inCheckout, { type: 'checkoutTimedOut', at });
    expect(ctx.cart.status).toBe('active');
    expect(ctx.cart.checkout).toBeUndefined();
    expect(ctx.checkoutWorkflowId).toBeNull();
  });

  it('CartCompleted folds the final checkout state into totals and drops the link', () => {
    const inCheckout = apply(makeCtx(), { type: 'beginCheckout', checkoutWorkflowId: 'x', at });
    const ctx = apply(inCheckout, {
      type: 'checkoutCompleted',
      result: okResult({ checkoutVersion: 1 }),
      at,
    });
    expect(ctx.cart.status).toBe('completed');
    expect(ctx.cart.shippingCost).toBe(5);
    expect(ctx.cart.totalTax).toBe(0.8);
    expect(ctx.cart.totalPrice).toBeCloseTo(10 - 0 + 5 + 0.8);
    // The checkout child already closed — the link is dropped so terminal cleanup
    // doesn't request-cancel a finished workflow (demo divergence: mono keeps the link).
    expect(ctx.checkoutWorkflowId).toBeNull();
  });
});

// ── replaying is a fold ─────────────────────────────────────────────────────
describe('rebuilding state is a fold (decide → evolve)', () => {
  it('remove-last folds active → abandoned', () => {
    const s0 = makeCtx();
    const events = decide({ type: 'removeItem', lineItemId: 'li-1', at }, s0);
    const s1 = events.reduce(evolve, s0);
    expect(s1.cart.items).toHaveLength(0);
    expect(s1.cart.status).toBe('abandoned');
  });

  it('a whole lifecycle replays active → completed', () => {
    const history: CartEvent[] = [
      { type: 'ItemAdded', variantId: 'v2', quantity: 1, price: 5, lineItemId: 'li-2', at },
      { type: 'CheckoutEntered', checkoutWorkflowId: 'c-1', checkoutVersion: 1, at },
      {
        type: 'CartCompleted',
        finalState: { step: 'complete', isGuest: true, shippingCost: 0, tax: 0 },
        at,
      },
    ];
    const final = history.reduce(evolve, makeCtx());
    expect(final.cart.status).toBe('completed');
    expect(final.cart.items).toHaveLength(2);
  });
});

// ── decider shape ───────────────────────────────────────────────────────────
describe('cartDecider — the assembled decider', () => {
  it("has no isTerminal — terminality is the route tables' job (ADR-0024)", () => {
    // The machine terminates by routing CartAbandoned/CartCompleted to terminal states,
    // never by asking the decider. Pin the removal so it does not quietly return.
    expect('isTerminal' in cartDecider).toBe(false);
  });

  it('exposes decide, evolve, and an initialState in the active status', () => {
    expect(cartDecider.decide).toBe(decide);
    expect(cartDecider.evolve).toBe(evolve);
    expect(cartDecider.initialState!.cart.status).toBe('active');
  });
});

// ── version/timestamp stamping (was the workflow's flushCart bump) ──────────
describe('evolve — version/timestamp stamping', () => {
  it('CheckoutEntered is version-NEUTRAL (entering checkout is not a content change)', () => {
    // The checkout child snapshots the pre-command version and its validating re-pull
    // can race this evolve — a bump here would baseline the child one behind and
    // false-positive the cart-changed banner on every fresh checkout (R6 finding).
    const s = makeCtx();
    const before = s.cart.cartVersion;
    const next = evolve(s, {
      type: 'CheckoutEntered',
      checkoutWorkflowId: 'demo.checkout.co-1',
      checkoutVersion: 1,
      at,
    });
    expect(next.cart.cartVersion).toBe(before);
  });

  it('stamps updatedAt from the event at and bumps cartVersion on every fold', () => {
    // Specimen changed from UserLinked (run -008 F-3: that fold now compensates the
    // bump, like CheckoutEntered — identity is not content). CartAbandoned is a real
    // content-lifecycle fold and keeps this pin about the DISPATCHER's generic stamping.
    const next = evolve(makeCtx(), {
      type: 'CartAbandoned',
      at: '2026-08-04T12:00:00.000Z',
    });
    expect(next.cart.updatedAt).toBe('2026-08-04T12:00:00.000Z');
    expect(next.cart.cartVersion).toBe(2); // makeCart starts at 1
    expect(next.cart.createdAt).toBe('2026-01-01T00:00:00Z');
  });

  it('never reads the clock — a far-past at lands verbatim', () => {
    const past = '1999-12-31T23:59:59.000Z';
    expect(evolve(makeCtx(), { type: 'CartAbandoned', at: past }).cart.updatedAt).toBe(past);
  });

  it('treats a missing version as 0', () => {
    const s0 = makeCtx({ cart: makeCart({ cartVersion: undefined as unknown as number }) });
    expect(evolve(s0, { type: 'CartAbandoned', at: 'T' }).cart.cartVersion).toBe(1);
  });
});

// ── The regression net the purity refactor buys: apply EVERY CartEvent type and prove the
// input context is untouched. The mapped-type table makes a missing event a compile-time
// hole; the length pin keeps the net growing with the union.
const eventSamples: { [E in CartEvent['type']]: Extract<CartEvent, { type: E }> } = {
  ItemAdded: {
    type: 'ItemAdded',
    variantId: 'v2',
    quantity: 2,
    price: 5,
    lineItemId: 'li-new',
    at: 'T',
  },
  ItemQuantityChanged: { type: 'ItemQuantityChanged', lineItemId: 'li-1', quantity: 3, at: 'T' },
  ItemRemoved: { type: 'ItemRemoved', lineItemId: 'li-1', at: 'T' },
  CouponApplied: { type: 'CouponApplied', code: 'SAVE20', at: 'T' },
  UserLinked: { type: 'UserLinked', email: 'a@b.c', userId: 'u-1', at: 'T' },
  CheckoutEntered: {
    type: 'CheckoutEntered',
    checkoutWorkflowId: 'c-1',
    checkoutVersion: 1,
    at: 'T',
  },
  CheckoutDisowned: { type: 'CheckoutDisowned', at: 'T' },
  CartAbandoned: { type: 'CartAbandoned', at: 'T' },
  CartCompleted: {
    type: 'CartCompleted',
    finalState: { step: 'complete', isGuest: true, shippingCost: 5, tax: 0.8 },
    at: 'T',
  },
  CheckoutFailed: { type: 'CheckoutFailed', error: 'declined', at: 'T' },
  SubmitFreezeStarted: { type: 'SubmitFreezeStarted', at: 'T' },
  SubmitFreezeCleared: { type: 'SubmitFreezeCleared', at: 'T' },
};

describe('evolve never mutates its input — every CartEvent type', () => {
  it('the table covers the whole event union', () => {
    expect(Object.keys(eventSamples)).toHaveLength(12);
  });

  it.each(Object.entries(eventSamples))('%s leaves the input context untouched', (_type, event) => {
    const s = makeCtx({ checkoutWorkflowId: 'c-0' });
    const snapshot = structuredClone(s);
    const next = evolve(s, event as CartEvent);
    expect(s).toEqual(snapshot);
    expect(next).not.toBe(s); // a NEW context every time — stamping alone rebuilds it
  });
});

// ── Per-command blocks: each command is packaged as ONE exported structure (guard /
// prepare / decide / evolve), so its pure fields are exercised directly here (prepare is
// I/O and is covered through the machine in states.test.ts with mocked activities).
describe('command blocks — one structure per command', () => {
  const editCommand = { type: 'addItem', variantId: 'v2', quantity: 1, price: 5 } as const;

  it('addItemBlock.guard refuses edits while submitting, passes otherwise', () => {
    expect(addItemBlock.guard!(makeCtx({ submitting: true }), editCommand)).toMatchObject({
      rejected: true,
      reason: expect.stringMatching(/being placed/i),
    });
    expect(addItemBlock.guard!(makeCtx(), editCommand)).toBeUndefined();
  });

  it('the edit blocks share ONE guard reference (notWhileSubmitting)', () => {
    expect(updateQuantityBlock.guard).toBe(addItemBlock.guard);
    expect(removeItemBlock.guard).toBe(addItemBlock.guard);
    expect(applyCouponBlock.guard).toBe(addItemBlock.guard);
  });

  it('beginCheckoutBlock.guard refuses an empty cart', () => {
    const empty = makeCtx({ cart: makeCart({ items: [] }) });
    expect(beginCheckoutBlock.guard!(empty, { type: 'beginCheckout' })).toMatchObject({
      rejected: true,
      reason: expect.stringMatching(/empty cart/i),
    });
    expect(beginCheckoutBlock.guard!(makeCtx(), { type: 'beginCheckout' })).toBeUndefined();
  });

  it('addItemBlock.decide emits ItemAdded from the enriched command', () => {
    expect(
      addItemBlock.decide(
        { type: 'addItem', variantId: 'v2', quantity: 2, price: 5, lineItemId: 'li-new', at },
        makeCtx(),
      ),
    ).toEqual([
      {
        type: 'ItemAdded',
        variantId: 'v2',
        quantity: 2,
        price: 5,
        properties: undefined,
        lineItemId: 'li-new',
        at,
      },
    ]);
  });

  it('addItemBlock.evolve.ItemAdded returns a NEW context with the line appended', () => {
    const s = makeCtx();
    const next = addItemBlock.evolve!.ItemAdded!(s, eventSamples.ItemAdded);
    expect(next).not.toBe(s);
    expect(next.cart.items.map((i) => i.lineItemId)).toEqual(['li-1', 'li-new']);
    expect(s.cart.items).toHaveLength(1); // input untouched
  });

  it('updateQuantityBlock.evolve.ItemQuantityChanged substitutes the one line and re-totals', () => {
    const s = makeCtx();
    const next = updateQuantityBlock.evolve!.ItemQuantityChanged!(s, {
      type: 'ItemQuantityChanged',
      lineItemId: 'li-1',
      quantity: 3,
      at,
    });
    expect(next.cart.items[0].quantity).toBe(3);
    expect(next.cart.subtotalPrice).toBe(30);
    expect(s.cart.items[0].quantity).toBe(1); // input untouched
  });

  it('updateQuantityBlock.evolve.ItemQuantityChanged on a missing line leaves the context as-is', () => {
    const s = makeCtx();
    const next = updateQuantityBlock.evolve!.ItemQuantityChanged!(s, {
      type: 'ItemQuantityChanged',
      lineItemId: 'nope',
      quantity: 3,
      at,
    });
    expect(next).toBe(s);
  });

  it('events shared by several commands reference ONE evolve function (assembly invariant)', () => {
    expect(removeItemBlock.evolve!.ItemRemoved).toBe(updateQuantityBlock.evolve!.ItemRemoved);
    expect(removeItemBlock.evolve!.CartAbandoned).toBe(updateQuantityBlock.evolve!.CartAbandoned);
    expect(expireCartBlock.evolve!.CartAbandoned).toBe(removeItemBlock.evolve!.CartAbandoned);
  });

  it('applyCouponBlock.evolve.CouponApplied appends the coupon immutably', () => {
    const s = makeCtx();
    const next = applyCouponBlock.evolve!.CouponApplied!(s, eventSamples.CouponApplied);
    expect(next.cart.appliedCoupons).toEqual(['SAVE20']);
    expect(s.cart.appliedCoupons).toEqual([]); // input untouched
  });

  it('linkUser / submit-freeze blocks write only their own fields, immutably', () => {
    const linked = linkUserBlock.evolve!.UserLinked!(makeCtx(), eventSamples.UserLinked).cart;
    expect(linked.email).toBe('a@b.c');
    expect(linked.userId).toBe('u-1');
    expect(
      submitStartedBlock.evolve!.SubmitFreezeStarted!(makeCtx(), eventSamples.SubmitFreezeStarted)
        .submitting,
    ).toBe(true);
    expect(
      submitAbortedBlock.evolve!.SubmitFreezeCleared!(
        makeCtx({ submitting: true }),
        eventSamples.SubmitFreezeCleared,
      ).submitting,
    ).toBe(false);
  });

  it('checkoutTimedOutBlock.evolve.CheckoutDisowned drops the checkout fields and the link', () => {
    const s = makeCtx({
      cart: makeCart({ status: 'checkout' }),
      checkoutWorkflowId: 'c-1',
    });
    const next = checkoutTimedOutBlock.evolve!.CheckoutDisowned!(s, eventSamples.CheckoutDisowned);
    expect(next.cart.status).toBe('active');
    expect(next.cart.checkout).toBeUndefined();
    expect(next.checkoutWorkflowId).toBeNull();
    expect(s.checkoutWorkflowId).toBe('c-1'); // input untouched
  });

  it('checkoutCompletedBlock.evolve.CheckoutFailed returns to active, drops the link, keeps the error', () => {
    const s = makeCtx({ checkoutWorkflowId: 'c-1' });
    const next = checkoutCompletedBlock.evolve!.CheckoutFailed!(s, eventSamples.CheckoutFailed);
    expect(next.cart.status).toBe('active');
    expect(next.cart.checkout?.error).toBe('declined');
    expect(next.checkoutWorkflowId).toBeNull();
    expect(s.checkoutWorkflowId).toBe('c-1'); // input untouched
  });
});

// ==================
// deriveRoutes (ADR-0026, ported from mono #253) — per-state route tables derived from
// block declarations. The laws are load-time: a violation cannot reach a worker.
// ==================

describe('deriveRoutes — the three laws', () => {
  it('shared routed events merge when every emitter declares the same destination', () => {
    // CartAbandoned is declared by three blocks; CheckoutEntered by one. Value-equal
    // duplicates are the premise: an event's destination is a machine-global fact.
    expect(
      deriveRoutes({
        updateQuantity: updateQuantityBlock,
        removeItem: removeItemBlock,
        expireCart: expireCartBlock,
        beginCheckout: beginCheckoutBlock,
      }),
    ).toEqual({ CartAbandoned: terminal('abandoned'), CheckoutEntered: 'checkout' });
  });

  it('derives the ACTUAL state tables equal to the old hand-written literals (port no-op proof)', () => {
    // The port's equivalence pin: what deriveRoutes produces for each state's real commands is
    // exactly what the deleted literal said. Kept permanently here (the mono deleted its
    // transitional equivalents at the flip; this one doubles as the port record).
    expect(
      deriveRoutes(
        {
          addItem: addItemBlock,
          updateQuantity: updateQuantityBlock,
          removeItem: removeItemBlock,
          applyCoupon: applyCouponBlock,
          linkUser: linkUserBlock,
          expireCart: expireCartBlock,
          beginCheckout: beginCheckoutBlock,
        },
        { '*': '__self' as never },
      ),
    ).toEqual({
      CheckoutEntered: 'checkout',
      CartAbandoned: terminal('abandoned'),
      '*': '__self',
    });
    expect(
      deriveRoutes(
        {
          addItem: addItemBlock,
          updateQuantity: updateQuantityBlock,
          removeItem: removeItemBlock,
          applyCoupon: applyCouponBlock,
          linkUser: linkUserBlock,
          beginCheckout: {},
          submitStarted: submitStartedBlock,
          submitAborted: submitAbortedBlock,
          checkoutCompleted: checkoutCompletedBlock,
          checkoutTimedOut: checkoutTimedOutBlock,
        },
        { '*': '__self' as never },
      ),
    ).toEqual({
      CheckoutDisowned: 'active',
      CheckoutFailed: 'active',
      CartCompleted: terminal('completed'),
      CartAbandoned: terminal('abandoned'),
      '*': '__self',
    });
  });

  it('throws when two blocks give one event different destinations', () => {
    expect(() =>
      deriveRoutes({
        a: { routes: { CheckoutEntered: 'checkout' } },
        b: { routes: { CheckoutEntered: 'active' } },
      }),
    ).toThrow(/two destinations in one state/);
  });

  it('throws when extras try to REDIRECT rather than weaken to SELF', () => {
    expect(() =>
      deriveRoutes({ beginCheckout: beginCheckoutBlock }, { CheckoutEntered: 'active' }),
    ).toThrow(/may only weaken to SELF/);
  });

  it('throws when a state with commands derives an empty table', () => {
    expect(() => deriveRoutes({ beginCheckout: {} })).toThrow(/empty route table/);
  });
});
