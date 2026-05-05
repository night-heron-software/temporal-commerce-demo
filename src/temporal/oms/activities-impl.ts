/**
 * OMS Activity Implementations
 * Actual implementations called by the worker
 */

import { log } from '@temporalio/activity';
import { getCassandraClient, cassandraTypes as types, getElasticsearchClient } from '../../lib';
import { Order, OrderState, OrderStatus, OrderAssignment, StatusHistoryRow } from './types';
import type { Elasticsearch } from '../contracts';
import { ES_INDICES } from '../contracts/elasticsearch';
import type { OrderLineItem, SupplierResolutionContext, SupplierAssignment } from '../contracts/product-type';


/**
 * Save order to database (writes to all three order tables)
 */
export async function saveOrderToDatabase(order: Order): Promise<void> {
  log.info(`[Activity] Saving order ${order.orderId} to database`);

  const client = getCassandraClient();
  const now = new Date();
  const orderIdUuid = types.Uuid.fromString(order.orderId);

  // Prepare items as frozen order_item UDT
  const items = order.items.map((item: any) => ({
    line_item_id: item.lineItemId,
    variant_id: item.variantId,
    quantity: item.quantity,
    price: item.price,
    properties: item.properties
      ? Object.fromEntries(Object.entries(item.properties).map(([k, v]) => [k, String(v)]))
      : {}
  }));

  // Prepare shipping address as frozen UDT
  const shippingAddress = {
    first_name: order.shippingAddress.firstName,
    last_name: order.shippingAddress.lastName,
    address1: order.shippingAddress.address1,
    address2: order.shippingAddress.address2 || '',
    city: order.shippingAddress.city,
    state: order.shippingAddress.state,
    postal_code: order.shippingAddress.postalCode,
    country: order.shippingAddress.country,
    phone: order.shippingAddress.phone || '',
    email: order.shippingAddress.email
  };

  // Prepare payment method as frozen UDT
  const paymentMethod = {
    type: order.paymentMethod.type,
    last4: order.paymentMethod.last4 || '',
    payment_token: order.paymentMethod.token
  };

  // Prepare assignments (if any - typically empty on initial save)
  const orderWithAssignments = order as Order & { assignments?: OrderAssignment[] };
  const assignments =
    orderWithAssignments.assignments?.map((a: OrderAssignment) => ({
      assignment_id: a.assignmentId,
      line_item_id: a.lineItemId,
      variant_id: a.variantId,
      supplier_id: a.supplierId,
      supplier_name: a.supplierName || '',
      quantity: a.quantity,
      status: a.status,
      supplier_order_id: a.supplierOrderId || ''
    })) || [];

  // Execute all three inserts as an atomic logged batch
  const queries = [
    {
      query: `INSERT INTO orders (
        order_id, cart_id, confirmation_number, customer_email,
        items, assignments, shipping_address, payment_method,
        subtotal, shipping_cost, tax, total_discounts, total,
        currency, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        orderIdUuid,
        order.cartId,
        order.confirmationNumber,
        order.customerEmail,
        items,
        assignments,
        shippingAddress,
        paymentMethod,
        order.subtotal,
        order.shippingCost,
        order.tax,
        order.totalDiscounts,
        order.total,
        order.currency,
        order.status,
        now,
        now
      ]
    },
    {
      query: `INSERT INTO orders_by_customer (
        customer_email, created_at, order_id, confirmation_number,
        total, currency, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        order.customerEmail,
        now,
        orderIdUuid,
        order.confirmationNumber,
        order.total,
        order.currency,
        order.status
      ]
    },
    {
      query: `INSERT INTO orders_by_confirmation (
        confirmation_number, order_id, customer_email
      ) VALUES (?, ?, ?)`,
      params: [order.confirmationNumber, orderIdUuid, order.customerEmail]
    }
  ];

  await client.batch(queries, { prepare: true, logged: true });

  log.info(`[Activity] Order ${order.orderId} saved to Cassandra`);
}

/**
 * Update order in database
 */
export async function updateOrderInDatabase(
  orderId: string,
  updates: Partial<OrderState>
): Promise<void> {
  log.info(`[Activity] Updating order ${orderId}`, { updates });

  const client = getCassandraClient();
  const orderIdUuid = types.Uuid.fromString(orderId);
  const now = new Date();

  // Update status in orders table if status changed
  if (updates.status) {
    const result = await client.execute(
      `SELECT customer_email, created_at FROM orders WHERE order_id = ?`,
      [orderIdUuid],
      { prepare: true }
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      await client.batch(
        [
          {
            query: `UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?`,
            params: [updates.status, now, orderIdUuid]
          },
          {
            query: `UPDATE orders_by_customer SET status = ? WHERE customer_email = ? AND created_at = ? AND order_id = ?`,
            params: [updates.status, row.customer_email, row.created_at, orderIdUuid]
          }
        ],
        { prepare: true, logged: true }
      );
    } else {
      await client.execute(
        `UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?`,
        [updates.status, now, orderIdUuid],
        { prepare: true }
      );
    }
  }

  // Update assignments
  if (updates.assignments) {
    const assignmentsCql = updates.assignments.map((a) => ({
      assignment_id: a.assignmentId,
      line_item_id: a.lineItemId,
      variant_id: a.variantId,
      supplier_id: a.supplierId,
      supplier_name: a.supplierName || '',
      quantity: a.quantity,
      status: a.status,
      supplier_order_id: a.supplierOrderId || ''
    }));

    await client.execute(
      `UPDATE orders SET assignments = ?, updated_at = ? WHERE order_id = ?`,
      [assignmentsCql, now, orderIdUuid],
      { prepare: true }
    );
  }

  // Update supplier orders
  if (updates.supplierOrders) {
    const supplierOrdersCql = updates.supplierOrders.map((so) => ({
      supplier_order_id: so.supplierOrderId,
      order_id: so.orderId,
      supplier_id: so.supplierId,
      supplier_name: so.supplierName,
      status: so.status,
      items: so.items.map((item) => ({
        assignment_id: item.assignmentId,
        variant_id: item.variantId,
        quantity: item.quantity
      })),
      carrier: so.carrier || '',
      tracking_number: so.trackingNumber || '',
      created_at: so.createdAt,
      updated_at: so.updatedAt,
      rejection_reason: so.rejectionReason || ''
    }));

    await client.execute(
      `UPDATE orders SET supplier_orders = ?, updated_at = ? WHERE order_id = ?`,
      [supplierOrdersCql, now, orderIdUuid],
      { prepare: true }
    );
  }
}

/**
 * Send order status email to customer (console stub for demo)
 */
export async function sendOrderStatusEmail(
  email: string,
  orderId: string,
  status: OrderStatus,
  details?: { trackingNumber?: string; carrier?: string }
): Promise<void> {
  log.info(`[Activity] 📧 [DEMO] Order status email: ${status} to ${email}`);
}

/**
 * Send feedback thank you email (console stub for demo)
 */
export async function sendFeedbackThankYouEmail(email: string, orderId: string): Promise<void> {
  log.info(`[Activity] 📧 [DEMO] Feedback thank-you to ${email}`);
}

/**
 * Resolve supplier assignments — always assigns to 'simulated' supplier
 * (In full platform, this routes through plugin registry)
 */
export async function resolveSupplierAssignments(
  items: OrderLineItem[],
  context: SupplierResolutionContext,
): Promise<SupplierAssignment[]> {
  log.info(`[Activity] Resolving supplier assignments for ${items.length} items`);
  return items.map(() => ({
    supplierId: 'simulated',
    supplierType: 'simulated',
    supplierName: 'Simulated Fulfillment',
  }));
}

export async function indexOrder(doc: Elasticsearch.OrderDocument): Promise<void> {
  const client = getElasticsearchClient();
  await client.index({
    index: ES_INDICES.orders,
    id: doc.orderId,
    document: doc
  });
  log.info(`[Activity] Indexed order ${doc.orderId} to Elasticsearch`);
}

export async function indexSupplierOrder(doc: Elasticsearch.SupplierOrderDocument): Promise<void> {
  const client = getElasticsearchClient();
  await client.index({
    index: ES_INDICES.supplierOrders,
    id: doc.supplierOrderId,
    document: doc
  });
  log.info(`[Activity] Indexed supplier order ${doc.supplierOrderId} to Elasticsearch`);
}

/**
 * Insert a status history entry into order_status_history table
 */
export async function insertStatusHistoryEntry(
  orderId: string,
  entry: { status: string; timestamp: string; note?: string; updatedBy: string }
): Promise<void> {
  const client = getCassandraClient();
  const orderIdUuid = types.Uuid.fromString(orderId);
  const eventTime = new Date(entry.timestamp);
  const timeUuid = types.TimeUuid.fromDate(eventTime);

  await client.execute(
    `INSERT INTO order_status_history (order_id, event_time, id, status, note, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [orderIdUuid, eventTime, timeUuid, entry.status, entry.note ?? null, entry.updatedBy],
    { prepare: true }
  );

  log.info(`[Activity] Inserted status history: ${entry.status} for order ${orderId}`);
}

/**
 * Get orders by customer email
 */
export async function getOrdersByEmail(email: string): Promise<Order[]> {
  const client = getCassandraClient();
  const result = await client.execute(
    `SELECT order_id, confirmation_number, total, currency, status, created_at
     FROM orders_by_customer WHERE customer_email = ?`,
    [email],
    { prepare: true }
  );

  return result.rows.map(row => ({
    orderId: row.order_id.toString(),
    confirmationNumber: row.confirmation_number,
    customerEmail: email,
    total: row.total,
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at?.toISOString() ?? new Date().toISOString(),
  } as unknown as Order));
}

/**
 * Get a single order by ID
 */
export async function getOrderById(orderId: string): Promise<Order | null> {
  const client = getCassandraClient();
  const orderIdUuid = types.Uuid.fromString(orderId);
  const result = await client.execute(
    `SELECT * FROM orders WHERE order_id = ?`,
    [orderIdUuid],
    { prepare: true }
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    orderId: row.order_id.toString(),
    confirmationNumber: row.confirmation_number,
    customerEmail: row.customer_email,
    total: row.total,
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at?.toISOString() ?? new Date().toISOString(),
  } as unknown as Order;
}

/**
 * Start a standalone fulfillment workflow via Temporal client.
 * Uses the same pattern as checkout's startOrderManagementWorkflow.
 */
export async function startFulfillmentWorkflow(input: Record<string, unknown>): Promise<string> {
  const orderId = input.orderId as string;
  const workflowId = `fulfillment-${orderId}`;
  log.info(`[Activity] Starting fulfillment workflow: ${workflowId}`);

  const { getTemporalClient } = await import('../../lib/temporal-client');
  const client = await getTemporalClient();

  await client.workflow.start('fulfillmentWorkflow', {
    taskQueue: 'fulfillment-queue',
    workflowId,
    args: [input],
    workflowExecutionTimeout: '90 days'
  });

  log.info(`[Activity] Started fulfillment workflow: ${workflowId}`);
  return workflowId;
}

export function createOmsActivities() {
  return {
    saveOrderToDatabase,
    updateOrderInDatabase,
    sendOrderStatusEmail,
    sendFeedbackThankYouEmail,
    resolveSupplierAssignments,
    insertStatusHistoryEntry,
    getOrdersByEmail,
    getOrderById,
    indexOrder,
    indexSupplierOrder,
    startFulfillmentWorkflow,
  };
}
