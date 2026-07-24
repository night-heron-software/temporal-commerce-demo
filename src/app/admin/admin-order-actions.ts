'use server';

/**
 * Admin Order Actions
 *
 * Server Actions for querying and controlling order workflows.
 * No auth — demo mode. Uses Temporal queries/updates directly.
 */

import { getTemporalClient } from '@/lib';
import { executeCqlAll } from '@/lib';
import { TEMPORAL_NAMESPACE } from '@/lib/temporal-client';
import { createLogger } from '@/lib/logger';
import {
  getOrderStateQuery,
  updateStatusUpdate,
  cancelOrderUpdate,
} from '@/temporal/oms/definitions';
import type { OrderState, UpdateStatusSignal, OrderStatus } from '@/temporal/oms/types';
import { buildWorkflowId, DEMO_STORE_ID } from '@/temporal/contracts/constants';

const log = createLogger('admin-order-actions');

export type ActionResult<T> = { success: true; data: T } | { success: false; error: string };

export interface OrderSummary {
  orderId: string;
  confirmationNumber: string;
  customerEmail: string;
  total: number;
  currency: string;
  status: string;
  createdAt: string;
  cartId: string | null;
  /**
   * The journey's correlationId (ADR-0011) — its own UUID minted at cart creation;
   * legacy rows predate the column, where correlationId equalled cartId.
   */
  correlationId: string | null;
  /**
   * Temporal UI workflows page filtered to this order's journey
   * (`CorrelationId` Search Attribute query); null if no correlation is known.
   * Built server-side because TEMPORAL_UI_URL is a server-only env var.
   */
  temporalUrl: string | null;
}

/** Temporal UI workflows list filtered by the journey correlationId. */
function temporalWorkflowsByCorrelationUrl(correlationId: string): string {
  const base = process.env.TEMPORAL_UI_URL || 'http://localhost:8233';
  const query = encodeURIComponent(`CorrelationId="${correlationId}"`);
  return `${base}/namespaces/${TEMPORAL_NAMESPACE}/workflows?query=${query}`;
}

/**
 * Get all orders from Cassandra (auto-pages the full table — previously a silent
 * LIMIT 200 that dropped older orders).
 */
export async function getAllOrders(): Promise<ActionResult<OrderSummary[]>> {
  try {
    const rows = await executeCqlAll<{
      order_id: { toString(): string };
      confirmation_number: string;
      customer_email: string;
      total: number;
      currency: string;
      status: string;
      created_at: Date | null;
      cart_id: string | null;
      correlation_id: string | null;
    }>(
      `SELECT order_id, confirmation_number, customer_email, total, currency, status, created_at, cart_id, correlation_id FROM orders`,
    );

    const sorted = rows.sort((a, b) => {
      const aTime = a.created_at?.getTime() ?? 0;
      const bTime = b.created_at?.getTime() ?? 0;
      return bTime - aTime;
    });

    const data = sorted.map((row) => {
      // Legacy rows predate orders.correlation_id, where the correlationId was the cartId.
      const correlationId = row.correlation_id ?? row.cart_id;
      return {
        orderId: row.order_id.toString(),
        confirmationNumber: row.confirmation_number,
        customerEmail: row.customer_email ?? '',
        total: row.total ?? 0,
        currency: row.currency ?? 'USD',
        status: row.status ?? 'unknown',
        createdAt: row.created_at?.toISOString() ?? new Date().toISOString(),
        cartId: row.cart_id,
        correlationId,
        temporalUrl: correlationId ? temporalWorkflowsByCorrelationUrl(correlationId) : null,
      };
    });

    return { success: true, data };
  } catch (e) {
    log.error({ err: e }, 'Failed to get all orders');
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error: `Failed to load orders: ${message}` };
  }
}

/**
 * Get order state from the OMS workflow via Temporal query
 */
export async function getOrderState(orderId: string): Promise<ActionResult<OrderState>> {
  try {
    const client = await getTemporalClient();
    const workflowId = buildWorkflowId(DEMO_STORE_ID, 'order', orderId);
    const handle = client.workflow.getHandle(workflowId);
    const state = await handle.query(getOrderStateQuery);
    return { success: true, data: state };
  } catch (e) {
    log.error({ orderId, err: e }, 'Failed to get order state');
    const message = e instanceof Error ? e.message : 'Unknown error';
    const isNotFound = message.includes('not found') || message.includes('NOT_FOUND');
    return {
      success: false,
      error: isNotFound ? `Order not found: ${orderId}` : `Failed to get order: ${message}`,
    };
  }
}

/**
 * Update order status via Temporal update
 */
export async function updateOrderStatus(
  orderId: string,
  status: OrderStatus,
  note?: string,
): Promise<ActionResult<OrderState>> {
  try {
    const client = await getTemporalClient();
    const workflowId = buildWorkflowId(DEMO_STORE_ID, 'order', orderId);
    const handle = client.workflow.getHandle(workflowId);
    const state = await handle.executeUpdate(updateStatusUpdate, {
      args: [{ status, note, updatedBy: 'admin' as const } as UpdateStatusSignal],
    });
    return { success: true, data: state };
  } catch (e) {
    log.error({ orderId, status, err: e }, 'Failed to update order status');
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error: `Failed to update order: ${message}` };
  }
}

/**
 * Cancel an order via Temporal update
 */
export async function cancelOrder(
  orderId: string,
  reason?: string,
): Promise<ActionResult<OrderState>> {
  try {
    const client = await getTemporalClient();
    const workflowId = buildWorkflowId(DEMO_STORE_ID, 'order', orderId);
    const handle = client.workflow.getHandle(workflowId);
    const state = await handle.executeUpdate(cancelOrderUpdate, {
      args: [{ reason }],
    });
    return { success: true, data: state };
  } catch (e) {
    log.error({ orderId, err: e }, 'Failed to cancel order');
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error: `Failed to cancel order: ${message}` };
  }
}
