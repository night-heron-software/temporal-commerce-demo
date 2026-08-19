/**
 * Unit tests for shop cart Server Actions: cookie-backed cart identity, the
 * updateWithStart lazy-create path, tolerated update failures (workflow gone /
 * already completed → null), the setShippingAddress dead-checkout recovery flow,
 * and the submitOrder cookie cleanup. Temporal client, next/headers, and the R1
 * variant-display resolver (an Elasticsearch lookup) are mocked.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.hoisted runs before static imports, so the helper must be imported dynamically here.
const cookieStore = await vi.hoisted(async () => {
  const { createCookieStoreMock } = await import('../../test-support/next-route');
  return createCookieStoreMock();
});
const workflow = vi.hoisted(() => ({
  getHandle: vi.fn(),
  executeUpdateWithStart: vi.fn(),
}));
// addItemToCart resolves the R1 display snapshot via Elasticsearch — mocked so the
// suite stays runnable with zero containers (a real client hangs past the test timeout).
const resolveVariantDisplay = vi.hoisted(() => vi.fn());
// The signed-in shopper lookup (two Cassandra reads) — mocked so the suite stays container-free.
const getSignedInShopper = vi.hoisted(() => vi.fn());
interface StartOp {
  workflowType: string;
  options: Record<string, unknown>;
}
const startOps = vi.hoisted(() => [] as StartOp[]);

vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));
vi.mock('@/lib/temporal-client', () => ({
  getTemporalClient: async () => ({ workflow }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/variant-display', () => ({ resolveVariantDisplay }));
vi.mock('@/lib/shopper-session', () => ({ getSignedInShopper }));
// cart-actions dynamically imports WithStartWorkflowOperation for the lazy-create path.
vi.mock('@temporalio/client', () => ({
  // Capture the constructed instances so tests can assert both the options the
  // action built and that the SAME instance was handed to executeUpdateWithStart.
  WithStartWorkflowOperation: class {
    constructor(
      public workflowType: string,
      public options: Record<string, unknown>,
    ) {
      startOps.push(this as unknown as StartOp);
    }
  },
}));

import {
  getOrCreateCartId,
  getCartId,
  getCart,
  addItemToCart,
  removeFromCart,
  executeCartUpdate,
  setShippingAddress,
  submitOrder,
} from './cart-actions';
import { Cart, Checkout } from '@/temporal/contracts';
import { buildWorkflowId } from '@/temporal/contracts/constants';

const CART_ID = 'c0ffee00-0000-4000-8000-000000000001';
const CART_WF_ID = buildWorkflowId('demo', 'cart', CART_ID);

interface HandleMock {
  query: ReturnType<typeof vi.fn>;
  executeUpdate: ReturnType<typeof vi.fn>;
}

/** Route getHandle through a per-workflowId registry of handle mocks. */
function installHandles(): Record<string, HandleMock> {
  const handles: Record<string, HandleMock> = {};
  workflow.getHandle.mockImplementation((workflowId: string) => {
    handles[workflowId] ??= { query: vi.fn(), executeUpdate: vi.fn() };
    return handles[workflowId];
  });
  return handles;
}

function workflowNotFound() {
  return Object.assign(new Error('workflow not found'), { name: 'WorkflowNotFoundError' });
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieStore.reset();
  startOps.length = 0;
});

describe('cart id cookie', () => {
  it('mints a UUID cart id and stores it in an httpOnly cookie when none exists', async () => {
    const cartId = await getOrCreateCartId();

    expect(cartId).toMatch(/^[0-9a-f-]{36}$/);
    expect(cookieStore.get('cartId')?.value).toBe(cartId);
    expect(cookieStore.setOptions.get('cartId')).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
  });

  it('reuses an existing cookie and getCartId returns null when absent', async () => {
    expect(await getCartId()).toBeNull();

    cookieStore.set('cartId', CART_ID);
    expect(await getOrCreateCartId()).toBe(CART_ID);
    expect(await getCartId()).toBe(CART_ID);
  });
});

describe('getCart', () => {
  it('queries the cart workflow, returning null when the workflow does not exist', async () => {
    const handles = installHandles();
    const details = { cartId: CART_ID, status: 'active', items: [] };
    workflow.getHandle(CART_WF_ID); // materialize the handle mock
    handles[CART_WF_ID].query
      .mockResolvedValueOnce(details)
      .mockRejectedValueOnce(workflowNotFound());

    expect(await getCart(CART_ID)).toEqual(details);
    expect(handles[CART_WF_ID].query).toHaveBeenCalledWith(Cart.getCartQuery);
    expect(await getCart(CART_ID)).toBeNull();
  });
});

// ── A cart created AFTER sign-in must still belong to the shopper (#11 / run -008 F-5) ──
// Linking used to live only in the login route, which links whatever cart exists AT sign-in,
// so a cart minted later stayed a guest cart: order history still worked (it queries by the
// address email) but cart RECOVERY at the next sign-in silently failed, because that query
// matches the cart doc's `email`.
describe('addItemToCart — shopper linking (#11)', () => {
  const details = (over: Record<string, unknown> = {}) => ({
    cartId: CART_ID,
    status: 'active',
    ...over,
  });

  it('links the signed-in shopper to a cart that has no user yet', async () => {
    const handles = installHandles();
    workflow.executeUpdateWithStart.mockResolvedValue(details());
    workflow.getHandle(CART_WF_ID);
    handles[CART_WF_ID].executeUpdate.mockResolvedValue(
      details({ userId: 'shopper-1', email: 'ada@example.com' }),
    );
    getSignedInShopper.mockResolvedValue({ id: 'shopper-1', email: 'ada@example.com' });

    const result = await addItemToCart(CART_ID, 'var-1', 1, 1999);

    expect(handles[CART_WF_ID].executeUpdate).toHaveBeenCalledWith(Cart.cartUpdate, {
      args: [{ type: 'linkUser', email: 'ada@example.com', userId: 'shopper-1' }],
    });
    expect(result).toMatchObject({ userId: 'shopper-1', email: 'ada@example.com' });
  });

  it('leaves a genuine guest cart alone', async () => {
    const handles = installHandles();
    workflow.executeUpdateWithStart.mockResolvedValue(details());
    workflow.getHandle(CART_WF_ID);
    getSignedInShopper.mockResolvedValue(null);

    await addItemToCart(CART_ID, 'var-1', 1, 1999);

    expect(handles[CART_WF_ID].executeUpdate).not.toHaveBeenCalled();
  });

  it('does not re-link an already-linked cart — and does not even look up the session', async () => {
    // The lookup is two Cassandra reads; short-circuiting before it keeps every subsequent
    // add-to-cart as cheap as it was.
    const handles = installHandles();
    workflow.executeUpdateWithStart.mockResolvedValue(details({ userId: 'shopper-1' }));
    workflow.getHandle(CART_WF_ID);

    await addItemToCart(CART_ID, 'var-1', 1, 1999);

    expect(getSignedInShopper).not.toHaveBeenCalled();
    expect(handles[CART_WF_ID].executeUpdate).not.toHaveBeenCalled();
  });

  it('still returns the added cart when linking fails — the item is not lost', async () => {
    const handles = installHandles();
    const added = details();
    workflow.executeUpdateWithStart.mockResolvedValue(added);
    workflow.getHandle(CART_WF_ID);
    handles[CART_WF_ID].executeUpdate.mockRejectedValue(workflowNotFound());
    getSignedInShopper.mockResolvedValue({ id: 'shopper-1', email: 'ada@example.com' });

    expect(await addItemToCart(CART_ID, 'var-1', 1, 1999)).toEqual(added);
  });
});

describe('addItemToCart (updateWithStart lazy create)', () => {
  it('starts the cart workflow with USE_EXISTING and executes the addItem update', async () => {
    const details = { cartId: CART_ID, status: 'active' };
    workflow.executeUpdateWithStart.mockResolvedValue(details);
    // R1: the resolved display snapshot spreads into the addItem command.
    const snapshot = {
      productId: 'prod-1',
      productTitle: 'Classic Tee [Simulated]',
      variantTitle: 'Baby Blue / 4XL',
      optionLabels: ['Baby Blue', '4XL'],
      thumbnailUrl: 'https://cdn.example/front.png',
    };
    resolveVariantDisplay.mockResolvedValue(snapshot);

    const result = await addItemToCart(CART_ID, 'var-1', 2, 19.99);

    expect(result).toEqual(details);
    expect(startOps).toHaveLength(1);
    expect(startOps[0].workflowType).toBe('cartWorkflow');
    expect(startOps[0].options).toMatchObject({
      workflowId: CART_WF_ID,
      taskQueue: 'cart-queue',
      workflowIdConflictPolicy: 'USE_EXISTING',
      args: [{ cartId: CART_ID }],
      // R5 (ADR-0022 one-lifecycle-id): the correlationId IS the cartId — one query
      // returns everything this cart ever did, across every run and checkout.
      searchAttributes: expect.objectContaining({
        CorrelationId: [CART_ID],
        CartId: [CART_ID],
      }),
    });
    expect(workflow.executeUpdateWithStart).toHaveBeenCalledWith(Cart.cartUpdate, {
      startWorkflowOperation: startOps[0],
      args: [{ type: 'addItem', variantId: 'var-1', quantity: 2, price: 19.99, ...snapshot }],
    });
  });

  it('adds the line without a snapshot when display resolution returns null', async () => {
    const details = { cartId: CART_ID, status: 'active' };
    workflow.executeUpdateWithStart.mockResolvedValue(details);
    resolveVariantDisplay.mockResolvedValue(null);

    await addItemToCart(CART_ID, 'var-1', 1, 9.99);

    expect(workflow.executeUpdateWithStart).toHaveBeenCalledWith(Cart.cartUpdate, {
      startWorkflowOperation: startOps[0],
      args: [{ type: 'addItem', variantId: 'var-1', quantity: 1, price: 9.99 }],
    });
  });
});

describe('executeCartUpdate error tolerance', () => {
  it('returns null when the workflow is gone or already completed, and rethrows anything else', async () => {
    const handles = installHandles();
    workflow.getHandle(CART_WF_ID);
    handles[CART_WF_ID].executeUpdate
      .mockRejectedValueOnce(workflowNotFound())
      .mockRejectedValueOnce(
        Object.assign(new Error('update after close'), {
          cause: { type: 'AcceptedUpdateCompletedWorkflow' },
        }),
      )
      .mockRejectedValueOnce(new Error('connection refused'));

    expect(await removeFromCart(CART_ID, 'li-1')).toBeNull();
    expect(
      await executeCartUpdate(CART_ID, Cart.cartUpdate, [{ type: 'beginCheckout' }]),
    ).toBeNull();
    await expect(
      executeCartUpdate(CART_ID, Cart.cartUpdate, [{ type: 'beginCheckout' }]),
    ).rejects.toThrow('connection refused');

    expect(handles[CART_WF_ID].executeUpdate).toHaveBeenNthCalledWith(1, Cart.cartUpdate, {
      args: [{ type: 'removeItem', lineItemId: 'li-1' }],
    });
  });
});

describe('setShippingAddress', () => {
  const address = { firstName: 'Ada' } as never;

  it('sends the update to the current checkout workflow', async () => {
    const handles = installHandles();
    workflow.getHandle(CART_WF_ID);
    handles[CART_WF_ID].query.mockResolvedValue('ck-1');
    workflow.getHandle('ck-1');
    const state = { step: 'payment' };
    handles['ck-1'].executeUpdate.mockResolvedValue(state);

    const result = await setShippingAddress(CART_ID, address);

    expect(result).toEqual(state);
    expect(handles['ck-1'].executeUpdate).toHaveBeenCalledWith(Checkout.setShippingUpdate, {
      args: [{ shippingAddress: address }],
    });
  });

  it('recovers from a dead checkout by starting a fresh one and retrying the update', async () => {
    const handles = installHandles();
    workflow.getHandle(CART_WF_ID);
    // Checkout id resolves to the dead ck-old first, then ck-new after recovery.
    handles[CART_WF_ID].query.mockResolvedValueOnce('ck-old').mockResolvedValueOnce('ck-new');
    workflow.getHandle('ck-old');
    handles['ck-old'].executeUpdate.mockRejectedValue(workflowNotFound());
    workflow.getHandle('ck-new');
    const state = { step: 'payment' };
    handles['ck-new'].executeUpdate.mockResolvedValue(state);

    const result = await setShippingAddress(CART_ID, address);

    expect(result).toEqual(state);
    // Recovery re-ran beginCheckout against the cart workflow.
    expect(handles[CART_WF_ID].executeUpdate).toHaveBeenCalledWith(Cart.cartUpdate, {
      args: [{ type: 'beginCheckout' }],
    });
    expect(handles['ck-new'].executeUpdate).toHaveBeenCalledWith(Checkout.setShippingUpdate, {
      args: [{ shippingAddress: address }],
    });
  });
});

describe('submitOrder', () => {
  it('clears the cart cookie only when checkout reaches the complete step', async () => {
    const handles = installHandles();
    cookieStore.set('cartId', CART_ID);
    workflow.getHandle(CART_WF_ID);
    handles[CART_WF_ID].query.mockResolvedValue('ck-1');
    workflow.getHandle('ck-1');
    handles['ck-1'].executeUpdate.mockResolvedValueOnce({ step: 'payment' });

    expect(await submitOrder(CART_ID)).toEqual({ step: 'payment' });
    expect(cookieStore.deleted).toEqual([]);

    handles['ck-1'].executeUpdate.mockResolvedValueOnce({ step: 'complete' });
    expect(await submitOrder(CART_ID)).toEqual({ step: 'complete' });
    expect(cookieStore.deleted).toEqual(['cartId']);
    expect(handles['ck-1'].executeUpdate).toHaveBeenCalledWith(Checkout.submitOrderUpdate, {
      args: [{}],
    });
  });

  // ── The cookie must not outlive its cart (#10 / run -008 F-2) ──────────────────────
  // Before this, clearing was wired to exactly ONE path (checkout reaching `complete`), so
  // ABANDONING a cart left the cookie behind and the next add-to-cart started a second RUN
  // under the same workflow id. Post-R5 the cartId IS the journey correlationId, so run -008
  // ended with five shopping trips sharing one id.
  it('retires the cookie when emptying the cart abandons it', async () => {
    const handles = installHandles();
    cookieStore.set('cartId', CART_ID);
    workflow.getHandle(CART_WF_ID);
    handles[CART_WF_ID].executeUpdate.mockResolvedValueOnce({
      cartId: CART_ID,
      status: 'abandoned',
      items: [],
    });

    await removeFromCart(CART_ID, 'li-1');
    expect(cookieStore.deleted).toEqual(['cartId']);
  });

  it('keeps the cookie while the cart is still shoppable', async () => {
    const handles = installHandles();
    cookieStore.set('cartId', CART_ID);
    workflow.getHandle(CART_WF_ID);
    handles[CART_WF_ID].executeUpdate.mockResolvedValueOnce({
      cartId: CART_ID,
      status: 'active',
      items: [{ lineItemId: 'li-2' }],
    });

    await removeFromCart(CART_ID, 'li-1');
    expect(cookieStore.deleted).toEqual([]);
  });

  it('retires the cookie when the cart workflow is gone', async () => {
    const handles = installHandles();
    cookieStore.set('cartId', CART_ID);
    workflow.getHandle(CART_WF_ID);
    handles[CART_WF_ID].executeUpdate.mockRejectedValueOnce(workflowNotFound());

    expect(await removeFromCart(CART_ID, 'li-1')).toBeNull();
    expect(cookieStore.deleted).toEqual(['cartId']); // a cookie naming a dead workflow is worse than none
  });

  it("leaves a DIFFERENT cart's cookie alone", async () => {
    // Two tabs: this command ends an older cart while the cookie already names a newer one.
    const handles = installHandles();
    cookieStore.set('cartId', 'a-newer-cart');
    workflow.getHandle(CART_WF_ID);
    handles[CART_WF_ID].executeUpdate.mockResolvedValueOnce({
      cartId: CART_ID,
      status: 'abandoned',
      items: [],
    });

    await removeFromCart(CART_ID, 'li-1');
    expect(cookieStore.deleted).toEqual([]);
  });

  it('returns null without touching the cookie when there is no checkout workflow', async () => {
    const handles = installHandles();
    cookieStore.set('cartId', CART_ID);
    workflow.getHandle(CART_WF_ID);
    handles[CART_WF_ID].query.mockRejectedValue(workflowNotFound());

    expect(await submitOrder(CART_ID)).toBeNull();
    expect(cookieStore.deleted).toEqual([]);
  });
});
