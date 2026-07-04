import { Cart } from '../contracts';
export type Order = Cart.Order;

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

// Order lifecycle status (superset of the machine states — includes terminals)
export type OrderStatus =
  | 'pending_assignment'
  | 'assigning_fulfillers'
  | 'requesting_fulfillment'
  | 'ready_to_fulfill'
  | 'processing'
  | 'partially_shipped'
  | 'shipped'
  | 'delivered'
  | 'return_requested'
  | 'cancelled'
  | 'refunded'
  | 'returned'
  | 'complete';

export interface OrderWorkflowInput {
  order: Order;
  customerEmail: string;
  /** Continue-as-new carryover: the full order state to resume from. */
  restoredState?: OrderState;
  signalCount?: number;
}

export interface OrderState {
  order: Order;
  status: OrderStatus;
  /** Set on rejected updates via formatError (never persisted as part of the lifecycle). */
  error?: string;
  updatedAt?: string;
  deliveredAt?: string;
  customerFeedback?: CustomerFeedback;
  statusHistory: StatusHistoryEntry[];
  assignments: OrderAssignment[];
  fulfillerOrders: FulfillerOrder[];
  /** Ledger of refunds applied to this order (supports partial / per-line refunds). */
  refunds?: RefundRecord[];
  /**
   * In-flight return request while the order sits in `return_requested`.
   * Transient workflow state — cleared on confirm (→ `returned`) or deny (→ `delivered`).
   */
  returnRequest?: ReturnRequestRecord;
}

// Assignment of a line item quantity to a fulfiller
export interface OrderAssignment {
  assignmentId: string;
  lineItemId: string;
  variantId: string;
  fulfillerId: string;
  fulfillerName?: string;
  quantity: number;
  status: 'pending' | 'assigned' | 'fulfilled' | 'shipped' | 'delivered' | 'rejected';
  sku?: string;
  /** Resolved fulfiller type (plugin id / 'simulated'), threaded to the fulfillment request. */
  fulfillerType?: string;
  fulfillerOrderId?: string; // Set when order is fulfilled
  carrier?: string; // Shipping carrier (e.g., 'USPS', 'FedEx')
}

// Fulfiller order status type
export type FulfillerOrderStatus =
  | 'pending'
  | 'processing'
  | 'awaiting_tracking'
  | 'shipped'
  | 'delivered'
  | 'rejected';

/**
 * Fulfillment status update received from fulfillment workflows.
 * Used to propagate status changes back to the OMS workflow.
 */
export interface FulfillmentStatusUpdate {
  fulfillerOrderId: string;
  status: FulfillerOrderStatus;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  shipmentDate?: string;
  error?: string;
}

// Represents a group of assignments sent to one fulfiller
export interface FulfillerOrder {
  fulfillerOrderId: string;
  orderId: string;
  fulfillerId: string;
  fulfillerName: string;
  status: FulfillerOrderStatus;
  items: FulfillerOrderItem[];
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  createdAt: string;
  updatedAt: string;
  rejectionReason?: string;
  statusHistory: FulfillerOrderHistoryEntry[];
}

export interface FulfillerOrderHistoryEntry {
  status: FulfillerOrderStatus;
  timestamp: string;
  note?: string;
}

export interface FulfillerOrderItem {
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

// ==================
// Refunds & Returns
// ==================

/** One line-item selection in a refund / return request. */
export interface RefundLineInput {
  lineItemId: string;
  quantity: number;
}

/**
 * A single refund applied to an order — recorded on OrderState for audit and
 * over-refund guarding. Simplified from the mono version: the demo has no per-item
 * economics (markup/commission/fulfiller cost), so only the retail refund and the
 * pro-rated tax are tracked.
 */
export interface RefundRecord {
  refundId: string;
  timestamp: string;
  reason?: string;
  lines: Array<{ lineItemId: string; quantity: number }>;
  /** Aggregate amounts (same currency units as the order totals). */
  refundAmount: number;
  taxAmount: number;
}

/** A pending return recorded on OrderState while the order is in `return_requested`. */
export interface ReturnRequestRecord {
  /** Lines + quantities to return; omit for a full return of all remaining quantity. */
  lines?: RefundLineInput[];
  reason?: string;
  requestedAt: string;
  requestedBy?: 'system' | 'admin' | 'customer';
}

// ==================
// Update payloads
// ==================

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

/** `lines` selects what to refund; omit / empty = full refund of all remaining quantity. */
export interface RefundOrderSignal {
  lines?: RefundLineInput[];
  reason?: string;
  updatedBy?: 'system' | 'admin' | 'customer';
}

/** `lines` selects what to return; omit / empty = full return of all remaining quantity. */
export interface RequestReturnSignal {
  lines?: RefundLineInput[];
  reason?: string;
  updatedBy?: 'system' | 'admin' | 'customer';
}

export interface ConfirmReturnSignal {
  reason?: string;
}

export interface DenyReturnSignal {
  reason?: string;
}

// ==================
// State-machine driver types
// ==================

/** The machine's waiting + transitional states (terminals are `__terminal:` targets). */
export type OrderStateName =
  | 'pending_assignment'
  | 'assigning_fulfillers'
  | 'requesting_fulfillment'
  | 'ready_to_fulfill'
  | 'processing'
  | 'partially_shipped'
  | 'shipped'
  | 'delivered'
  | 'return_requested';

/** Driver event union — one member per admin/customer update. */
export type OrderEvent =
  | {
      type: 'updateStatus';
      status: OrderStatus;
      note?: string;
      updatedBy: 'system' | 'admin' | 'customer';
    }
  | { type: 'cancelOrder'; reason?: string }
  | { type: 'submitFeedback'; rating: 1 | 2 | 3 | 4 | 5; comment?: string }
  | {
      type: 'refundOrder';
      lines?: RefundLineInput[];
      reason?: string;
      updatedBy?: 'system' | 'admin' | 'customer';
    }
  | {
      type: 'requestReturn';
      lines?: RefundLineInput[];
      reason?: string;
      updatedBy?: 'system' | 'admin' | 'customer';
    }
  | { type: 'confirmReturn'; reason?: string }
  | { type: 'denyReturn'; reason?: string };

// Query result type for order status history (used by admin server actions)
export interface StatusHistoryRow {
  orderId: string;
  eventTime: string;
  status: string;
  note: string | null;
  updatedBy: string;
}
