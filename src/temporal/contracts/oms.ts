import { Order } from './cart';

/**
 * OrderLineItem contains the complete snapshot of a line item at order time.
 * Unlike CartItem (which just holds variantId), this captures all display
 * and versioning information needed to show the order to customers/admins
 * even if the source product/variant changes or is deleted.
 */
export interface OrderLineItem {
  // Identity
  lineItemId: string;
  variantId: string;
  productId: string;
  quantity: number;

  // Snapshot data (captured at checkout)
  productTitle: string;
  variantTitle: string; // e.g., "Large / Navy Blue"
  optionLabels: string[]; // ["Size: L", "Color: Navy Blue"]
  unitPrice: number;
  currency: string;

  // Versioning
  productVersion: number;
  variantVersion: number;
  snapshotTimestamp: string; // ISO timestamp

  // Media (S3 paths for permanent storage)
  thumbnailUrl: string; // Original URL at order time
  thumbnailS3Key?: string; // Persisted copy: order-snapshots/{orderId}/{lineItemId}.jpg
}

// Order lifecycle status
export type OrderStatus =
  | 'pending_assignment'
  | 'ready_to_fulfill'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'
  | 'complete';

export interface OrderWorkflowInput {
  order: Order;
  customerEmail: string;
  restoredState?: OrderState;
  signalCount?: number;
}

export interface OrderState {
  order: Order;
  status: OrderStatus;
  updatedAt?: string;
  deliveredAt?: string;
  customerFeedback?: CustomerFeedback;
  statusHistory: StatusHistoryEntry[];
  assignments: OrderAssignment[];
  supplierOrders: SupplierOrder[];
}

// Assignment of a line item quantity to a supplier
export interface OrderAssignment {
  assignmentId: string;
  lineItemId: string;
  variantId: string;
  supplierId: string;
  supplierName?: string;
  quantity: number;
  status: 'pending' | 'assigned' | 'fulfilled' | 'shipped' | 'delivered' | 'rejected';
  supplierOrderId?: string; // Set when order is fulfilled
  carrier?: string; // Shipping carrier (e.g., 'USPS', 'FedEx')
}

// Supplier order status type
export type SupplierOrderStatus =
  | 'pending'
  | 'processing'
  | 'awaiting_tracking'
  | 'shipped'
  | 'delivered'
  | 'rejected';

/**
 * Fulfillment status update received from child fulfillment workflows.
 * Used to propagate status changes back to the parent OMS workflow.
 */
export interface FulfillmentStatusUpdate {
  supplierOrderId: string;
  status: SupplierOrderStatus;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  shipmentDate?: string;
  error?: string;
}

// Represents a group of assignments sent to one supplier
export interface SupplierOrder {
  supplierOrderId: string;
  orderId: string;
  supplierId: string;
  supplierName: string;
  status: SupplierOrderStatus;
  items: SupplierOrderItem[];
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  createdAt: string;
  updatedAt: string;
  rejectionReason?: string;
  statusHistory: SupplierOrderHistoryEntry[];
}

export interface SupplierOrderHistoryEntry {
  status: SupplierOrderStatus;
  timestamp: string;
  note?: string;
}

export interface SupplierOrderItem {
  assignmentId: string;
  variantId: string;
  quantity: number;
}

export interface CustomerFeedback {
  rating: 1 | 2 | 3 | 4 | 5;
  comment?: string;
  submittedAt: string;
}

export interface StatusHistoryEntry {
  status: OrderStatus;
  timestamp: string;
  note?: string;
  updatedBy: 'system' | 'admin' | 'customer';
}

// Update signals
export interface UpdateStatusSignal {
  status: OrderStatus;
  note?: string;
  updatedBy: 'system' | 'admin' | 'customer';
}

export interface SubmitFeedbackSignal {
  rating: 1 | 2 | 3 | 4 | 5;
  comment?: string;
}

export interface CancelOrderSignal {
  reason?: string;
}

// Re-export types needed by OMS
export type { Order } from './cart';

// Query result type for order status history (used by admin server actions)
export interface StatusHistoryRow {
  orderId: string;
  eventTime: string;
  status: string;
  note: string | null;
  updatedBy: string;
}


/**
 * OMS Workflow Definitions
 * 
 * This file contains ONLY query, signal, and update definitions.
 * These can be safely imported by Next.js server actions without pulling in
 * workflow implementations or activities.
 * 
 * IMPORTANT: Do NOT import workflow implementations or activities in this file.
 */

import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';


// ==================
// OMS Workflow Updates & Queries
// ==================

export const updateStatusUpdate = defineUpdate<OrderState, [UpdateStatusSignal]>('updateStatus');
export const cancelOrderUpdate = defineUpdate<OrderState, [CancelOrderSignal]>('cancelOrder');
export const submitFeedbackUpdate = defineUpdate<OrderState, [SubmitFeedbackSignal]>(
  'submitFeedback'
);
export const getOrderStateQuery = defineQuery<OrderState>('getOrderState');

// Signal for receiving fulfillment status updates from child workflows
export const fulfillmentStatusSignal = defineSignal<[FulfillmentStatusUpdate]>('fulfillmentStatus');



