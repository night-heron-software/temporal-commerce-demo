'use server';

/**
 * Shop Order Actions
 *
 * Server Actions for customer-facing order lookups.
 * Simple email-based "login" — no real auth, demo mode.
 */

import { executeCql } from '@/lib';

export interface ShippingAddress {
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
  email: string;
}

export interface CustomerOrder {
  orderId: string;
  confirmationNumber: string;
  total: number;
  currency: string;
  status: string;
  createdAt: string;
  shippingAddress?: ShippingAddress;
}

/**
 * Get orders for a specific customer email using the orders_by_customer table,
 * then enrich with shipping address from the main orders table.
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

    // Enrich each order with shipping address from the main orders table
    const data: CustomerOrder[] = await Promise.all(
      rows.map(async (row) => {
        const orderId = row.order_id.toString();

        // Fetch shipping address from main orders table
        let shippingAddress: ShippingAddress | undefined;
        try {
          const orderRows = await executeCql<{
            shipping_address: {
              first_name: string;
              last_name: string;
              address1: string;
              address2: string | null;
              city: string;
              state: string;
              postal_code: string;
              country: string;
              phone: string | null;
              email: string;
            } | null;
          }>(
            `SELECT shipping_address FROM orders WHERE order_id = ?`,
            [orderId]
          );
          const addr = orderRows[0]?.shipping_address;
          if (addr) {
            shippingAddress = {
              firstName: addr.first_name,
              lastName: addr.last_name,
              address1: addr.address1,
              address2: addr.address2 || undefined,
              city: addr.city,
              state: addr.state,
              postalCode: addr.postal_code,
              country: addr.country,
              phone: addr.phone || undefined,
              email: addr.email,
            };
          }
        } catch {
          // Non-fatal — show order without address
        }

        return {
          orderId,
          confirmationNumber: row.confirmation_number,
          total: row.total ?? 0,
          currency: row.currency ?? 'USD',
          status: row.status ?? 'unknown',
          createdAt: row.created_at?.toISOString() ?? new Date().toISOString(),
          shippingAddress,
        };
      })
    );

    return { success: true, data };
  } catch (e) {
    console.error('Failed to get orders by email:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, data: [], error: `Failed to load orders: ${message}` };
  }
}
