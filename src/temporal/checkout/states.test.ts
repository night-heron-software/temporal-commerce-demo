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
  createPaymentIntent,
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

/** Both prerequisites satisfied — ready to submit. */
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
  it('successful reservations move to collecting', async () => {
    const out = await CHECKOUT_STATES.validating.fn(makeCtx(), timeout);
    expect(out.next).toBe('collecting');
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

describe('collecting — setShipping / setPayment', () => {
  it('setShipping prices the order, creates the intent, and stays collecting', async () => {
    const out = await CHECKOUT_STATES.collecting.fn(
      makeCtx(),
      ev({ type: 'setShipping', shippingAddress: address }),
    );
    expect(out.next).toBe('collecting');
    expect(out.context.state.shippingAddress).toEqual(address);
    expect(out.context.state.clientSecret).toBe('cs_1');
    expect(out.context.totalPrice).toBeCloseTo(15.8);
  });

  it('setPayment is order-independent (records payment, stays collecting)', async () => {
    const out = await CHECKOUT_STATES.collecting.fn(
      makeCtx(),
      ev({ type: 'setPayment', paymentMethod: { type: 'mock', token: 'tok_1' } }),
    );
    expect(out.next).toBe('collecting');
    expect(out.context.state.paymentMethod?.token).toBe('tok_1');
  });

  it('a PaymentIntent init failure surfaces on the state and stays collecting', async () => {
    vi.mocked(createPaymentIntent).mockRejectedValueOnce(new Error('provider down'));
    const out = await CHECKOUT_STATES.collecting.fn(
      makeCtx(),
      ev({ type: 'setShipping', shippingAddress: address }),
    );
    expect(out.next).toBe('collecting');
    expect(out.error).toMatch(/unable to initialize payment/i);
    expect(out.context.state.error).toMatch(/unable to initialize payment/i);
    // Pricing still folded so the shopper sees the computed totals.
    expect(out.context.shippingCost).toBe(5);
  });
});

describe('collecting — submitOrder', () => {
  it('missing prerequisites are rejected without running the pipeline', async () => {
    const out = await CHECKOUT_STATES.collecting.fn(makeCtx(), ev({ type: 'submitOrder' }));
    expect(out.next).toBe('collecting');
    expect(out.error).toMatch(/shipping and payment required/i);
    expect(processPayment).not.toHaveBeenCalled();
  });

  it('happy path runs the saga and completes', async () => {
    const out = await CHECKOUT_STATES.collecting.fn(readyCtx(), ev({ type: 'submitOrder' }));
    expect(out.next).toBe(terminal('complete'));
    expect(out.context.state.order?.orderId).toBe('o-1');
    expect(startOrderManagementWorkflow).toHaveBeenCalled();
  });

  it('a stale reviewedCartVersion aborts with CART_CHANGED and un-freezes the cart', async () => {
    const signal = vi.fn();
    vi.mocked(getExternalWorkflowHandle).mockReturnValue({ signal, cancel: vi.fn() } as never);
    vi.mocked(queryCart).mockResolvedValueOnce({
      items: [],
      subtotalPrice: 10,
      totalDiscounts: 0,
      appliedCoupons: [],
      cartVersion: 7,
    } as never);
    const out = await CHECKOUT_STATES.collecting.fn(
      readyCtx(),
      ev({ type: 'submitOrder', reviewedCartVersion: 1 }),
    );
    expect(out.next).toBe('collecting');
    expect(out.error).toBe('CART_CHANGED');
    expect(processPayment).not.toHaveBeenCalled();
    expect(signal).toHaveBeenLastCalledWith(expect.anything(), { kind: 'submitAborted' });
  });

  it('payment failure stays collecting with the error', async () => {
    vi.mocked(processPayment).mockResolvedValueOnce(false as never);
    const out = await CHECKOUT_STATES.collecting.fn(readyCtx(), ev({ type: 'submitOrder' }));
    expect(out.next).toBe('collecting');
    expect(out.error).toMatch(/payment failed/i);
    // Demo divergence from mono: reservations are kept for a submit retry (they
    // expire via the inventory TTL), not released on payment failure.
    expect(releaseReservations).not.toHaveBeenCalled();
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

    const out = await CHECKOUT_STATES.collecting.fn(readyCtx(), ev({ type: 'submitOrder' }));
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

    const out = await CHECKOUT_STATES.collecting.fn(readyCtx(), ev({ type: 'submitOrder' }));
    expect(out.next).toBe('collecting');
    expect(signal).toHaveBeenCalledWith(expect.anything(), { kind: 'submitStarted' });
    expect(signal).toHaveBeenLastCalledWith(expect.anything(), { kind: 'submitAborted' });
  });
});

describe('collecting — recompute nudge (inbound signal from the cart)', () => {
  it('without an address folds contents and leaves pricing alone', async () => {
    vi.mocked(queryCart).mockResolvedValueOnce({
      items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 3, price: 10 }],
      subtotalPrice: 30,
      totalDiscounts: 0,
      appliedCoupons: [],
      cartVersion: 2,
    } as never);

    const out = await CHECKOUT_STATES.collecting.fn(makeCtx(), recompute);
    expect(out.next).toBe('collecting');
    expect(out.context.subtotalPrice).toBe(30);
    expect(out.context.cartVersion).toBe(2);
    expect(out.context.totalPrice).toBe(30);
  });

  it('with address + payment set re-prices and un-checks payment', async () => {
    vi.mocked(queryCart).mockResolvedValueOnce({
      items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 2, price: 10 }],
      subtotalPrice: 20,
      totalDiscounts: 0,
      appliedCoupons: [],
      cartVersion: 2,
    } as never);

    const out = await CHECKOUT_STATES.collecting.fn(readyCtx(), recompute);
    expect(out.next).toBe('collecting');
    expect(out.context.subtotalPrice).toBe(20);
    // Re-priced against the fresh subtotal; payment method un-checked.
    expect(out.context.totalPrice).toBeCloseTo(25.8);
    expect(out.context.state.paymentMethod).toBeUndefined();
  });
});

describe('collecting — cancel / timeout', () => {
  it('cancelCheckout releases reservations and terminates as cancelled', async () => {
    const out = await CHECKOUT_STATES.collecting.fn(readyCtx(), ev({ type: 'cancelCheckout' }));
    expect(out.next).toBe(terminal('cancelled'));
    expect(releaseReservations).toHaveBeenCalled();
    expect(out.context.reservations).toEqual([]);
  });

  it('the collecting 1h timeout cancels the checkout and releases reservations', async () => {
    const ctx = makeCtx({ reservations: [{ reservationId: 'r-1' } as never] });
    const out = await CHECKOUT_STATES.collecting.fn(ctx, timeout);
    expect(out.next).toBe(terminal('cancelled'));
    expect(releaseReservations).toHaveBeenCalled();
  });
});
