'use server';

/**
 * Admin Order Actions
 *
 * Server Actions for querying and controlling order workflows.
 * No auth — demo mode. Uses Temporal queries/updates directly.
 */

import { getTemporalClient } from '@/lib';
import { executeCql, cassandraTypes as types } from '@/lib';
import {
  getOrderStateQuery,
  updateStatusUpdate,
  cancelOrderUpdate,
} from '@/temporal/oms/definitions';
import type { OrderState, UpdateStatusSignal, OrderStatus } from '@/temporal/oms/types';

export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export interface OrderSummary {
  orderId: string;
  confirmationNumber: string;
  customerEmail: string;
  total: number;
  currency: string;
  status: string;
  createdAt: string;
}

/**
 * Get all orders from Cassandra
 */
export async function getAllOrders(): Promise<ActionResult<OrderSummary[]>> {
  try {
    const rows = await executeCql<{
      order_id: { toString(): string };
      confirmation_number: string;
      customer_email: string;
      total: number;
      currency: string;
      status: string;
      created_at: Date | null;
    }>(
      `SELECT order_id, confirmation_number, customer_email, total, currency, status, created_at FROM orders LIMIT 200`
    );

    const sorted = rows.sort((a, b) => {
      const aTime = a.created_at?.getTime() ?? 0;
      const bTime = b.created_at?.getTime() ?? 0;
      return bTime - aTime;
    });

    const data = sorted.map((row) => ({
      orderId: row.order_id.toString(),
      confirmationNumber: row.confirmation_number,
      customerEmail: row.customer_email ?? '',
      total: row.total ?? 0,
      currency: row.currency ?? 'USD',
      status: row.status ?? 'unknown',
      createdAt: row.created_at?.toISOString() ?? new Date().toISOString(),
    }));

    return { success: true, data };
  } catch (e) {
    console.error('Failed to get all orders:', e);
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
    const workflowId = `order-${orderId}`;
    const handle = client.workflow.getHandle(workflowId);
    const state = await handle.query(getOrderStateQuery);
    return { success: true, data: state };
  } catch (e) {
    console.error('Failed to get order state:', e);
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
  note?: string
): Promise<ActionResult<OrderState>> {
  try {
    const client = await getTemporalClient();
    const workflowId = `order-${orderId}`;
    const handle = client.workflow.getHandle(workflowId);
    const state = await handle.executeUpdate(updateStatusUpdate, {
      args: [{ status, note, updatedBy: 'admin' as const } as UpdateStatusSignal],
    });
    return { success: true, data: state };
  } catch (e) {
    console.error('Failed to update order status:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error: `Failed to update order: ${message}` };
  }
}

/**
 * Cancel an order via Temporal update
 */
export async function cancelOrder(
  orderId: string,
  reason?: string
): Promise<ActionResult<OrderState>> {
  try {
    const client = await getTemporalClient();
    const workflowId = `order-${orderId}`;
    const handle = client.workflow.getHandle(workflowId);
    const state = await handle.executeUpdate(cancelOrderUpdate, {
      args: [{ reason }],
    });
    return { success: true, data: state };
  } catch (e) {
    console.error('Failed to cancel order:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error: `Failed to cancel order: ${message}` };
  }
}
