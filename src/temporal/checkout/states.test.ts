import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the workflow sandbox + activity I/O so the co-located machine states can be
// exercised as pure functions. `prepare` activities return controlled values; the
// decider's events + the route tables are what we assert.
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
  refundPayment: vi.fn(async () => true),
  createOrder: vi.fn(async () => ({ orderId: 'o-1', confirmationNumber: 'DEMO1234' })),
  createPaymentIntent: vi.fn(async () => ({ clientSecret: 'cs_1' })),
  sendConfirmationEmail: vi.fn(async () => undefined),
  startOrderManagementWorkflow: vi.fn(async () => 'demo.order.o-1'),
  releaseReservations: vi.fn(async () => undefined),
  confirmReservations: vi.fn(async () => ({ unavailable: [] })),
  renewReservationsForCheckout: vi.fn(async () => ({
    success: true,
    reservations: [{ reservationId: 'r-1' }],
  })),
}));

import {
  confirmReservations,
  createOrder,
  createPaymentIntent,
  processPayment,
  queryCart,
  refundPayment,
  releaseReservations,
  renewReservationsForCheckout,
  startOrderManagementWorkflow,
} from './activities';
import { getExternalWorkflowHandle } from '@temporalio/workflow';
import { CHECKOUT_STATES } from './states';
import { terminal } from '../framework';
import type { CheckoutCommand, CheckoutContext } from './types';

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
    paymentAttempt: 1,
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
const readyCtx = (overrides: Partial<CheckoutContext> = {}) =>
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
    ...overrides,
  });

const ev = (event: CheckoutCommand) => ({ kind: 'event' as const, event, timestamp: 't' });
// Signals arrive at the state fn already mapped to commands (toSignal in workflows.ts).
const sig = (result: CheckoutCommand) => ({ kind: 'signal' as const, result, timestamp: 't' });
const timeout = { kind: 'timeout' as const, timestamp: 't' };

beforeEach(() => vi.clearAllMocks());

describe('validating (transitional — the tick synthesizes validate)', () => {
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

  it('a shopper command in validating is REJECTED (state does not accept it)', async () => {
    const out = await CHECKOUT_STATES.validating.fn(
      makeCtx(),
      ev({ type: 'setPayment', paymentMethod: { type: 'mock', token: 'tok_1' } }),
    );
    expect(out.next).toBe('validating');
    expect(out.rejected).toBe(true); // no transition, no recording, no projection
    expect(out.error).toMatch(/does not accept/i);
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
    // ADR-0024: the error folds into state (ShippingFailed) — the caller reads it off
    // the response; this is not a rejection, so the pricing still lands.
    expect(out.rejected).toBeUndefined();
    expect(out.context.state.error).toMatch(/unable to initialize payment/i);
    // Pricing still folded so the shopper sees the computed totals.
    expect(out.context.shippingCost).toBe(5);
  });
});

describe('collecting — submitOrder', () => {
  it('missing prerequisites fold the error without running the pipeline', async () => {
    const out = await CHECKOUT_STATES.collecting.fn(makeCtx(), ev({ type: 'submitOrder' }));
    expect(out.next).toBe('collecting');
    expect(out.context.state.error).toMatch(/shipping and payment required/i);
    expect(processPayment).not.toHaveBeenCalled();
  });

  it('happy path runs the saga and completes', async () => {
    const out = await CHECKOUT_STATES.collecting.fn(readyCtx(), ev({ type: 'submitOrder' }));
    expect(out.next).toBe(terminal('complete'));
    expect(out.context.state.order?.orderId).toBe('o-1');
    expect(startOrderManagementWorkflow).toHaveBeenCalled();
    // All holds confirmed ({unavailable: []}) — nothing to refund.
    expect(confirmReservations).toHaveBeenCalledWith([{ reservationId: 'r-1' }]);
    expect(refundPayment).not.toHaveBeenCalled();
  });

  it('unavailable reservations after payment refund and fail the submit before any order (issue #34)', async () => {
    vi.mocked(confirmReservations).mockResolvedValueOnce({
      unavailable: [{ variantId: 'v1', reservationId: 'r-1' }],
    } as never);

    const out = await CHECKOUT_STATES.collecting.fn(readyCtx(), ev({ type: 'submitOrder' }));
    expect(out.next).toBe('collecting');
    expect(out.context.state.error).toMatch(/no longer available/i);
    expect(out.context.state.error).toMatch(/refunded/i);
    // The shopper is made whole for the full charged amount…
    expect(refundPayment).toHaveBeenCalledWith('tok_1', expect.any(Number), 'USD', 'cart-1');
    expect((vi.mocked(refundPayment).mock.calls[0] as unknown as [unknown, number])[1]).toBeCloseTo(
      15.8,
    );
    // …and no order exists, so nothing downstream can fulfill phantom inventory.
    expect(createOrder).not.toHaveBeenCalled();
    expect(startOrderManagementWorkflow).not.toHaveBeenCalled();
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
    expect(out.context.state.error).toBe('CART_CHANGED');
    expect(processPayment).not.toHaveBeenCalled();
    expect(signal).toHaveBeenLastCalledWith(expect.anything(), { kind: 'submitAborted' });
  });

  /**
   * The idempotency key, asserted as PROPERTIES plus one shape pin. Lineage: mono #241 /
   * `f42c3bda` keyed on the journey + the amount (`${cartId}-${totalPrice}`); rejected
   * 2026-08-18 — an amount is not an identity (a same-total basket swap aliased to one key),
   * the refund path left a "charged" key that a same-total retry deduped against, and
   * float-formatted money makes unstable key strings. The key is now a NONCE naming the
   * attempt: `${workflowId}-pay-${paymentAttempt}` — stable while the attempt is open (an
   * activity retry replays it; the gateway validates the amount against it, see
   * activities-impl.test.ts for the mismatch throw), consumed by the `SubmitRejected` fold
   * when an attempt settles (declined / refunded / never charged), retained when the
   * pipeline failed with a possible charge outstanding. Deliberate divergence from the mono,
   * ledgered in mono-sync-2026-08-17.md as a backport candidate.
   */
  const keyOfLastCharge = () => {
    const calls = vi.mocked(processPayment).mock.calls;
    return calls[calls.length - 1]?.[3];
  };

  it('the idempotency key names this checkout and the attempt ordinal — nothing else', async () => {
    await CHECKOUT_STATES.collecting.fn(readyCtx(), ev({ type: 'submitOrder' }));
    // workflowInfo() is mocked as demo.checkout.c-1; the context opens at attempt 1. The id
    // is used whole (never parsed), so the key is the workflow id plus the attempt.
    expect(keyOfLastCharge()).toBe('demo.checkout.c-1-pay-1');
  });

  it('the key does NOT move when cartVersion or the total moves — amount is a parameter, not identity', async () => {
    await CHECKOUT_STATES.collecting.fn(
      readyCtx(),
      ev({ type: 'submitOrder', reviewedCartVersion: 1 }),
    );
    const first = keyOfLastCharge();

    // A later fold at a moved version AND a moved total (shipping went to 25): with the
    // amount-bearing key this was a silently distinct charge; now the open attempt's key is
    // unchanged and amount drift is the GATEWAY's mismatch error to raise, not a new bill.
    vi.mocked(queryCart).mockResolvedValueOnce({
      items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 1, price: 10 }],
      subtotalPrice: 10,
      totalDiscounts: 0,
      appliedCoupons: [],
      cartVersion: 7,
    } as never);
    await CHECKOUT_STATES.collecting.fn(
      readyCtx({ cartVersion: 7, shippingCost: 25 }),
      ev({ type: 'submitOrder', reviewedCartVersion: 7 }),
    );
    expect(keyOfLastCharge()).toBe(first);
  });

  it('a settled rejection consumes the attempt — the next submit charges under a fresh key', async () => {
    // Declined payment: the charge is settled (nothing outstanding), so the fold bumps.
    vi.mocked(processPayment).mockResolvedValueOnce(false as never);
    const out = await CHECKOUT_STATES.collecting.fn(readyCtx(), ev({ type: 'submitOrder' }));
    expect(out.context.paymentAttempt).toBe(2);

    await CHECKOUT_STATES.collecting.fn(
      readyCtx({ paymentAttempt: out.context.paymentAttempt }),
      ev({ type: 'submitOrder' }),
    );
    expect(keyOfLastCharge()).toBe('demo.checkout.c-1-pay-2');
  });

  it('a pipeline crash after a possible charge RETAINS the attempt — a retry replays the key', async () => {
    // createOrder fails after processPayment may have charged: the charge state is
    // unknowable, so the fold must NOT bump — the retry replays the same key and the
    // gateway returns the first result instead of billing twice.
    vi.mocked(createOrder).mockRejectedValueOnce(new Error('boom'));
    const out = await CHECKOUT_STATES.collecting.fn(readyCtx(), ev({ type: 'submitOrder' }));
    expect(out.context.state.error).toMatch(/error occurred/i);
    expect(out.context.paymentAttempt).toBe(1);

    await CHECKOUT_STATES.collecting.fn(
      readyCtx({ paymentAttempt: out.context.paymentAttempt }),
      ev({ type: 'submitOrder' }),
    );
    expect(keyOfLastCharge()).toBe('demo.checkout.c-1-pay-1');
  });

  it('payment failure stays collecting with the error', async () => {
    vi.mocked(processPayment).mockResolvedValueOnce(false as never);
    const out = await CHECKOUT_STATES.collecting.fn(readyCtx(), ev({ type: 'submitOrder' }));
    expect(out.next).toBe('collecting');
    expect(out.context.state.error).toMatch(/payment failed/i);
    // Demo divergence from mono: reservations are kept for a submit retry (they
    // expire via the inventory TTL), not released on payment failure.
    expect(releaseReservations).not.toHaveBeenCalled();
    expect(out.context.reservations).toEqual([{ reservationId: 'r-1' }]);
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
    expect(
      (vi.mocked(processPayment).mock.calls[0] as unknown as [unknown, number])[1],
    ).toBeCloseTo(25.8);
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

  it('a missing parent cart does not block the submit (best-effort freeze)', async () => {
    // Demo divergence from mono: the freeze/thaw signals are try/caught — a parent
    // that already closed must not fail the order placement itself.
    vi.mocked(getExternalWorkflowHandle).mockReturnValue({
      signal: vi.fn(async () => {
        throw new Error('workflow not found');
      }),
      cancel: vi.fn(),
    } as never);

    const out = await CHECKOUT_STATES.collecting.fn(readyCtx(), ev({ type: 'submitOrder' }));
    expect(out.next).toBe(terminal('complete'));
    expect(out.context.state.order?.orderId).toBe('o-1');
  });
});

describe('collecting — recompute nudge (signal-mapped command from the cart)', () => {
  it('without an address folds contents and leaves pricing alone', async () => {
    vi.mocked(queryCart).mockResolvedValueOnce({
      items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 3, price: 10 }],
      subtotalPrice: 30,
      totalDiscounts: 0,
      appliedCoupons: [],
      cartVersion: 2,
    } as never);

    const out = await CHECKOUT_STATES.collecting.fn(
      makeCtx(),
      sig({ type: 'recompute', cartVersion: 2 }),
    );
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

    const out = await CHECKOUT_STATES.collecting.fn(
      readyCtx(),
      sig({ type: 'recompute', cartVersion: 2 }),
    );
    expect(out.next).toBe('collecting');
    expect(out.context.subtotalPrice).toBe(20);
    // Re-priced against the fresh subtotal; payment method un-checked.
    expect(out.context.totalPrice).toBeCloseTo(25.8);
    expect(out.context.state.paymentMethod).toBeUndefined();
  });
});

describe('collecting — cancel / timeout', () => {
  it('cancelCheckout releases reservations (Cancelled effect) and terminates as cancelled', async () => {
    const out = await CHECKOUT_STATES.collecting.fn(readyCtx(), ev({ type: 'cancelCheckout' }));
    expect(out.next).toBe(terminal('cancelled'));
    // The event carried the pre-fold reservations; the fold cleared the context's list.
    expect(releaseReservations).toHaveBeenCalledWith([{ reservationId: 'r-1' }]);
    expect(out.context.reservations).toEqual([]);
  });

  it('the collecting 1h timeout cancels the checkout and releases reservations', async () => {
    const ctx = makeCtx({ reservations: [{ reservationId: 'r-1' } as never] });
    const out = await CHECKOUT_STATES.collecting.fn(ctx, timeout);
    expect(out.next).toBe(terminal('cancelled'));
    expect(releaseReservations).toHaveBeenCalledWith([{ reservationId: 'r-1' }]);
  });

  it('cancel with no reservations schedules no release', async () => {
    const out = await CHECKOUT_STATES.collecting.fn(makeCtx(), ev({ type: 'cancelCheckout' }));
    expect(out.next).toBe(terminal('cancelled'));
    expect(releaseReservations).not.toHaveBeenCalled();
  });
});
