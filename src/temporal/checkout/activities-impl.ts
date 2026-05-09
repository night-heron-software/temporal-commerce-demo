/**
 * Checkout Activity Implementations
 * Mock payment, console email, real Cassandra-backed inventory
 */

import { Cart } from '../contracts';
type CartItem = Cart.CartItem;
type Order = Cart.Order;
type PaymentMethod = Cart.PaymentMethod;
export type ShippingAddress = Cart.ShippingAddress;
import { v4 as uuidv4 } from 'uuid';

import { executeCql, logger as log, sendEmail } from '../../lib';
import { cassandraTypes as types } from '../../lib';
import { ApplicationFailure } from '@temporalio/activity';
import { InventoryCommandRepository } from '../inventory/db/inventory-command-repository';

interface VariantRow {
  blank_sku: string;
}

async function resolveBlankSku(variantId: string): Promise<string | null> {
  const variants = await executeCql<VariantRow>(
    `SELECT blank_sku FROM variants WHERE id = ?`,
    [types.Uuid.fromString(variantId)]
  );
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
    NH: 0
  };

  const rate = taxRates[state.toUpperCase()] ?? 0.08;
  return Math.round(subtotal * rate);
}

/**
 * Create a PaymentIntent — always mock for demo
 */
export async function createPaymentIntent(
  amount: number,
  currency: string
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
 * Process payment — always mock for demo
 */
export async function processPayment(
  token: string,
  amount: number,
  currency: string,
  idempotencyKey?: string
): Promise<boolean> {
  log.info(`[Activity] Processing MOCK payment: ${amount} ${currency} with token ${token}`);
  await new Promise((resolve) => setTimeout(resolve, 500)); // Simulate processing
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

  const orderId = uuidv4();
  const confirmationNumber = generateConfirmationNumber();

  const order: Order = {
    orderId,
    cartId: input.cartId,
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
    confirmationNumber
  };

  log.info(`[Activity] Order created: ${confirmationNumber}`);
  return order;
}

/**
 * Send order confirmation email (console-only in demo)
 */
export async function sendConfirmationEmail(
  email: string,
  confirmationNumber: string,
  order: Order
): Promise<void> {
  await sendEmail({
    to: email,
    subject: `Order Confirmed - #${confirmationNumber}`,
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
  customerEmail: string
): Promise<string> {
  log.info(`[Activity] Starting OMS workflow for order: ${order.orderId}`);

  const { getTemporalClient } = await import('../../lib/temporal-client');
  const client = await getTemporalClient();

  const workflowId = `order-${order.orderId}`;

  await client.workflow.start('orderWorkflow', {
    taskQueue: 'oms-queue',
    workflowId,
    args: [{ order, customerEmail }],
    workflowExecutionTimeout: '365 days'
  });

  log.info(`[Activity] Started OMS workflow: ${workflowId}`);
  return workflowId;
}

/**
 * Renew (or re-reserve) inventory for checkout.
 * Releases any existing cart reservations and re-reserves all items
 * with fresh TTLs via the real InventoryCommandRepository.
 */
export async function renewReservationsForCheckout(
  cartId: string,
  items: CartItem[]
): Promise<{
  success: boolean;
  reservations: ReservationInfo[];
  unavailableItems?: Array<{ variantId: string; error: string }>;
  error?: string;
}> {
  log.info({ cartId, itemCount: items.length }, 'Renewing reservations for checkout');

  // Release any stale reservations from the cart phase first
  await InventoryCommandRepository.releaseAllForCart(cartId);

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

  // Reserve all items atomically (with rollback on any failure)
  const result = await InventoryCommandRepository.reserveAll(cartId, resolvedItems, `checkout-${cartId}`);

  if (!result.success) {
    return {
      success: false,
      reservations: [],
      error: result.error || 'Insufficient stock for one or more items',
    };
  }

  return {
    success: true,
    reservations: result.reservations!.map(r => ({
      variantId: r.variantId,
      reservationId: r.reservationId,
    })),
  };
}

/**
 * Confirm reservations after successful payment.
 * Transitions all TEMPORARY reservations for the cart to CONFIRMED status,
 * removing TTL expiration so they persist until fulfillment.
 */
export async function confirmReservations(reservations: ReservationInfo[]): Promise<void> {
  if (reservations.length === 0) return;
  log.info({ count: reservations.length }, 'Confirming reservations');

  await Promise.all(
    reservations.map(r => InventoryCommandRepository.confirm(r.reservationId))
  );
}

/**
 * Release reservations on checkout failure or cancellation.
 * Decrements reserved_stock and removes reservation records.
 */
export async function releaseReservations(reservations: ReservationInfo[]): Promise<void> {
  if (reservations.length === 0) return;
  log.info({ count: reservations.length }, 'Releasing reservations');

  await Promise.all(
    reservations.map(r => InventoryCommandRepository.release(r.reservationId))
  );
}

/**
 * Cancel confirmed reservations (order cancelled after payment).
 * Decrements reserved_stock from the assigned supplier and sets status to CANCELLED.
 */
export async function cancelReservations(reservations: ReservationInfo[]): Promise<void> {
  if (reservations.length === 0) return;
  log.info({ count: reservations.length }, 'Cancelling reservations');

  await Promise.all(
    reservations.map(r => InventoryCommandRepository.cancel(r.reservationId))
  );
}
