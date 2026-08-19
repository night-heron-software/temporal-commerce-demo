import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the workflow sandbox + activity I/O so the co-located machine states can be
// exercised as pure functions. `prepare` activities return controlled values; the
// decider's events + the route tables are what we assert.
vi.mock('@temporalio/workflow', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  defineSignal: vi.fn((name: string) => ({ name })),
  startChild: vi.fn(async () => ({ workflowId: 'checkout-child' })),
  ParentClosePolicy: { REQUEST_CANCEL: 'REQUEST_CANCEL' },
  uuid4: () => 'uuid-fixed',
  getExternalWorkflowHandle: vi.fn(() => ({ signal: vi.fn(), cancel: vi.fn() })),
  ApplicationFailure: {
    nonRetryable: (message: string, type: string) =>
      Object.assign(new Error(message), { type, nonRetryable: true }),
  },
  // Needed by the framework's transition-sink / identity resolver, which load with '../framework'.
  proxyActivities: vi.fn(() => ({ persistWorkflowTransitions: vi.fn(async () => undefined) })),
  workflowInfo: vi.fn(() => ({
    workflowId: 'demo.cart.cart-1',
    runId: 'run-1',
    // The journey correlationId minted at cart creation (ADR-0011) — beginCheckout
    // reads this Search Attribute and passes it to the checkout child.
    searchAttributes: { CorrelationId: ['corr-1'] },
    workflowType: 'cartWorkflow',
  })),
  condition: vi.fn(async () => true),
}));

vi.mock('./activities', () => ({
  reserveCartItem: vi.fn(async () => 'reservation-1'),
  releaseCartItem: vi.fn(async () => undefined),
  indexCart: vi.fn(async () => undefined),
  deleteCart: vi.fn(async () => undefined),
  validateInventory: vi.fn(async () => true),
}));

import { startChild, workflowInfo } from '@temporalio/workflow';
import { reserveCartItem, releaseCartItem } from './activities';
import { CART_STATES } from './states';
import { terminal } from '../framework';
import type {
  CartCommand,
  CartDetails,
  CartWorkflowContext,
  CheckoutWorkflowResult,
} from './types';

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

const ev = (event: CartCommand) => ({ kind: 'event' as const, event, timestamp: 't' });
// Signals arrive at the state fn already mapped to commands (toSignal in workflows.ts).
const sig = (result: CartCommand) => ({ kind: 'signal' as const, result, timestamp: 't' });
const timeout = { kind: 'timeout' as const, timestamp: 't' };

const okResult = (over: Partial<CheckoutWorkflowResult> = {}): CheckoutWorkflowResult => ({
  success: true,
  finalState: { step: 'complete', isGuest: true, shippingCost: 5, tax: 0.8 },
  order: { orderId: 'o-1' } as never,
  checkoutVersion: 0,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

// ── active: item lifecycle ────────────────────────────────────────────────────
describe('active — item lifecycle', () => {
  it('addItem re-reserves at the merged quantity and stays active', async () => {
    const out = await CART_STATES.active.fn(
      makeCtx(),
      ev({ type: 'addItem', variantId: 'v1', quantity: 2, price: 10 }),
    );
    expect(out.next).toBe('active');
    expect((out.response as CartDetails).items[0].quantity).toBe(3);
    expect(releaseCartItem).toHaveBeenCalledWith('cart-1', 'v1');
    expect(reserveCartItem).toHaveBeenCalledWith('cart-1', 'v1', 3);
  });

  it('addItem reservation failure REJECTS the edit (error, no transition) and rolls back', async () => {
    vi.mocked(reserveCartItem).mockResolvedValueOnce(null as never);
    const out = await CART_STATES.active.fn(
      makeCtx(),
      ev({ type: 'addItem', variantId: 'v1', quantity: 2, price: 10 }),
    );
    // prepare threw OutOfStockError → framework stays in-state and relays the error.
    expect(out.next).toBe('active');
    expect(out.error).toMatch(/insufficient inventory/i);
    expect(out.rejected).toBe(true); // no transition, no recording, no projection
    expect(out.context.cart.items[0].quantity).toBe(1);
    // Rollback re-reserve at the old quantity
    expect(reserveCartItem).toHaveBeenLastCalledWith('cart-1', 'v1', 1);
  });

  it('updateQuantity up re-reserves and stays active', async () => {
    const out = await CART_STATES.active.fn(
      makeCtx(),
      ev({ type: 'updateQuantity', lineItemId: 'li-1', quantity: 3 }),
    );
    expect(out.next).toBe('active');
    expect(out.context.cart.items[0].quantity).toBe(3);
    expect(reserveCartItem).toHaveBeenCalledWith('cart-1', 'v1', 3);
  });

  it('updateQuantity to 0 removes the last line and abandons the cart', async () => {
    const out = await CART_STATES.active.fn(
      makeCtx(),
      ev({ type: 'updateQuantity', lineItemId: 'li-1', quantity: 0 }),
    );
    expect(out.next).toBe(terminal('abandoned'));
    expect(out.context.cart.items).toHaveLength(0);
    expect(out.context.cart.status).toBe('abandoned');
    expect(releaseCartItem).toHaveBeenCalledWith('cart-1', 'v1');
  });

  it('removeItem of the last line abandons the cart', async () => {
    const out = await CART_STATES.active.fn(
      makeCtx(),
      ev({ type: 'removeItem', lineItemId: 'li-1' }),
    );
    expect(out.next).toBe(terminal('abandoned'));
    expect(releaseCartItem).toHaveBeenCalledWith('cart-1', 'v1');
  });

  it('removeItem of one of several lines stays active', async () => {
    const ctx = makeCtx({
      cart: makeCart({
        items: [
          { lineItemId: 'li-1', variantId: 'v1', quantity: 1, price: 10 },
          { lineItemId: 'li-2', variantId: 'v2', quantity: 1, price: 5 },
        ],
      }),
    });
    const out = await CART_STATES.active.fn(ctx, ev({ type: 'removeItem', lineItemId: 'li-1' }));
    expect(out.next).toBe('active');
    expect(out.context.cart.items.map((i) => i.variantId)).toEqual(['v2']);
  });

  it('linkUser sets email and userId', async () => {
    const out = await CART_STATES.active.fn(
      makeCtx(),
      ev({ type: 'linkUser', email: 'a@b.c', userId: 'user-9' }),
    );
    expect(out.next).toBe('active');
    expect(out.context.cart.userId).toBe('user-9');
    expect(out.context.cart.email).toBe('a@b.c');
  });

  it('idle timeout synthesizes expireCart and abandons the cart', async () => {
    const out = await CART_STATES.active.fn(makeCtx(), timeout);
    expect(out.next).toBe(terminal('abandoned'));
    expect(out.context.cart.status).toBe('abandoned');
  });

  it('a stale completion signal in active is REJECTED (state does not accept it)', async () => {
    const out = await CART_STATES.active.fn(
      makeCtx(),
      sig({ type: 'checkoutCompleted', result: okResult() }),
    );
    expect(out.next).toBe('active');
    expect(out.rejected).toBe(true);
    expect(out.context.cart.status).toBe('active');
  });
});

// ── active: beginCheckout ─────────────────────────────────────────────────────
describe('active — beginCheckout', () => {
  it('starts the checkout child, bumps version, transitions to checkout', async () => {
    const out = await CART_STATES.active.fn(
      makeCtx({ checkoutVersion: 2 }),
      ev({ type: 'beginCheckout' }),
    );
    expect(out.next).toBe('checkout');
    expect(out.context.checkoutVersion).toBe(3);
    // Structured, parseable checkout id; tagged for correlation (ADR-0011).
    expect(out.context.checkoutWorkflowId).toMatch(/^demo\.checkout\./);
    expect(out.context.cart.status).toBe('checkout');
    expect(out.context.cart.checkout?.step).toBe('validating');
    expect(startChild).toHaveBeenCalledWith(
      'checkoutWorkflow',
      expect.objectContaining({
        taskQueue: 'checkout-queue',
        searchAttributes: expect.objectContaining({
          CartId: ['cart-1'],
          // Read from the cart workflow's own CorrelationId Search Attribute — the
          // journey UUID minted at cart creation, no longer the cartId.
          CorrelationId: ['corr-1'],
        }),
      }),
    );
  });

  it('falls back to the cartId when the cart workflow itself is untagged', async () => {
    // A legacy/untagged cart roots the journey on its cartId rather than producing an
    // untagged child — an untagged child drops out of every CorrelationId visibility
    // query and ES journey sweep, orphaning the downstream projections.
    vi.mocked(workflowInfo).mockReturnValueOnce({
      workflowId: 'demo.cart.cart-1',
      runId: 'run-1',
      searchAttributes: {},
      workflowType: 'cartWorkflow',
    } as never);

    await CART_STATES.active.fn(makeCtx(), ev({ type: 'beginCheckout' }));

    const opts = (
      vi.mocked(startChild).mock.calls[0] as unknown as [
        unknown,
        { searchAttributes: Record<string, unknown> },
      ]
    )[1];
    expect(opts.searchAttributes).toMatchObject({
      CorrelationId: ['cart-1'],
      CartId: ['cart-1'],
    });
  });

  it('rejects checkout on an empty cart (no child started)', async () => {
    const ctx = makeCtx({ cart: makeCart({ items: [], subtotalPrice: 0 }) });
    const out = await CART_STATES.active.fn(ctx, ev({ type: 'beginCheckout' }));
    expect(out.next).toBe('active');
    expect(out.error).toMatch(/empty cart/i);
    expect(out.rejected).toBe(true); // guard fired before prepare
    expect(startChild).not.toHaveBeenCalled();
  });
});

// ── checkout: editable mid-checkout, submit freeze, completion signal ─────────
describe('checkout — editable mid-checkout + submit freeze + completion signal', () => {
  const inCheckout = (over: Partial<CartWorkflowContext> = {}) =>
    makeCtx({
      checkoutWorkflowId: 'checkout-child',
      checkoutVersion: 0,
      cart: makeCart({ status: 'checkout' }),
      ...over,
    });

  it('cart edits are ALLOWED while checkout is in progress (stays in checkout)', async () => {
    const out = await CART_STATES.checkout.fn(
      inCheckout(),
      ev({ type: 'addItem', variantId: 'v2', quantity: 1, price: 5 }),
    );
    expect(out.next).toBe('checkout');
    expect(out.error).toBeUndefined();
    expect(out.context.cart.items.map((i) => i.variantId)).toContain('v2');
    expect(reserveCartItem).toHaveBeenCalledWith('cart-1', 'v2', 1);
  });

  it('submitStarted freezes the cart: edits rejected without reservation writes', async () => {
    const frozen = await CART_STATES.checkout.fn(inCheckout(), sig({ type: 'submitStarted' }));
    expect(frozen.next).toBe('checkout');
    expect(frozen.context.submitting).toBe(true);

    const out = await CART_STATES.checkout.fn(
      frozen.context,
      ev({ type: 'addItem', variantId: 'v2', quantity: 1, price: 5 }),
    );
    expect(out.next).toBe('checkout');
    expect(out.error).toMatch(/being placed/i);
    expect(out.rejected).toBe(true);
    expect(out.context.cart.items.map((i) => i.variantId)).not.toContain('v2');
    expect(reserveCartItem).not.toHaveBeenCalled();
  });

  it('submitAborted clears the freeze: edits work again', async () => {
    const frozen = await CART_STATES.checkout.fn(inCheckout(), sig({ type: 'submitStarted' }));
    const thawed = await CART_STATES.checkout.fn(frozen.context, sig({ type: 'submitAborted' }));
    expect(thawed.context.submitting).toBe(false);

    const out = await CART_STATES.checkout.fn(
      thawed.context,
      ev({ type: 'updateQuantity', lineItemId: 'li-1', quantity: 4 }),
    );
    expect(out.next).toBe('checkout');
    expect(out.context.cart.items[0].quantity).toBe(4);
  });

  it('completed(success) terminates the cart as completed with final totals', async () => {
    const out = await CART_STATES.checkout.fn(
      inCheckout(),
      sig({ type: 'checkoutCompleted', result: okResult() }),
    );
    expect(out.next).toBe(terminal('completed'));
    expect(out.context.cart.status).toBe('completed');
    expect(out.context.cart.shippingCost).toBe(5);
    expect(out.context.cart.totalTax).toBe(0.8);
  });

  it('completed(failure) returns to active with the checkout link dropped', async () => {
    const out = await CART_STATES.checkout.fn(
      inCheckout(),
      sig({
        type: 'checkoutCompleted',
        result: okResult({ success: false, order: undefined, error: 'declined' }),
      }),
    );
    expect(out.next).toBe('active');
    expect(out.context.checkoutWorkflowId).toBeNull();
    expect(out.context.cart.status).toBe('active');
  });

  it('a stale checkoutVersion is ignored (no events → stays in checkout)', async () => {
    const out = await CART_STATES.checkout.fn(
      inCheckout({ checkoutVersion: 5 }),
      sig({ type: 'checkoutCompleted', result: okResult({ checkoutVersion: 2 }) }),
    );
    expect(out.next).toBe('checkout');
  });

  it('checkout-state timeout returns the cart to active (preserve, not abandon)', async () => {
    const out = await CART_STATES.checkout.fn(inCheckout(), timeout);
    expect(out.next).toBe('active');
    expect(out.context.cart.status).toBe('active');
    expect(out.context.checkoutWorkflowId).toBeNull();
  });
});
