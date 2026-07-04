import { describe, it, expect } from 'vitest';
import { decide, evolve, cartDecider } from './cart-decider';
import type { CartCommand, CartFact } from './cart-decider';
import type { CartDetails, CartWorkflowContext, CheckoutWorkflowResult } from './types';

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

const apply = (ctx: CartWorkflowContext, cmd: CartCommand): CartWorkflowContext =>
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
    const facts = decide(
      { type: 'addItem', variantId: 'v2', quantity: 2, price: 5, lineItemId: 'li-new' },
      makeCtx(),
    );
    expect(facts).toEqual([
      { type: 'ItemAdded', variantId: 'v2', quantity: 2, price: 5, properties: undefined, lineItemId: 'li-new' },
    ]);
  });

  it('updateQuantity of an unknown line emits nothing', () => {
    expect(decide({ type: 'updateQuantity', lineItemId: 'nope', quantity: 2 }, makeCtx())).toEqual([]);
  });

  it('updateQuantity to 0 on the last line also abandons the cart', () => {
    const facts = decide({ type: 'updateQuantity', lineItemId: 'li-1', quantity: 0 }, makeCtx());
    expect(facts.map((f: CartFact) => f.type)).toEqual(['ItemRemoved', 'CartAbandoned']);
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
    const facts = decide({ type: 'removeItem', lineItemId: 'li-1' }, ctx);
    expect(facts.map((f) => f.type)).toEqual(['ItemRemoved']);
  });

  it('applyCoupon deduplicates', () => {
    const ctx = makeCtx({ cart: makeCart({ appliedCoupons: ['SAVE20'] }) });
    expect(decide({ type: 'applyCoupon', code: 'SAVE20' }, ctx)).toEqual([]);
  });

  it('beginCheckout bumps the checkout version', () => {
    const facts = decide(
      { type: 'beginCheckout', checkoutWorkflowId: 'demo.checkout.x' },
      makeCtx({ checkoutVersion: 2 }),
    );
    expect(facts).toEqual([
      { type: 'CheckoutEntered', checkoutWorkflowId: 'demo.checkout.x', checkoutVersion: 3 },
    ]);
  });

  it('checkoutCompleted with a stale version emits nothing', () => {
    const facts = decide(
      { type: 'checkoutCompleted', result: okResult({ checkoutVersion: 1 }) },
      makeCtx({ checkoutVersion: 5 }),
    );
    expect(facts).toEqual([]);
  });

  it('checkoutCompleted success emits CartCompleted; failure emits CheckoutFailed with the error', () => {
    expect(decide({ type: 'checkoutCompleted', result: okResult() }, makeCtx()).map((f) => f.type)).toEqual([
      'CartCompleted',
    ]);
    expect(
      decide(
        { type: 'checkoutCompleted', result: okResult({ success: false, order: undefined, error: 'declined' }) },
        makeCtx(),
      ),
    ).toEqual([{ type: 'CheckoutFailed', error: 'declined' }]);
  });

  it('submitStarted / submitAborted drive the freeze facts', () => {
    expect(decide({ type: 'submitStarted' }, makeCtx())).toEqual([{ type: 'SubmitFreezeStarted' }]);
    expect(decide({ type: 'submitAborted' }, makeCtx())).toEqual([{ type: 'SubmitFreezeCleared' }]);
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
    });
    expect(ctx.cart.items.map((i) => i.variantId)).toEqual(['v1', 'v2']);
    expect(ctx.cart.subtotalPrice).toBe(15);
  });

  it('does not mutate the input state', () => {
    const ctx = makeCtx();
    apply(ctx, { type: 'removeItem', lineItemId: 'li-1' });
    expect(ctx.cart.items).toHaveLength(1);
    expect(ctx.cart.status).toBe('active');
  });

  it('CouponApplied recalculates SAVE20 discount and tax', () => {
    const ctx = apply(makeCtx(), { type: 'applyCoupon', code: 'SAVE20' });
    expect(ctx.cart.appliedCoupons).toEqual(['SAVE20']);
    expect(ctx.cart.totalDiscounts).toBe(2); // 20% of 10
    expect(ctx.cart.totalTax).toBeCloseTo(0.64); // 8% of 8
  });

  it('UserLinked sets email and userId', () => {
    const ctx = apply(makeCtx(), { type: 'linkUser', email: 'a@b.c', userId: 'u-1' });
    expect(ctx.cart.email).toBe('a@b.c');
    expect(ctx.cart.userId).toBe('u-1');
  });

  it('CheckoutEntered sets checkout fields and the link', () => {
    const ctx = apply(makeCtx({ checkoutVersion: 1 }), {
      type: 'beginCheckout',
      checkoutWorkflowId: 'demo.checkout.y',
    });
    expect(ctx.cart.status).toBe('checkout');
    expect(ctx.cart.checkout?.step).toBe('validating');
    expect(ctx.checkoutWorkflowId).toBe('demo.checkout.y');
    expect(ctx.checkoutVersion).toBe(2);
  });

  it('CheckoutFailed returns the cart to active, keeps the failure visible, drops the link', () => {
    const inCheckout = apply(makeCtx(), { type: 'beginCheckout', checkoutWorkflowId: 'x' });
    const ctx = apply(inCheckout, {
      type: 'checkoutCompleted',
      // checkoutVersion 1 matches the version beginCheckout just bumped to (0 → 1).
      result: okResult({ success: false, order: undefined, error: 'declined', checkoutVersion: 1 }),
    });
    expect(ctx.cart.status).toBe('active');
    expect(ctx.cart.checkout?.step).toBe('failed');
    expect(ctx.cart.checkout?.error).toBe('declined');
    expect(ctx.checkoutWorkflowId).toBeNull();
  });

  it('CheckoutDisowned (disownCheckout) clears the checkout fields entirely', () => {
    const inCheckout = apply(makeCtx(), { type: 'beginCheckout', checkoutWorkflowId: 'x' });
    const ctx = apply(inCheckout, { type: 'disownCheckout' });
    expect(ctx.cart.status).toBe('active');
    expect(ctx.cart.checkout).toBeUndefined();
    expect(ctx.checkoutWorkflowId).toBeNull();
  });

  it('CartCompleted folds the final checkout state into totals', () => {
    const inCheckout = apply(makeCtx(), { type: 'beginCheckout', checkoutWorkflowId: 'x' });
    const ctx = apply(inCheckout, { type: 'checkoutCompleted', result: okResult({ checkoutVersion: 1 }) });
    expect(ctx.cart.status).toBe('completed');
    expect(ctx.cart.shippingCost).toBe(5);
    expect(ctx.cart.totalTax).toBe(0.8);
    expect(ctx.cart.totalPrice).toBeCloseTo(10 - 0 + 5 + 0.8);
  });
});

// ── decider shape ───────────────────────────────────────────────────────────
describe('cartDecider', () => {
  it('isTerminal is true only for completed/abandoned', () => {
    expect(cartDecider.isTerminal(makeCtx())).toBe(false);
    expect(cartDecider.isTerminal(makeCtx({ cart: makeCart({ status: 'completed' }) }))).toBe(true);
    expect(cartDecider.isTerminal(makeCtx({ cart: makeCart({ status: 'abandoned' }) }))).toBe(true);
  });
});
