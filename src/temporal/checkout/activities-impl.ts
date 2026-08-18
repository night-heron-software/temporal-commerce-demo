/**
 * Checkout Activity Implementations
 * Mock payment, console email, real Cassandra-backed inventory
 */

import { ApplicationFailure } from '@temporalio/common';
import { Cart } from '../contracts';
import { reservationClosedDoc } from '../contracts/inventory';
type CartItem = Cart.CartItem;
type Order = Cart.Order;
type PaymentMethod = Cart.PaymentMethod;
export type ShippingAddress = Cart.ShippingAddress;
import { randomUUID } from 'crypto';

import { executeCql, logger as log, sendEmail, getElasticsearchClient } from '../../lib';
import { cassandraTypes as types } from '../../lib';
import { buildCommunication } from '../../lib/communication-templates';
import { currentCorrelationId } from '../../lib/correlation-context';

import {
  InventoryCommandRepository,
  InventoryContentionError,
} from '../inventory/db/inventory-command-repository';
import { Elasticsearch } from '../contracts';
const { ES_INDICES } = Elasticsearch;

interface VariantRow {
  blank_sku: string;
}

async function resolveBlankSku(variantId: string): Promise<string | null> {
  const variants = await executeCql<VariantRow>(`SELECT blank_sku FROM variants WHERE id = ?`, [
    types.Uuid.fromString(variantId),
  ]);
  if (variants.length > 0) return variants[0].blank_sku;
  return null;
}

export interface CreateOrderInput {
  cartId: string;
  items: CartItem[];
  shippingAddress: ShippingAddress;
  paymentMethod: PaymentMethod;
  subtotal: number;
  shippingCost: number;
  tax: number;
  totalDiscounts: number;
  total: number;
  currency: string;
}

export interface ReservationInfo {
  variantId: string;
  reservationId: string;
}

/**
 * Calculate shipping cost based on address
 */
export async function calculateShipping(address: string): Promise<number> {
  log.info(`[Activity] Calculating shipping for: ${address}`);
  return 999; // $9.99 flat rate
}

/**
 * Calculate tax based on state and subtotal
 */
export async function calculateTax(state: string, subtotal: number): Promise<number> {
  log.info(`[Activity] Calculating tax for state: ${state}, subtotal: ${subtotal}`);

  const taxRates: Record<string, number> = {
    CA: 0.0725,
    NY: 0.08,
    TX: 0.0625,
    WA: 0.065,
    FL: 0.06,
    OR: 0,
    NH: 0,
  };

  const rate = taxRates[state.toUpperCase()] ?? 0.08;
  return Math.round(subtotal * rate);
}

/**
 * Create a PaymentIntent — always mock for demo
 */
export async function createPaymentIntent(
  amount: number,
  currency: string,
): Promise<{ clientSecret: string; id: string }> {
  log.info(`[Activity] Creating mock PaymentIntent for ${amount} ${currency}`);
  return { clientSecret: 'mock_secret', id: 'mock_pi_' + Date.now() };
}

/**
 * Verify payment — always mock for demo
 */
export async function verifyPayment(paymentIntentId: string): Promise<boolean> {
  log.info(`[Activity] Verifying mock payment: ${paymentIntentId}`);
  return true;
}

/**
 * Keys already charged in mock mode, each remembering the amount it charged — the gateway
 * model, where the key names the attempt and the amount is validated against it. Bounded so
 * a long-lived dev worker cannot grow it without limit; eviction is oldest-first (Map
 * preserves insertion order) and only matters after thousands of distinct attempts, by which
 * point re-charging a long-abandoned one is not the failure anyone is looking for.
 */
const MOCK_CHARGED_KEYS = new Map<string, number>();
const MOCK_CHARGED_KEYS_MAX = 5000;

function rememberMockCharge(key: string, amount: number): void {
  if (MOCK_CHARGED_KEYS.size >= MOCK_CHARGED_KEYS_MAX) {
    const oldest = MOCK_CHARGED_KEYS.keys().next().value;
    if (oldest !== undefined) MOCK_CHARGED_KEYS.delete(oldest);
  }
  MOCK_CHARGED_KEYS.set(key, amount);
}

/**
 * Process payment — always mock for demo.
 *
 * The idempotency key genuinely deduplicates (lineage: mono #241 / `f42c3bda`; the demo's
 * pre-fix mock accepted the key as `_idempotencyKey` and DISCARDED it, so mock mode could not
 * reproduce a double-charge even in principle — the mono's validation run 013 found a
 * triple-charge P0 invisible to every mock-mode run for exactly that reason. A mock that
 * cannot exhibit the failure it stands in for is a mock that hides it.)
 *
 * The key is a nonce naming the attempt (`${workflowId}-pay-${attempt}`), and the amount is
 * VALIDATED against it: replaying a known key with the same amount returns the first result
 * without charging again; replaying it with a different amount throws non-retryably — the
 * gateway model (Stripe rejects a reused key whose request differs). Amount drift on a retry
 * is a bug to surface, never a silent second charge.
 *
 * Limits, stated rather than discovered later: the store is per-process and in-memory, so it
 * is lost on worker restart and not shared across workers. Acceptable for a dev stand-in —
 * the point is that a repeated or conflicting charge for one attempt is observable locally.
 */
export async function processPayment(
  token: string,
  amount: number,
  currency: string,
  idempotencyKey?: string,
): Promise<boolean> {
  log.info(`[Activity] Processing MOCK payment: ${amount} ${currency} with token ${token}`);
  await new Promise((resolve) => setTimeout(resolve, 500)); // Simulate processing

  if (idempotencyKey) {
    const chargedAmount = MOCK_CHARGED_KEYS.get(idempotencyKey);
    if (chargedAmount !== undefined) {
      if (chargedAmount !== amount) {
        throw ApplicationFailure.nonRetryable(
          `Idempotency key ${idempotencyKey} was already charged ${chargedAmount} — ` +
            `refusing to replay it for a different amount (${amount}). A new charge needs a new attempt.`,
          'IDEMPOTENCY_KEY_AMOUNT_MISMATCH',
        );
      }
      log.warn(
        `[Activity] MOCK payment already charged for key ${idempotencyKey} — returning the first result, not charging again`,
      );
      return true;
    }
    rememberMockCharge(idempotencyKey, amount);
  }
  return true;
}

/**
 * Refund a payment — always mock for demo. Issued when inventory cannot be re-secured
 * after payment (a hold expired at the payment step and its stock resold — issue #34),
 * so the shopper is made whole before the submit fails.
 */
export async function refundPayment(
  token: string,
  amount: number,
  currency: string,
  cartId: string,
): Promise<boolean> {
  log.info(
    `[Activity] Refunding MOCK payment: ${amount} ${currency} with token ${token} for cart ${cartId}`,
  );
  return true;
}

/**
 * Create an order object
 */
export async function createOrder(input: CreateOrderInput): Promise<Order> {
  log.info(`[Activity] Creating order for cart: ${input.cartId}`);

  if (!input.shippingAddress?.email) {
    throw new Error('Shipping address email is required');
  }

  const orderId = randomUUID();
  const confirmationNumber = generateConfirmationNumber();

  const order: Order = {
    orderId,
    cartId: input.cartId,
    // The journey's correlationId (ADR-0011) from the ambient activity context (set by
    // the worker's correlation interceptor). Fallback cartId keeps seed/api paths —
    // which run outside any workflow — working.
    correlationId: currentCorrelationId() ?? input.cartId,
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
    createdAt: new Date().toISOString(),
    confirmationNumber,
  };

  log.info(`[Activity] Order created: ${confirmationNumber}`);
  return order;
}

/**
 * Send order confirmation email (console-only in demo; persisted as a
 * CustomerCommunication domain object by sendEmail's write-through)
 */
export async function sendConfirmationEmail(
  email: string,
  confirmationNumber: string,
  order: Order,
): Promise<void> {
  const { subject, body } = buildCommunication('order-confirmation', {
    confirmationNumber,
    orderId: order.orderId,
  });
  await sendEmail({
    to: email,
    subject,
    text: body,
    orderId: order.orderId,
    // The order record's copy is the fallback outside an activity correlation scope
    // (ADR-0011) — the ambient correlationId wins inside one.
    correlationId: order.correlationId,
    commType: 'order-confirmation',
    actor: 'sendConfirmationEmail',
  });
}

/**
 * Generate a human-readable confirmation number
 */
function generateConfirmationNumber(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Start the Order Management System workflow for a new order
 */
export async function startOrderManagementWorkflow(
  order: Order,
  customerEmail: string,
): Promise<string> {
  log.info(`[Activity] Starting OMS workflow for order: ${order.orderId}`);

  const { getTemporalClient } = await import('../../lib/temporal-client');
  const { buildWorkflowStartOptions, DEMO_STORE_ID } = await import('../contracts/constants');
  const client = await getTemporalClient();

  // Pass the journey's correlationId along: ambient activity context first (set by the
  // worker's correlation interceptor from this checkout's own CorrelationId Search
  // Attribute), the order record's copy as the fallback (ADR-0011).
  const startOptions = buildWorkflowStartOptions({
    storeId: DEMO_STORE_ID,
    domain: 'order',
    entityId: order.orderId,
    correlationId: currentCorrelationId() ?? order.correlationId,
    orderId: order.orderId,
    cartId: order.cartId,
    memo: { confirmationNumber: order.confirmationNumber },
  });

  await client.workflow.start('orderWorkflow', {
    ...startOptions,
    taskQueue: 'oms-queue',
    args: [{ order, customerEmail }],
    workflowExecutionTimeout: '365 days',
  });

  log.info(`[Activity] Started OMS workflow: ${startOptions.workflowId}`);
  return startOptions.workflowId;
}

/**
 * Live view of the parent cart's contents via the Temporal client (a workflow can't
 * query a peer directly, so this activity bridges). Used at `validating` and on each
 * recompute nudge so checkout never prices against a stale item snapshot.
 */
export async function queryCart(parentCartWorkflowId: string): Promise<{
  items: CartItem[];
  subtotalPrice: number;
  totalDiscounts: number;
  appliedCoupons: string[];
  cartVersion: number;
}> {
  const { getTemporalClient } = await import('../../lib/temporal-client');
  const client = await getTemporalClient();
  const cart = await client.workflow.getHandle(parentCartWorkflowId).query(Cart.getCartQuery);
  return {
    items: cart.items,
    subtotalPrice: cart.subtotalPrice,
    totalDiscounts: cart.totalDiscounts,
    appliedCoupons: cart.appliedCoupons,
    cartVersion: cart.cartVersion,
  };
}

/**
 * Renew inventory holds for checkout — TRUE IN-PLACE, no release/reacquire gap.
 * Existing TEMPORARY cart holds get their TTL extended (and quantity adjusted) in place
 * via `renewAllForCheckout`, so a concurrent cart can never steal the stock between a
 * release and a re-reserve. Items whose hold is missing (or already terminal, e.g. swept
 * by TTL expiry) log a warning and are reserved fresh; holds for variants no longer in
 * the cart are released.
 */
export async function renewReservationsForCheckout(
  cartId: string,
  items: CartItem[],
): Promise<{
  success: boolean;
  reservations: ReservationInfo[];
  unavailableItems?: Array<{ variantId: string; error: string }>;
  error?: string;
}> {
  log.info({ cartId, itemCount: items.length }, 'Renewing reservations for checkout (in-place)');

  // Resolve blank SKUs for all items
  const resolvedItems: Array<{ variantId: string; blankSku: string; quantity: number }> = [];
  const unavailableItems: Array<{ variantId: string; error: string }> = [];

  for (const item of items) {
    const blankSku = await resolveBlankSku(item.variantId);
    if (!blankSku) {
      unavailableItems.push({ variantId: item.variantId, error: 'Variant not found' });
    } else {
      resolvedItems.push({ variantId: item.variantId, blankSku, quantity: item.quantity });
    }
  }

  if (unavailableItems.length > 0) {
    return {
      success: false,
      reservations: [],
      unavailableItems,
      error: `${unavailableItems.length} item(s) could not be resolved`,
    };
  }

  // Renew existing holds in place; reserve fresh only where no live hold exists.
  const result = await InventoryCommandRepository.renewAllForCheckout(
    cartId,
    resolvedItems,
    `checkout-${cartId}`,
    15 * 60, // 15-minute checkout TTL — matches reserveAll's hold window
  );

  if (!result.success) {
    if (result.contention) {
      // Transient LWT conflict — throw so Temporal's activity retry policy takes over,
      // instead of failing the checkout entry outright.
      throw new InventoryContentionError(result.error ?? 'Inventory counter contention');
    }
    return {
      success: false,
      reservations: [],
      error: result.error || 'Insufficient stock for one or more items',
    };
  }

  return {
    success: true,
    reservations: result.reservations!.map((r) => ({
      variantId: r.variantId,
      reservationId: r.reservationId,
    })),
  };
}

/**
 * Confirm reservations after successful payment — two-phase (issue #34).
 *
 * A hold that sat at the payment step past its TTL may have been expiry-released, so
 * phase 1 resurrect()s every reservation: live holds pass through, RELEASED holds are
 * re-acquired (availability-checked) back to TEMPORARY with a fresh TTL. If ANY item
 * comes back unavailable, nothing is confirmed — every live hold is still TEMPORARY
 * and TTL-bound, so a failed submit strands no never-expiring CONFIRMED rows; the
 * caller refunds and fails the submit. Only when all holds are live does phase 2
 * confirm them.
 */
export async function confirmReservations(
  reservations: ReservationInfo[],
): Promise<{ unavailable: ReservationInfo[] }> {
  if (reservations.length === 0) return { unavailable: [] };
  log.info({ count: reservations.length }, 'Confirming reservations');

  // Phase 1: resurrect — re-secure any hold the expiry sweep released while the
  // shopper parked at payment. All-or-nothing: bail before confirming anything.
  const resurrected = await Promise.all(
    reservations.map(async (r) => ({
      reservation: r,
      outcome: await InventoryCommandRepository.resurrect(r.reservationId),
    })),
  );
  const unavailable = resurrected
    .filter(({ outcome }) => outcome === 'unavailable')
    .map(({ reservation }) => reservation);
  if (unavailable.length > 0) {
    log.warn({ count: unavailable.length }, 'Reservations unavailable at confirm — not confirming');
    return { unavailable };
  }

  // Phase 2: confirm all. A hold can still slip terminal between resurrect and
  // confirm (a sub-second expiry-sweep race) — treat any non-confirmed outcome as
  // unavailable too rather than shipping blind.
  const confirmed = await Promise.all(
    reservations.map(async (r) => ({
      reservation: r,
      outcome: await InventoryCommandRepository.confirm(r.reservationId),
    })),
  );
  const lost = confirmed.filter(
    ({ outcome }) => outcome !== 'confirmed' && outcome !== 'already-confirmed',
  );

  // Update reservation status in ES for the holds that did confirm
  const esClient = getElasticsearchClient();
  await Promise.all(
    confirmed
      .filter(({ outcome }) => outcome === 'confirmed' || outcome === 'already-confirmed')
      .map(({ reservation }) =>
        esClient
          .update({
            index: ES_INDICES.reservations,
            id: reservation.reservationId,
            doc: { status: 'CONFIRMED', expiresAt: null },
          })
          .catch(() => {
            /* ignore if not found */
          }),
      ),
  );

  return { unavailable: lost.map(({ reservation }) => reservation) };
}

/**
 * Release reservations on checkout failure or cancellation.
 * Decrements reserved_stock and removes reservation records.
 */
export async function releaseReservations(reservations: ReservationInfo[]): Promise<void> {
  if (reservations.length === 0) return;
  log.info({ count: reservations.length }, 'Releasing reservations');

  await Promise.all(reservations.map((r) => InventoryCommandRepository.release(r.reservationId)));

  // Close reservation docs in ES (kept searchable, marked completed)
  const esClient = getElasticsearchClient();
  const closedDoc = reservationClosedDoc('RELEASED', new Date().toISOString());
  await Promise.all(
    reservations.map((r) =>
      esClient
        .update({
          index: ES_INDICES.reservations,
          id: r.reservationId,
          doc: closedDoc,
        })
        .catch(() => {
          /* ignore if not found */
        }),
    ),
  );
}

/**
 * Cancel confirmed reservations (order cancelled after payment).
 * Decrements reserved_stock from the assigned fulfiller and sets status to CANCELLED.
 */
export async function cancelReservations(reservations: ReservationInfo[]): Promise<void> {
  if (reservations.length === 0) return;
  log.info({ count: reservations.length }, 'Cancelling reservations');

  await Promise.all(reservations.map((r) => InventoryCommandRepository.cancel(r.reservationId)));

  // Close reservation docs in ES (kept searchable, marked completed)
  const esClient = getElasticsearchClient();
  const closedDoc = reservationClosedDoc('CANCELLED', new Date().toISOString());
  await Promise.all(
    reservations.map((r) =>
      esClient
        .update({
          index: ES_INDICES.reservations,
          id: r.reservationId,
          doc: closedDoc,
        })
        .catch(() => {
          /* ignore if not found */
        }),
    ),
  );
}
