import { describe, it, expect } from 'vitest';

// Pure Functional Core: no Temporal sandbox, no activity mocks. All I/O is in the blocks'
// `prepare`; here `decide` is asserted on emitted events and `evolve` on the fold.
// The per-command blocks are exported structures, so each command's decide / evolve
// entries are exercised directly in addition to the assembled dispatchers.
import {
  decide,
  evolve,
  checkoutDecider,
  validateBlock,
  setShippingBlock,
  setPaymentBlock,
  acknowledgeCartChangeBlock,
  retargetParentBlock,
  cancelCheckoutBlock,
  checkoutTimedOutBlock,
  submitOrderBlock,
  recomputeBlock,
} from './states';
import type { CheckoutEvent, EnrichedCheckoutCommand } from './states';
import type { CheckoutContext, CheckoutState, Order, QueriedCart } from './types';

const at = '2026-08-09T00:00:00.000Z';

function makeCtx(overrides: Partial<CheckoutContext> = {}): CheckoutContext {
  return {
    cartId: 'cart-1',
    parentCartWorkflowId: 'demo.cart.cart-1',
    items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 1, price: 10 }],
    subtotalPrice: 10,
    totalDiscounts: 0,
    currency: 'USD',
    appliedCoupons: [],
    isGuest: true,
    cartVersion: 1,
    checkoutVersion: 1,
    state: { step: 'validating', isGuest: true, shippingCost: 0, tax: 0 },
    reservations: [],
    shippingCost: 0,
    totalTax: 0,
    totalPrice: 10,
    ...overrides,
  };
}

const apply = (ctx: CheckoutContext, cmd: EnrichedCheckoutCommand): CheckoutContext =>
  decide(cmd, ctx).reduce(evolve, ctx);

const address = {
  firstName: 'A',
  lastName: 'B',
  address1: '1 Main St',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62701',
  country: 'US',
  email: 'a@b.c',
};

const order = { orderId: 'o-1', confirmationNumber: 'DEMO1234' } as Order;

const queriedCart = (overrides: Partial<QueriedCart> = {}): QueriedCart => ({
  items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 1, price: 10 }],
  subtotalPrice: 10,
  totalDiscounts: 0,
  appliedCoupons: [],
  cartVersion: 1,
  ...overrides,
});

// The fold never writes the UI `step` — the workflow derives it from prerequisites
// (deriveStep), so these tests assert the prerequisites themselves.
describe('checkout decide/evolve', () => {
  it('validate(success) → CartLoaded: stores reservations and folds the live cart', () => {
    const ctx = apply(makeCtx({ items: [], subtotalPrice: 0, totalPrice: 0 }), {
      type: 'validate',
      at,
      prepared: {
        success: true,
        reservations: [{ reservationId: 'r-1' } as never],
        cart: queriedCart(),
      },
    });
    expect(ctx.reservations).toHaveLength(1);
    // Live contents replace the empty seed (no snapshot in the input).
    expect(ctx.items).toHaveLength(1);
    expect(ctx.subtotalPrice).toBe(10);
    expect(ctx.totalPrice).toBe(10);
  });

  it('CartLoaded re-baselines cartVersionAtStart/Acknowledged to the PULLED version (R3)', () => {
    // The workflow-input snapshot predates the cart's CheckoutEntered version bump; if
    // the baseline stayed there, every fresh checkout would be born "changed" and the
    // cart-changed banner would show before any edit (backlog #3 false positive).
    const ctx = apply(
      makeCtx({
        items: [],
        state: { ...makeCtx().state, cartVersionAtStart: 1, cartVersionAcknowledged: 1 },
      }),
      {
        type: 'validate',
        at,
        prepared: { success: true, reservations: [], cart: queriedCart({ cartVersion: 2 }) },
      },
    );
    expect(ctx.cartVersion).toBe(2);
    expect(ctx.state.cartVersionAtStart).toBe(2);
    expect(ctx.state.cartVersionAcknowledged).toBe(2);
  });

  it('validate(failure) → ValidationFailed: records the reservation error', () => {
    const ctx = apply(makeCtx(), {
      type: 'validate',
      at,
      prepared: { success: false, reservations: [], error: 'out of stock', cart: queriedCart() },
    });
    expect(ctx.state.error).toBe('out of stock');
    expect(ctx.reservations).toEqual([]);
  });

  it('recompute → Recomputed: folds fresh contents, re-prices, and un-checks payment', () => {
    const priced = makeCtx({
      state: {
        step: 'review',
        isGuest: true,
        shippingCost: 5,
        tax: 0.8,
        shippingAddress: address,
        paymentMethod: { type: 'mock', token: 'tok_1' },
      },
      shippingCost: 5,
      totalTax: 0.8,
      totalPrice: 15.8,
    });
    const ctx = apply(priced, {
      type: 'recompute',
      at,
      prepared: {
        cart: queriedCart({
          items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 2, price: 10 }],
          subtotalPrice: 20,
          cartVersion: 2,
        }),
        shippingCost: 5,
        tax: 1.6,
      },
    });
    expect(ctx.subtotalPrice).toBe(20);
    expect(ctx.cartVersion).toBe(2);
    expect(ctx.totalTax).toBe(1.6);
    expect(ctx.totalPrice).toBeCloseTo(26.6);
    // Shopper must re-confirm payment against the new total.
    expect(ctx.state.paymentMethod).toBeUndefined();
  });

  it('recompute without re-pricing folds contents and keeps prior shipping/tax', () => {
    const ctx = apply(makeCtx(), {
      type: 'recompute',
      at,
      prepared: { cart: queriedCart({ subtotalPrice: 30, cartVersion: 3 }) },
    });
    expect(ctx.subtotalPrice).toBe(30);
    expect(ctx.cartVersion).toBe(3);
    // Falls back to the context's current pricing (0 before an address is set).
    expect(ctx.shippingCost).toBe(0);
    expect(ctx.totalPrice).toBe(30);
  });

  it('setShipping success → ShippingSet: prices the order and records the address', () => {
    const ctx = apply(makeCtx(), {
      type: 'setShipping',
      shippingAddress: address,
      at,
      prepared: { calculatedShipping: 5, calculatedTax: 0.8, clientSecret: 'cs_1' },
    });
    expect(ctx.state.shippingAddress).toEqual(address);
    expect(ctx.state.clientSecret).toBe('cs_1');
    expect(ctx.state.error).toBeUndefined();
    expect(ctx.shippingCost).toBe(5);
    expect(ctx.totalTax).toBe(0.8);
    expect(ctx.totalPrice).toBeCloseTo(15.8);
  });

  it('setShipping with a PaymentIntent failure → ShippingFailed: keeps pricing, records the error', () => {
    const ctx = apply(makeCtx(), {
      type: 'setShipping',
      shippingAddress: address,
      at,
      prepared: { calculatedShipping: 5, calculatedTax: 0.8, paymentIntentError: 'no payment' },
    });
    expect(ctx.state.error).toBe('no payment');
    expect(ctx.state.shippingAddress).toEqual(address);
    expect(ctx.shippingCost).toBe(5);
  });

  it('setPayment → PaymentSet: records the method and clears the error', () => {
    const ctx = apply(makeCtx(), {
      type: 'setPayment',
      paymentMethod: { type: 'mock', token: 'tok_1' },
      at,
    });
    expect(ctx.state.paymentMethod?.token).toBe('tok_1');
    expect(ctx.state.error).toBeUndefined();
  });

  it('submitOrder success → OrderSubmitted adopts newState; failure → SubmitRejected records the error', () => {
    const base = makeCtx();
    const ok = apply(base, {
      type: 'submitOrder',
      at,
      prepared: { success: true, order, newState: { ...base.state, order } },
    });
    expect(ok.state.order?.orderId).toBe('o-1');

    const fail = apply(makeCtx(), {
      type: 'submitOrder',
      at,
      prepared: { success: false, error: 'Payment failed. Please try again.' },
    });
    expect(fail.state.order).toBeUndefined();
    expect(fail.state.error).toMatch(/payment failed/i);
  });

  it('cancelCheckout → Cancelled carries the pre-fold reservations; the fold clears them', () => {
    const withHolds = makeCtx({ reservations: [{ reservationId: 'r-1' } as never] });
    // The decided reason distinguishes an explicit cancel from a timeout, and the event
    // carries the reservations so the release effect still knows them post-fold.
    expect(decide({ type: 'cancelCheckout', at }, withHolds)).toEqual([
      {
        type: 'Cancelled',
        reason: 'checkout-cancelled',
        reservations: [{ reservationId: 'r-1' }],
      },
    ]);
    expect(decide({ type: 'checkoutTimedOut', at }, withHolds)).toEqual([
      { type: 'Cancelled', reason: 'checkout-timeout', reservations: [{ reservationId: 'r-1' }] },
    ]);

    const ctx = apply(withHolds, { type: 'cancelCheckout', at });
    expect(ctx.reservations).toEqual([]);
    expect(ctx.state.error).toBeUndefined();
  });

  it('acknowledgeCartChange and retargetParent update the coordination fields', () => {
    const acked = apply(makeCtx(), { type: 'acknowledgeCartChange', cartVersion: 7, at });
    expect(acked.state.cartVersionAcknowledged).toBe(7);

    const retargeted = apply(makeCtx(), {
      type: 'retargetParent',
      newParentCartWorkflowId: 'demo.cart.other',
      at,
    });
    expect(retargeted.parentCartWorkflowId).toBe('demo.cart.other');
  });

  it('does not mutate the input context', () => {
    const ctx = makeCtx();
    const snap = structuredClone(ctx);
    apply(ctx, { type: 'setPayment', paymentMethod: { type: 'mock', token: 'tok_1' }, at });
    expect(ctx).toEqual(snap);
    expect(ctx.state.paymentMethod).toBeUndefined();
  });
});

describe('rebuilding state is a fold (decide → evolve)', () => {
  it('validate → set shipping → set payment → submit replays to a completed order', () => {
    let c = makeCtx({ items: [], subtotalPrice: 0, totalPrice: 0 });
    c = apply(c, {
      type: 'validate',
      at,
      prepared: {
        success: true,
        reservations: [{ reservationId: 'r-1' } as never],
        cart: queriedCart(),
      },
    });
    c = apply(c, {
      type: 'setShipping',
      shippingAddress: address,
      at,
      prepared: { calculatedShipping: 5, calculatedTax: 0.8, clientSecret: 'cs_1' },
    });
    c = apply(c, { type: 'setPayment', paymentMethod: { type: 'mock', token: 'tok_1' }, at });
    c = apply(c, {
      type: 'submitOrder',
      at,
      prepared: { success: true, order, newState: { ...c.state, order } },
    });
    expect(c.state.order).toBe(order);
    expect(c.totalPrice).toBeCloseTo(15.8);
  });
});

describe('checkoutDecider — the assembled decider', () => {
  it("has no isTerminal — terminality is the route tables' job (ADR-0024)", () => {
    expect('isTerminal' in checkoutDecider).toBe(false);
  });

  it('exposes decide and evolve', () => {
    expect(checkoutDecider.decide).toBe(decide);
    expect(checkoutDecider.evolve).toBe(evolve);
  });
});

// ── The regression net the block refactor keeps taut: apply EVERY CheckoutEvent type and
// prove the input context is untouched. The mapped-type table makes a missing event a
// compile-time hole; the length pin keeps the net growing with the union.
const eventSamples: { [E in CheckoutEvent['type']]: Extract<CheckoutEvent, { type: E }> } = {
  CartLoaded: {
    type: 'CartLoaded',
    cart: queriedCart(),
    reservations: [{ reservationId: 'r-1' } as never],
  },
  ValidationFailed: { type: 'ValidationFailed', error: 'gone' },
  ShippingSet: {
    type: 'ShippingSet',
    shippingAddress: address,
    shipping: 5,
    tax: 0.8,
    clientSecret: 'cs',
  },
  ShippingFailed: {
    type: 'ShippingFailed',
    shippingAddress: address,
    shipping: 5,
    tax: 0.8,
    error: 'nope',
  },
  PaymentSet: { type: 'PaymentSet', paymentMethod: { type: 'mock', token: 'tok' } },
  CartChangeAcknowledged: { type: 'CartChangeAcknowledged', cartVersion: 4 },
  ParentRetargeted: { type: 'ParentRetargeted', parentCartWorkflowId: 'demo.cart.other' },
  Cancelled: {
    type: 'Cancelled',
    reason: 'checkout-cancelled',
    reservations: [{ reservationId: 'r-1' } as never],
  },
  OrderSubmitted: { type: 'OrderSubmitted', newState: { isGuest: true } as CheckoutState },
  SubmitRejected: { type: 'SubmitRejected', error: 'declined' },
  Recomputed: { type: 'Recomputed', cart: queriedCart(), shipping: 5, tax: 0.8 },
};

describe('evolve never mutates its input — every CheckoutEvent type', () => {
  it('the table covers the whole event union', () => {
    expect(Object.keys(eventSamples)).toHaveLength(11);
  });

  it.each(Object.entries(eventSamples))('%s leaves the input context untouched', (_type, event) => {
    const c = makeCtx({
      reservations: [{ reservationId: 'r-0' } as never],
      state: { step: 'shipping', isGuest: true, shippingCost: 0, tax: 0, error: 'stale' },
    });
    const snap = structuredClone(c);
    evolve(c, event as CheckoutEvent);
    expect(c).toEqual(snap);
  });
});

// ── Per-command blocks: each command is packaged as ONE exported structure (guard /
// prepare / decide / evolve), so its pure fields are exercised directly here (prepare is
// I/O and is covered through the machine in states.test.ts with mocked activities).
describe('command blocks — one structure per command', () => {
  it('validateBlock.decide emits CartLoaded on success, ValidationFailed on failure', () => {
    expect(
      validateBlock.decide(
        {
          type: 'validate',
          prepared: { success: true, reservations: [], cart: queriedCart() },
          at,
        },
        makeCtx(),
      ),
    ).toEqual([{ type: 'CartLoaded', cart: queriedCart(), reservations: [] }]);
    expect(
      validateBlock.decide(
        {
          type: 'validate',
          prepared: { success: false, reservations: [], error: 'gone', cart: queriedCart() },
          at,
        },
        makeCtx(),
      ),
    ).toEqual([{ type: 'ValidationFailed', error: 'gone' }]);
  });

  it('validateBlock.evolve.CartLoaded returns a NEW context with pricing + reservations loaded', () => {
    const c = makeCtx({ items: [], subtotalPrice: 0, totalPrice: 0 });
    const next = validateBlock.evolve!.CartLoaded!(c, eventSamples.CartLoaded);
    expect(next).not.toBe(c);
    expect(next.subtotalPrice).toBe(10);
    expect(next.totalPrice).toBe(10);
    expect(next.reservations).toHaveLength(1);
    expect(c.items).toHaveLength(0); // input untouched
  });

  it('events shared by several commands reference ONE evolve function (assembly invariant)', () => {
    expect(checkoutTimedOutBlock.evolve!.Cancelled).toBe(cancelCheckoutBlock.evolve!.Cancelled);
  });

  it('setShippingBlock.decide falls back to the context clientSecret', () => {
    const c = makeCtx({
      state: { step: 'shipping', isGuest: true, shippingCost: 0, tax: 0, clientSecret: 'cs-old' },
    });
    expect(
      setShippingBlock.decide(
        {
          type: 'setShipping',
          shippingAddress: address,
          prepared: { calculatedShipping: 5, calculatedTax: 0.8 },
          at,
        },
        c,
      ),
    ).toEqual([
      {
        type: 'ShippingSet',
        shippingAddress: address,
        shipping: 5,
        tax: 0.8,
        clientSecret: 'cs-old',
      },
    ]);
  });

  it('setShippingBlock.evolve.ShippingFailed stores the address AND the error', () => {
    const next = setShippingBlock.evolve!.ShippingFailed!(makeCtx(), eventSamples.ShippingFailed);
    expect(next.state.shippingAddress).toEqual(address);
    expect(next.state.error).toBe('nope');
    expect(next.totalPrice).toBeCloseTo(10 - 0 + 5 + 0.8);
  });

  it('cancel blocks decide the reason and carry the pre-evolve reservations', () => {
    const withHolds = makeCtx({ reservations: [{ reservationId: 'r-1' } as never] });
    expect(cancelCheckoutBlock.decide({ type: 'cancelCheckout', at }, withHolds)).toEqual([
      { type: 'Cancelled', reason: 'checkout-cancelled', reservations: [{ reservationId: 'r-1' }] },
    ]);
    expect(checkoutTimedOutBlock.decide({ type: 'checkoutTimedOut', at }, withHolds)).toEqual([
      { type: 'Cancelled', reason: 'checkout-timeout', reservations: [{ reservationId: 'r-1' }] },
    ]);
  });

  it('cancel evolve clears the reservations immutably (the event still carries them)', () => {
    const withHolds = makeCtx({ reservations: [{ reservationId: 'r-1' } as never] });
    const next = cancelCheckoutBlock.evolve!.Cancelled!(withHolds, eventSamples.Cancelled);
    expect(next.reservations).toEqual([]);
    expect(withHolds.reservations).toHaveLength(1); // input untouched
  });

  it('setPayment / acknowledge / retarget blocks write only their own fields, immutably', () => {
    const paid = setPaymentBlock.evolve!.PaymentSet!(makeCtx(), eventSamples.PaymentSet);
    expect(paid.state.paymentMethod?.token).toBe('tok');
    const acked = acknowledgeCartChangeBlock.evolve!.CartChangeAcknowledged!(
      makeCtx(),
      eventSamples.CartChangeAcknowledged,
    );
    expect(acked.state.cartVersionAcknowledged).toBe(4);
    const retargeted = retargetParentBlock.evolve!.ParentRetargeted!(
      makeCtx(),
      eventSamples.ParentRetargeted,
    );
    expect(retargeted.parentCartWorkflowId).toBe('demo.cart.other');
  });

  it('submitOrderBlock.decide maps the prepared saga result to OrderSubmitted / SubmitRejected', () => {
    expect(
      submitOrderBlock.decide(
        {
          type: 'submitOrder',
          at,
          prepared: { success: true, order, newState: { isGuest: true } as CheckoutState },
        },
        makeCtx(),
      ),
    ).toEqual([{ type: 'OrderSubmitted', newState: { isGuest: true } }]);
    expect(
      submitOrderBlock.decide(
        { type: 'submitOrder', at, prepared: { success: false, error: 'declined' } },
        makeCtx(),
      ),
    ).toEqual([{ type: 'SubmitRejected', error: 'declined' }]);
  });

  it('recomputeBlock.evolve.Recomputed un-checks payment and re-totals immutably', () => {
    const priced = makeCtx({
      state: {
        step: 'review',
        isGuest: true,
        shippingCost: 5,
        tax: 0.8,
        paymentMethod: { type: 'mock', token: 'tok_1' },
      },
    });
    const next = recomputeBlock.evolve!.Recomputed!(priced, eventSamples.Recomputed);
    expect(next.state.paymentMethod).toBeUndefined();
    expect(next.totalPrice).toBeCloseTo(10 - 0 + 5 + 0.8);
    expect(priced.state.paymentMethod?.token).toBe('tok_1'); // input untouched
  });
});
