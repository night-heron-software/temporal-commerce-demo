import { describe, it, expect } from 'vitest';
import { decide, evolve } from './checkout-decider';
import type { CheckoutCommand } from './checkout-decider';
import type { CheckoutContext, Order, QueriedCart } from './types';

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

const apply = (ctx: CheckoutContext, cmd: CheckoutCommand): CheckoutContext =>
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
  it('validated(success) → CartLoaded: stores reservations and folds the live cart', () => {
    const ctx = apply(makeCtx({ items: [], subtotalPrice: 0, totalPrice: 0 }), {
      type: 'validated',
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

  it('validated(failure) → ValidationFailed: records the reservation error', () => {
    const ctx = apply(makeCtx(), {
      type: 'validated',
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
    });
    expect(ctx.state.paymentMethod?.token).toBe('tok_1');
    expect(ctx.state.error).toBeUndefined();
  });

  it('submitOrder success → OrderSubmitted adopts newState; failure → SubmitRejected records the error', () => {
    const base = makeCtx();
    const ok = apply(base, {
      type: 'submitOrder',
      prepared: { success: true, order, newState: { ...base.state, order } },
    });
    expect(ok.state.order?.orderId).toBe('o-1');

    const fail = apply(makeCtx(), {
      type: 'submitOrder',
      prepared: { success: false, error: 'Payment failed. Please try again.' },
    });
    expect(fail.state.order).toBeUndefined();
    expect(fail.state.error).toMatch(/payment failed/i);
  });

  it('cancelCheckout → Cancelled: clears reservations and the error', () => {
    const ctx = apply(makeCtx({ reservations: [{ reservationId: 'r-1' } as never] }), {
      type: 'cancelCheckout',
    });
    expect(ctx.reservations).toEqual([]);
    expect(ctx.state.error).toBeUndefined();
  });

  it('acknowledgeCartChange and retargetParent update the coordination fields', () => {
    const acked = apply(makeCtx(), { type: 'acknowledgeCartChange', cartVersion: 7 });
    expect(acked.state.cartVersionAcknowledged).toBe(7);

    const retargeted = apply(makeCtx(), {
      type: 'retargetParent',
      newParentCartWorkflowId: 'demo.cart.other',
    });
    expect(retargeted.parentCartWorkflowId).toBe('demo.cart.other');
  });

  it('does not mutate the input context', () => {
    const ctx = makeCtx();
    apply(ctx, { type: 'setPayment', paymentMethod: { type: 'mock', token: 'tok_1' } });
    expect(ctx.state.paymentMethod).toBeUndefined();
  });
});
