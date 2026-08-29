/**
 * Regenerate the workflow history fixtures the replay tests run against (ported from
 * nightheron-mono's capture script, redesigned around this repo's e2e journey).
 *
 * Drives ONE full customer journey — cart → checkout → OMS → fulfillment → feedback — on the
 * time-skipping test server (the same harness `order-journey.e2e.test.ts` uses — no Docker, no
 * local stack), then writes the cart, checkout, and oms executions' event histories to
 * `src/temporal/{domain}/__histories__/full-journey.json`. One drive, three fixtures, every one
 * a complete lifecycle through its terminal event.
 *
 * Run it after an *intentional* workflow change has made the replay tests fail:
 *
 *     npm run histories:capture
 *
 * The fixture diff is the point: regenerating is the visible, deliberate act of saying "old
 * histories no longer apply". If the replay tests fail and you did not mean to change workflow
 * behaviour, the fix is in the workflow, not here.
 *
 * Two lessons carried from the parent's script:
 *   - A capture must never HANG. Every wait here is bounded (`pollUntil`, `settle`); a workflow
 *     that fails to reach its terminal state is terminated and reported, not awaited forever.
 *   - A missing activity stub does not fail a capture — the proxy retries, the machine effect
 *     fails, and the fixture silently pins a FAILURE path that looks like the happy one. The
 *     stub sets below mirror the e2e test's exhaustively; grep a capture run's output for
 *     `not registered` rather than trusting the exit code.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import proto from '@temporalio/proto';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { withWorkflowEnv } from '../src/test-support/workflow-env';
import {
  CART_TASK_QUEUE,
  CHECKOUT_TASK_QUEUE,
  OMS_TASK_QUEUE,
  FULFILLMENT_TASK_QUEUE,
  buildWorkflowId,
  buildWorkflowStartOptions,
  DEMO_STORE_ID,
} from '../src/temporal/contracts/constants';
import {
  cartUpdate,
  getCartQuery,
  getCheckoutWorkflowIdQuery,
} from '../src/temporal/cart/definitions';
import {
  setShippingUpdate,
  setPaymentUpdate,
  submitOrderUpdate,
  getCheckoutStateQuery,
} from '../src/temporal/checkout/definitions';
import { getOrderStateQuery, submitFeedbackUpdate } from '../src/temporal/oms/definitions';
import type { CreateOrderInput } from '../src/temporal/checkout/activities';
import type { Order } from '../src/temporal/checkout/types';

const History = proto.temporal.api.history.v1.History;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPORAL_ROOT = path.join(HERE, '..', 'src', 'temporal');

const CART_ID = 'replay-cart-1';
const ORDER_ID = 'replay-order-1';
/** The journey key — its own uuid, deliberately ≠ any entity id (ADR-0031). */
const CORRELATION_ID = randomUUID();

/** Real (not skipped) time — the test server skips workflow timers, not host task processing. */
const SETTLE_TIMEOUT_MS = 60_000;
const POLL_TRIES = 100;
const POLL_DELAY_MS = 200;

// ── Bounded waiting: a capture must never hang ───────────────────────────

async function pollUntil<T>(
  what: string,
  read: () => Promise<T>,
  done: (v: T) => boolean,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < POLL_TRIES; i++) {
    try {
      const v = await read();
      if (done(v)) return v;
      last = v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, POLL_DELAY_MS));
  }
  throw new Error(`capture: timed out waiting for ${what}; last=${JSON.stringify(last)}`);
}

type Outcome = 'completed' | 'failed' | 'parked';

/**
 * Wait for the workflow to finish, bounded, and terminate it if it does not. A terminated
 * history still replays correctly: termination is not a workflow task, so the replayer simply
 * stops at the last task the workflow actually processed.
 */
async function settle(handle: {
  result: () => Promise<unknown>;
  terminate: (r?: string) => Promise<unknown>;
}): Promise<Outcome> {
  let timer: NodeJS.Timeout | undefined;
  const parked = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve('parked'), SETTLE_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([
      handle
        .result()
        .then((): Outcome => 'completed')
        .catch((): Outcome => 'failed'),
      parked,
    ]);
    if (outcome === 'parked') {
      await handle.terminate('capture complete — workflow parked awaiting input');
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Fixture serialization ────────────────────────────────────────────────

/**
 * Serialized with protobufjs' own `toObject` rather than the SDK's `historyToJSON`, which fails
 * on fetched histories: payload metadata is a `map<string, bytes>` whose Buffer values
 * proto3-json-serializer refuses to convert. `toObject` handles them (base64), and
 * `History.fromObject` — the read side, in the replay test — round-trips the result exactly.
 */
function historyToFixtureJson(history: unknown): string {
  const message = History.fromObject(history as Record<string, unknown>);
  const plain = History.toObject(message, { enums: String, longs: String, bytes: String });
  scrubStackTraces(plain);
  return `${JSON.stringify(plain, null, 2)}\n`;
}

/** Blank every `stackTrace` in failure events — they name absolute paths on the capturing machine. */
function scrubStackTraces(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(scrubStackTraces);
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.stackTrace === 'string') record.stackTrace = '';
    Object.values(record).forEach(scrubStackTraces);
  }
}

// ── Stub activities — mirror order-journey.e2e.test.ts exhaustively ──────

const envRef: { env?: TestWorkflowEnvironment } = {};

const cartActivities = {
  validateInventory: async () => true,
  reserveCartItem: async () => 'r-replay-1',
  releaseCartItem: async () => undefined,
  indexCart: async () => undefined,
  deleteCart: async () => undefined,
};

const checkoutActivities = {
  // REAL live-cart bridge: `queryCart` in this repo queries the parent cart workflow (unlike
  // the parent platform, where it is a plain stubbable read) — so the checkout capture
  // genuinely needs the cart worker co-running.
  queryCart: async (parentCartWorkflowId: string) => {
    const cart = await envRef
      .env!.client.workflow.getHandle(parentCartWorkflowId)
      .query(getCartQuery);
    return {
      items: cart.items,
      subtotalPrice: cart.subtotalPrice,
      totalDiscounts: cart.totalDiscounts,
      appliedCoupons: cart.appliedCoupons,
      cartVersion: cart.cartVersion,
    };
  },
  renewReservationsForCheckout: async () => ({
    success: true,
    reservations: [
      { reservationId: 'r-replay-1', variantId: 'v1', blankSku: 'SKU-1', quantity: 2 },
    ],
  }),
  calculateShipping: async () => 5,
  calculateTax: async () => 1.6,
  createPaymentIntent: async () => ({ clientSecret: 'cs_replay', id: 'pi_replay' }),
  verifyPayment: async () => true,
  processPayment: async () => true,
  createOrder: async (input: CreateOrderInput): Promise<Order> => ({
    orderId: ORDER_ID,
    cartId: input.cartId,
    correlationId: CORRELATION_ID,
    customerEmail: input.shippingAddress.email,
    items: input.items,
    shippingAddress: input.shippingAddress,
    paymentMethod: input.paymentMethod,
    subtotal: input.subtotal,
    shippingCost: input.shippingCost,
    tax: input.tax,
    totalDiscounts: input.totalDiscounts,
    total: input.total,
    currency: input.currency,
    status: 'paid',
    createdAt: '2026-01-01T00:00:00Z',
    confirmationNumber: 'REPLAY123',
  }),
  sendConfirmationEmail: async () => undefined,
  // REAL OMS start through the test env's client, as production does through its own client.
  startOrderManagementWorkflow: async (order: Order, customerEmail: string) => {
    const startOptions = buildWorkflowStartOptions({
      storeId: DEMO_STORE_ID,
      domain: 'order',
      entityId: order.orderId,
      correlationId: order.correlationId,
      orderId: order.orderId,
      cartId: order.cartId,
    });
    await envRef.env!.client.workflow.start('orderWorkflow', {
      ...startOptions,
      taskQueue: OMS_TASK_QUEUE,
      args: [{ order, customerEmail }],
    });
    return startOptions.workflowId;
  },
  confirmReservations: async () => ({ unavailable: [] }),
  refundPayment: async () => true,
  releaseReservations: async () => undefined,
  cancelReservations: async () => undefined,
};

const omsActivities = {
  saveOrderToDatabase: async () => undefined,
  updateOrderInDatabase: async () => undefined,
  sendOrderStatusEmail: async () => undefined,
  sendFeedbackThankYouEmail: async () => undefined,
  resolveFulfillerAssignments: async (items: unknown[]) =>
    items.map(() => ({
      fulfillerId: 'simulated',
      fulfillerName: 'Simulated',
      fulfillerType: 'simulated',
    })),
  insertStatusHistoryEntry: async () => undefined,
  getOrdersByEmail: async () => [],
  getOrderById: async () => null,
  indexOrder: async () => undefined,
  indexFulfillerOrder: async () => undefined,
  indexCustomer: async () => undefined,
};

const fulfillmentActivities = {
  getFeatureFlag: async () => false, // automatic (timer-driven) fulfillment
  submitFulfillerOrder: async () => ({ success: true, fulfillerOrderId: 'SIM-REPLAY-1' }),
  sendShippedEmail: async () => undefined,
  sendDeliveredEmail: async () => undefined,
  transferInventoryReservations: async () => undefined,
  fulfillInventoryReservations: async () => undefined,
  releaseInventoryReservations: async () => undefined,
  indexFulfillment: async () => undefined,
  indexShipment: async () => undefined,
};

// ── The journey drive ────────────────────────────────────────────────────

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

async function main() {
  const workers = [
    {
      taskQueue: CART_TASK_QUEUE,
      workflowsPath: path.join(TEMPORAL_ROOT, 'cart', 'workflows.ts'),
      activities: cartActivities,
    },
    {
      taskQueue: CHECKOUT_TASK_QUEUE,
      workflowsPath: path.join(TEMPORAL_ROOT, 'checkout', 'workflows.ts'),
      activities: checkoutActivities,
    },
    {
      taskQueue: OMS_TASK_QUEUE,
      workflowsPath: path.join(TEMPORAL_ROOT, 'oms', 'workflows.ts'),
      activities: omsActivities,
    },
    {
      taskQueue: FULFILLMENT_TASK_QUEUE,
      workflowsPath: path.join(TEMPORAL_ROOT, 'fulfillment', 'workflows.ts'),
      activities: fulfillmentActivities,
    },
  ];

  await withWorkflowEnv(workers, async (env) => {
    envRef.env = env;

    // 1. Cart: add 2 × $10, then begin checkout — the cart starts the REAL checkout child.
    const cartHandle = await env.client.workflow.start('cartWorkflow', {
      taskQueue: CART_TASK_QUEUE,
      ...buildWorkflowStartOptions({
        storeId: DEMO_STORE_ID,
        domain: 'cart',
        entityId: CART_ID,
        correlationId: CORRELATION_ID,
        cartId: CART_ID,
      }),
      args: [{ cartId: CART_ID }],
    });
    await cartHandle.executeUpdate(cartUpdate, {
      args: [{ type: 'addItem', variantId: 'v1', quantity: 2, price: 10 }],
    });
    await cartHandle.executeUpdate(cartUpdate, { args: [{ type: 'beginCheckout' }] });

    const checkoutWorkflowId = await pollUntil(
      'checkout child id',
      async () => (await cartHandle.query(getCheckoutWorkflowIdQuery)) as string | null,
      (id) => !!id,
    );
    const checkoutHandle = env.client.workflow.getHandle(checkoutWorkflowId!);

    await pollUntil(
      'checkout at shipping',
      async () => (await checkoutHandle.query(getCheckoutStateQuery)) as { step?: string },
      (s) => s.step === 'shipping',
    );

    // 2. Shipping → payment → submit.
    await checkoutHandle.executeUpdate(setShippingUpdate, { args: [{ shippingAddress: address }] });
    await checkoutHandle.executeUpdate(setPaymentUpdate, {
      args: [{ paymentMethod: { type: 'mock', token: 'tok_replay' } }],
    });
    await checkoutHandle.executeUpdate(submitOrderUpdate, { args: [{}] });

    // 3. Wait for OMS intake to start the fulfillment child BEFORE awaiting its result —
    //    settling a handle whose workflow does not exist yet reads as an immediate failure,
    //    and with nothing awaiting a result the env's time-skipping stays LOCKED, so the
    //    simulated fulfillment timers only crawl forward in real time. (Found live: the first
    //    run of this script did exactly that and stalled at `shipped`.)
    const omsHandle = env.client.workflow.getHandle(
      buildWorkflowId(DEMO_STORE_ID, 'order', ORDER_ID),
    );
    await pollUntil(
      'order processing (fulfillment child started)',
      async () => (await omsHandle.query(getOrderStateQuery)) as { status?: string },
      (s) => s.status === 'processing' || s.status === 'shipped' || s.status === 'delivered',
    );
    // Awaiting the fulfillment result is what unlocks time skipping; the simulated timers then
    // fast-forward through in_production → shipped → delivered, signalling OMS along the way.
    const fulfillmentHandle = env.client.workflow.getHandle(
      buildWorkflowId(DEMO_STORE_ID, 'fulfillment', ORDER_ID),
    );
    const fulfillmentOutcome = await settle(fulfillmentHandle);
    console.log(`fulfillment: ${fulfillmentOutcome}`);
    if (fulfillmentOutcome !== 'completed') {
      throw new Error(
        'capture: fulfillment did not complete — the journey fixtures would pin a broken path',
      );
    }

    await pollUntil(
      'order delivered',
      async () => (await omsHandle.query(getOrderStateQuery)) as { status?: string },
      (s) => s.status === 'delivered',
    );

    // 4. Feedback closes the order; the checkout's completion signal closes the cart.
    await omsHandle.executeUpdate(submitFeedbackUpdate, {
      args: [{ rating: 5, comment: 'replay fixture' }],
    });

    const outcomes = {
      oms: await settle(omsHandle),
      checkout: await settle(checkoutHandle),
      cart: await settle(cartHandle),
    };

    // 5. Capture all three histories from the ONE journey.
    const captures = [
      { domain: 'cart', handle: cartHandle, outcome: outcomes.cart },
      { domain: 'checkout', handle: checkoutHandle, outcome: outcomes.checkout },
      { domain: 'oms', handle: omsHandle, outcome: outcomes.oms },
    ] as const;

    for (const { domain, handle, outcome } of captures) {
      const outputDir = path.join(TEMPORAL_ROOT, domain, '__histories__');
      await mkdir(outputDir, { recursive: true });
      const history = (await handle.fetchHistory()) as { events?: unknown[] };
      await writeFile(path.join(outputDir, 'full-journey.json'), historyToFixtureJson(history));
      console.log(
        `captured ${domain}/full-journey — ${outcome}, ${history.events?.length ?? 0} events`,
      );
    }
  });

  console.log('\nfixtures written under src/temporal/*/__histories__/');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
