'use server';

/**
 * Shop Order Actions
 *
 * Server Actions for customer-facing order lookups.
 * Simple email-based "login" — no real auth, demo mode.
 */

import { executeCql } from '@/lib';

export interface CustomerOrder {
  orderId: string;
  confirmationNumber: string;
  total: number;
  currency: string;
  status: string;
  createdAt: string;
}

/**
 * Get orders for a specific customer email using the orders_by_customer table.
 */
export async function getOrdersByEmail(email: string): Promise<{
  success: boolean;
  data: CustomerOrder[];
  error?: string;
}> {
  try {
    const rows = await executeCql<{
      order_id: { toString(): string };
      confirmation_number: string;
      total: number;
      currency: string;
      status: string;
      created_at: Date;
    }>(
      `SELECT order_id, confirmation_number, total, currency, status, created_at
       FROM orders_by_customer
       WHERE customer_email = ?
       LIMIT 50`,
      [email.toLowerCase().trim()]
    );

    const data: CustomerOrder[] = rows.map(row => ({
      orderId: row.order_id.toString(),
      confirmationNumber: row.confirmation_number,
      total: row.total ?? 0,
      currency: row.currency ?? 'USD',
      status: row.status ?? 'unknown',
      createdAt: row.created_at?.toISOString() ?? new Date().toISOString(),
    }));

    return { success: true, data };
  } catch (e) {
    console.error('Failed to get orders by email:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, data: [], error: `Failed to load orders: ${message}` };
  }
}
