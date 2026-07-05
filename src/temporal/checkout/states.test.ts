import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the workflow sandbox + activity I/O so the co-located `decide` logic can be
// exercised as pure functions. `prepare` activities return controlled values.
vi.mock('@temporalio/workflow', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  defineSignal: vi.fn((name: string) => ({ type: 'signal', name })),
  getExternalWorkflowHandle: vi.fn(() => ({ signal: vi.fn(), cancel: vi.fn() })),
  proxyActivities: vi.fn(() => ({ persistWorkflowTransitions: vi.fn(async () => undefined) })),
  workflowInfo: vi.fn(() => ({
    workflowId: 'demo.checkout.c-1',
    runId: 'run-1',
    searchAttributes: {},
    workflowType: 'checkoutWorkflow',
  })),
  condition: vi.fn(async () => true),
  uuid4: () => 'uuid-fixed',
}));

vi.mock('./activities', () => ({
  queryCart: vi.fn(async () => ({
    items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 1, price: 10 }],
    subtotalPrice: 10,
    totalDiscounts: 0,
    appliedCoupons: [],
    cartVersion: 1,
  })),
  calculateShipping: vi.fn(async () => 5),
  calculateTax: vi.fn(async () => 0.8),
  processPayment: vi.fn(async () => true),
  createOrder: vi.fn(async () => ({ orderId: 'o-1', confirmationNumber: 'DEMO1234' })),
  createPaymentIntent: vi.fn(async () => ({ clientSecret: 'cs_1' })),
  sendConfirmationEmail: vi.fn(async () => undefined),
  startOrderManagementWorkflow: vi.fn(async () => 'demo.order.o-1'),
  releaseReservations: vi.fn(async () => undefined),
  confirmReservations: vi.fn(async () => undefined),
  renewReservationsForCheckout: vi.fn(async () => ({
    success: true,
    reservations: [{ reservationId: 'r-1' }],
  })),
}));

import {
  processPayment,
  queryCart,
  releaseReservations,
  renewReservationsForCheckout,
  startOrderManagementWorkflow,
} from './activities';
import { getExternalWorkflowHandle } from '@temporalio/workflow';
import { CHECKOUT_STATES } from './states';
import { terminal } from '../framework';
import type { CheckoutContext, CheckoutInput } from './types';

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

const readyCtx = () =>
  makeCtx({
    reservations: [{ reservationId: 'r-1' } as never],
    state: {
      step: 'review',
      isGuest: true,
      shippingAddress: address,
      paymentMethod: { type: 'mock', token: 'tok_1' },
      shippingCost: 5,
      tax: 0.8,
    },
    shippingCost: 5,
    totalTax: 0.8,
    totalPrice: 15.8,
  });

const ev = (event: CheckoutInput) => ({ kind: 'event' as const, event, timestamp: 't' });
const timeout = { kind: 'timeout' as const, timestamp: 't' };
// The recompute nudge from the parent cart (items changed mid-checkout).
const recompute = { kind: 'signal' as const, result: { cartVersion: 2 }, timestamp: 't' };

beforeEach(() => vi.clearAllMocks());

describe('validating (transitional)', () => {
  it('successful reservations move to shipping', async () => {
    const out = await CHECKOUT_STATES.validating.fn(makeCtx(), timeout);
    expect(out.next).toBe('shipping');
    expect(out.context.reservations).toHaveLength(1);
    expect(renewReservationsForCheckout).toHaveBeenCalledWith('cart-1', expect.any(Array));
  });

  it('failed reservations terminate as failed', async () => {
    vi.mocked(renewReservationsForCheckout).mockResolvedValueOnce({
      success: false,
      reservations: [],
      error: 'out of stock',
    } as never);
    const out = await CHECKOUT_STATES.validating.fn(makeCtx(), timeout);
    expect(out.next).toBe(terminal('failed'));
    expect(out.context.state.error).toBe('out of stock');
  });
});

describe('shipping', () => {
  it('setShipping prices the order, creates the intent, and advances to payment', async () => {
    const out = await CHECKOUT_STATES.shipping.fn(
      makeCtx(),
      ev({ type: 'setShipping', shippingAddress: address }),
    );
    expect(out.next).toBe('payment');
    expect(out.context.state.clientSecret).toBe('cs_1');
    expect(out.context.totalPrice).toBeCloseTo(15.8);
  });

  it('setPayment is rejected before shipping is set', async () => {
    const out = await CHECKOUT_STATES.shipping.fn(
      makeCtx(),
      ev({ type: 'setPayment', paymentMethod: { type: 'mock', token: 'tok_1' } }),
    );
    expect(out.next).toBe('shipping');
    expect(out.error).toMatch(/Cannot 'setPayment' from state: shipping/);
  });

  it('timeout cancels the checkout and releases reservations', async () => {
    const ctx = makeCtx({ reservations: [{ reservationId: 'r-1' } as never] });
    const out = await CHECKOUT_STATES.shipping.fn(ctx, timeout);
    expect(out.next).toBe(terminal('cancelled'));
    expect(releaseReservations).toHaveBeenCalled();
  });
});

describe('payment', () => {
  const paidCtx = () =>
    makeCtx({
      state: {
        step: 'payment',
        isGuest: true,
        shippingAddress: address,
        shippingCost: 5,
        tax: 0.8,
      },
    });

  it('setPayment advances to review', async () => {
    const out = await CHECKOUT_STATES.payment.fn(
      paidCtx(),
      ev({ type: 'setPayment', paymentMethod: { type: 'mock', token: 'tok_1' } }),
    );
    expect(out.next).toBe('review');
    expect(out.context.state.paymentMethod?.token).toBe('tok_1');
  });

  it('setPayment without a shipping address is rejected', async () => {
    const out = await CHECKOUT_STATES.payment.fn(
      makeCtx(),
      ev({ type: 'setPayment', paymentMethod: { type: 'mock', token: 'tok_1' } }),
    );
    expect(out.next).toBe('payment');
    expect(out.error).toMatch(/shipping address required/i);
  });
});

describe('review — submitOrder', () => {
  it('runs the pipeline and completes the checkout', async () => {
    const out = await CHECKOUT_STATES.review.fn(readyCtx(), ev({ type: 'submitOrder' }));
    expect(out.next).toBe(terminal('complete'));
    expect(out.context.state.order?.orderId).toBe('o-1');
    expect(startOrderManagementWorkflow).toHaveBeenCalled();
  });

  it('payment failure returns to payment with the error', async () => {
    vi.mocked(processPayment).mockResolvedValueOnce(false as never);
    const out = await CHECKOUT_STATES.review.fn(readyCtx(), ev({ type: 'submitOrder' }));
    expect(out.next).toBe('payment');
    expect(out.error).toMatch(/payment failed/i);
  });

  it('missing prerequisites are rejected without running the pipeline', async () => {
    const ctx = makeCtx({ state: { step: 'review', isGuest: true, shippingCost: 0, tax: 0 } });
    const out = await CHECKOUT_STATES.review.fn(ctx, ev({ type: 'submitOrder' }));
    expect(out.next).toBe('review');
    expect(out.error).toMatch(/shipping and payment required/i);
    expect(processPayment).not.toHaveBeenCalled();
  });

  it('cancelCheckout from review releases reservations and terminates', async () => {
    const out = await CHECKOUT_STATES.review.fn(readyCtx(), ev({ type: 'cancelCheckout' }));
    expect(out.next).toBe(terminal('cancelled'));
    expect(releaseReservations).toHaveBeenCalled();
    expect(out.context.reservations).toEqual([]);
  });

  it('submitOrder freezes the cart, re-pulls contents, and prices the fresh totals', async () => {
    const signal = vi.fn();
    vi.mocked(getExternalWorkflowHandle).mockReturnValue({ signal, cancel: vi.fn() } as never);
    vi.mocked(queryCart).mockResolvedValueOnce({
      items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 2, price: 10 }],
      subtotalPrice: 20,
      totalDiscounts: 0,
      appliedCoupons: [],
      cartVersion: 3,
    } as never);

    const out = await CHECKOUT_STATES.review.fn(readyCtx(), ev({ type: 'submitOrder' }));
    expect(out.next).toBe(terminal('complete'));
    // Freeze phase announced to the parent; no abort on success.
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(expect.anything(), { kind: 'submitStarted' });
    // Pipeline priced against the re-pulled cart (20 + 5 shipping + 0.8 tax).
    expect(vi.mocked(processPayment).mock.calls[0][1]).toBeCloseTo(25.8);
  });

  it('submitOrder failure sends submitAborted so the cart thaws', async () => {
    const signal = vi.fn();
    vi.mocked(getExternalWorkflowHandle).mockReturnValue({ signal, cancel: vi.fn() } as never);
    vi.mocked(processPayment).mockResolvedValueOnce(false as never);

    const out = await CHECKOUT_STATES.review.fn(readyCtx(), ev({ type: 'submitOrder' }));
    expect(out.next).toBe('payment');
    expect(signal).toHaveBeenCalledWith(expect.anything(), { kind: 'submitStarted' });
    expect(signal).toHaveBeenLastCalledWith(expect.anything(), { kind: 'submitAborted' });
  });
});

describe('recompute nudge (inbound signal from the cart)', () => {
  it('in shipping (no address yet) folds contents and stays in shipping', async () => {
    const shippingCtx = makeCtx({
      state: { step: 'shipping', isGuest: true, shippingCost: 0, tax: 0 },
    });
    vi.mocked(queryCart).mockResolvedValueOnce({
      items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 3, price: 10 }],
      subtotalPrice: 30,
      totalDiscounts: 0,
      appliedCoupons: [],
      cartVersion: 2,
    } as never);

    const out = await CHECKOUT_STATES.shipping.fn(shippingCtx, recompute);
    expect(out.next).toBe('shipping');
    expect(out.context.subtotalPrice).toBe(30);
    expect(out.context.cartVersion).toBe(2);
    expect(out.context.totalPrice).toBe(30);
  });

  it('in review (address + payment set) re-prices and drops back to payment', async () => {
    vi.mocked(queryCart).mockResolvedValueOnce({
      items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 2, price: 10 }],
      subtotalPrice: 20,
      totalDiscounts: 0,
      appliedCoupons: [],
      cartVersion: 2,
    } as never);

    const out = await CHECKOUT_STATES.review.fn(readyCtx(), recompute);
    expect(out.next).toBe('payment');
    expect(out.context.subtotalPrice).toBe(20);
    // Re-priced against the fresh subtotal; payment method un-checked.
    expect(out.context.totalPrice).toBeCloseTo(25.8);
    expect(out.context.state.paymentMethod).toBeUndefined();
  });
});
