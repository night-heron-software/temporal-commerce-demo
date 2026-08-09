import { describe, it, expect } from 'vitest';

// Pure Functional Core: no Temporal sandbox, no activity mocks. All I/O is in the states'
// `prepare`; here `decide` is asserted on emitted events and `evolve` on the fold.
import { decide, evolve, checkoutDecider } from './checkout-decider';
import type { EnrichedCheckoutCommand } from './checkout-decider';
import type { CheckoutContext, Order, QueriedCart } from './types';

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
