/**
 * Elasticsearch Document Types
 * Types for indexed documents matching the ES mappings
 */

// Price type (shared)
export interface PriceDocument {
  amount: number; // cents
  currency: string;
}

// ── Workflow lifecycle (projection completion) ──

/** How the owning Temporal workflow closed. */
export type WorkflowOutcome = 'completed' | 'canceled' | 'failed';

/**
 * Lifecycle fields stamped onto a projection doc when its owning workflow
 * closes (or, for reservations, when the reservation reaches a terminal
 * domain status). Absence of `workflowStatus` means the doc is live.
 */
export interface WorkflowLifecycleFields {
  workflowStatus?: 'completed';
  workflowOutcome?: WorkflowOutcome;
  workflowClosedAt?: string;
}

/** A pointer to one projection doc to mark completed at workflow close. */
export interface ProjectionRef {
  index: string;
  id: string;
}

/** Indices whose docs carry workflow lifecycle fields. */
export const LIFECYCLE_INDICES = [
  'orders',
  'fulfiller_orders',
  'carts',
  'reservations',
  'fulfillments',
  'shipments',
] as const;

/**
 * Domain statuses that imply the owning workflow has closed, used by the dev reindex
 * route to retro-derive lifecycle fields from Cassandra (the exact close type —
 * completed vs canceled vs failed — is unrecoverable there, so rebuilt docs get
 * `completed`/`canceled` by status). Live writes normally don't consult these — the
 * driver marks docs at actual workflow close — with one exception: fulfiller_orders
 * docs are written by the long-running OMS workflow (not their own child), so
 * buildFulfillerOrderDocument stamps them here the moment the SO status is terminal
 * rather than a month later at OMS close.
 *
 * Note `delivered` is NOT terminal for orders — the order stays open for feedback,
 * refunds, and returns until `complete`.
 */
const TERMINAL_STATUS: Record<string, ReadonlyMap<string, WorkflowOutcome>> = {
  orders: new Map([
    ['cancelled', 'completed'],
    ['refunded', 'completed'],
    ['returned', 'completed'],
    ['complete', 'completed'],
  ]),
  fulfiller_orders: new Map([
    ['delivered', 'completed'],
    ['rejected', 'completed'],
  ]),
  reservations: new Map([
    ['FULFILLED', 'completed'],
    ['RELEASED', 'canceled'],
    ['CANCELLED', 'canceled'],
  ]),
};

/**
 * Derive the lifecycle fields for a reindexed doc from its domain status.
 * Returns `{}` (live) for non-terminal statuses or unknown indices, so callers can
 * always spread the result.
 */
export function deriveLifecycleFromStatus(
  index: 'orders' | 'fulfiller_orders' | 'reservations',
  status: string | null | undefined,
  closedAt?: string,
): WorkflowLifecycleFields {
  const outcome = status != null ? TERMINAL_STATUS[index]?.get(status) : undefined;
  if (!outcome) return {};
  return {
    workflowStatus: 'completed',
    workflowOutcome: outcome,
    workflowClosedAt: closedAt,
  };
}

// Products Index (with nested variants)
export interface ProductDocument {
  id: string;
  name: string;
  sku?: string;
  fulfillerType?: string;
  description?: string;
  type: 'PRINTED' | 'PHYSICAL' | 'DIGITAL';
  brand?: string;
  model?: string;
  price: PriceDocument;
  collectionIds?: string[];
  collectionNames?: string[];
  defaultVariantId?: string;
  defaultVariantImageUrl?: string;
  localDefaultVariantImageUrl?: string;
  variants: VariantDocument[];
  createdAt: string;
  updatedAt: string;
}

// Variant (nested inside ProductDocument)
export interface VariantDocument {
  id: string;
  blankSku: string;
  price: PriceDocument;
  available: boolean;
  options: OptionDocument[];
  images?: Record<string, string>;
}

export interface OptionDocument {
  optionType: string;
  value: {
    type: string;
    name?: string;
    label?: string;
    hex?: string;
  };
}

// Collections Index
export interface CollectionDocument {
  id: string;
  name: string;
  thumbnailUrl?: string;
  productCount: number;
}

// Orders Index
export interface OrderDocument extends WorkflowLifecycleFields {
  orderId: string;
  /** Domain link to the originating cart. */
  cartId: string;
  /**
   * Correlation ID (ADR-0011) — the join field shared by every order-flow index
   * (orders, fulfiller_orders, fulfillments, shipments). Its own UUID minted at cart
   * creation (cartId only for legacy pre-tagging data); never join on `cartId`.
   */
  correlationId: string;
  confirmationNumber: string;
  customerEmail: string;
  customerName: string;
  status: string;
  // Pricing
  subtotal: number;
  shippingCost: number;
  tax: number;
  totalDiscounts: number;
  total: number;
  currency: string;
  // Shipping address
  shippingAddress: OrderShippingAddressDocument;
  // Payment
  paymentMethod: OrderPaymentMethodDocument;
  // Line items
  items: OrderItemDocument[];
  itemCount: number;
  variantIds: string[]; // Flattened for easy lookup
  // Assignments and fulfiller orders
  assignments: OrderAssignmentDocument[];
  fulfillerOrders: OrderFulfillerOrderDocument[];
  // Status tracking
  statusHistory: OrderStatusHistoryDocument[];
  deliveredAt?: string;
  // Customer feedback
  customerFeedback?: OrderCustomerFeedbackDocument;
  // Timestamps
  createdAt: string;
  updatedAt: string;
}

export interface OrderShippingAddressDocument {
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

export interface OrderPaymentMethodDocument {
  type: string;
  last4?: string;
}

export interface OrderItemDocument {
  lineItemId: string;
  variantId: string;
  quantity: number;
  price: number;
}

export interface OrderAssignmentDocument {
  assignmentId: string;
  lineItemId: string;
  variantId: string;
  fulfillerId: string;
  fulfillerName?: string;
  quantity: number;
  status: string;
  fulfillerOrderId?: string;
  carrier?: string;
}

export interface OrderFulfillerOrderDocument {
  fulfillerOrderId: string;
  fulfillerId: string;
  fulfillerName: string;
  status: string;
  itemCount: number;
  carrier?: string;
  trackingNumber?: string;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrderStatusHistoryDocument {
  status: string;
  timestamp: string;
  note?: string;
  updatedBy: string;
}

export interface OrderCustomerFeedbackDocument {
  rating: number;
  comment?: string;
  submittedAt: string;
}

// Customers Index
export interface CustomerDocument {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  totalSpent: number;
  orderCount: number;
  lastOrderAt: string;
}

// Fulfillers Index
export interface FulfillerDocument {
  fulfillerId: string;
  name: string;
  locations: FulfillerLocationDocument[];
}

export interface FulfillerLocationDocument {
  locationId: string;
  name: string;
  cost: number;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isPrimary: boolean;
}

// Inventory Index
export interface InventoryDocument {
  variantId: string;
  totalStock: number;
  reservedStock: number;
  availableStock: number;
  fulfillerCount: number;
  fulfillerLocations: InventoryFulfillerLocationDocument[];
  reservations: InventoryReservationDocument[]; // Item-level reservations only
  reservationIds: string[]; // Flattened for lookup (all reservations)
  cartIds: string[]; // Flattened for lookup (all unique cart IDs)
}

export interface InventoryFulfillerLocationDocument {
  fulfillerId: string;
  fulfillerName: string;
  totalStock: number;
  reservedStock: number;
  orderedStock: number;
  city: string;
  state: string;
  country: string;
  reservations: InventoryReservationDocument[]; // Fulfiller-level reservations
}

export interface InventoryReservationDocument {
  reservationId: string;
  cartId: string;
  quantity: number;
  status: string;
  createdAt: number;
  expiresAt: number | null;
}

// Fulfiller Orders Index
export interface FulfillerOrderDocument extends WorkflowLifecycleFields {
  fulfillerOrderId: string;
  orderId: string;
  /** Correlation ID (ADR-0011) — joinable across all order-flow indices. */
  correlationId: string;
  fulfillerId: string;
  fulfillerName: string;
  status: string;
  items: FulfillerOrderItemDocument[];
  itemCount: number;
  carrier?: string;
  trackingNumber?: string;
  createdAt: string;
  updatedAt: string;
  rejectionReason?: string;
  statusHistory: FulfillerOrderHistoryEntryDocument[];
}

export interface FulfillerOrderItemDocument {
  assignmentId: string;
  variantId: string;
  quantity: number;
}

export interface FulfillerOrderHistoryEntryDocument {
  status: string;
  timestamp: string;
  note?: string;
}

// Carts Index (cart workflow state)
export interface CartItemDocument {
  lineItemId: string;
  variantId: string;
  quantity: number;
  price: number;
}

export interface CartDocument extends WorkflowLifecycleFields {
  cartId: string;
  /**
   * Correlation ID (ADR-0011) — joinable across all order-flow indices. Optional:
   * docs indexed before the carts projection carried it lack the field entirely;
   * readers fall back to cartId.
   */
  correlationId?: string;
  email?: string;
  userId?: string;
  items: CartItemDocument[];
  itemCount: number;
  subtotalPrice: number;
  totalPrice: number;
  currency: string;
  status: string;
  appliedCoupons: string[];
  createdAt: string;
  updatedAt: string;
}

// Reservations Index (inventory reservations)
export interface ReservationDocument extends WorkflowLifecycleFields {
  reservationId: string;
  cartId: string;
  variantId: string;
  quantity: number;
  status: string;
  expiresAt?: string;
  createdAt: string;
}

// Fulfillments Index (fulfillment workflow state)
export interface FulfillmentDocument extends WorkflowLifecycleFields {
  orderId: string;
  /** Correlation ID (ADR-0011) — joinable across all order-flow indices. */
  correlationId: string;
  customerId: string;
  status: string;
  fulfillerOrderCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  errorMessage?: string;
}

// Shipments Index (shipment tracking)
export interface ShipmentDocument extends WorkflowLifecycleFields {
  shipmentId: string;
  orderId: string;
  /** Correlation ID (ADR-0011) — joinable across all order-flow indices. */
  correlationId: string;
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string;
  itemCount: number;
  shippedAt?: string;
  deliveredAt?: string;
}

// Index names
export const ES_INDICES = {
  products: 'products',
  collections: 'collections',
  orders: 'orders',
  customers: 'customers',
  fulfillers: 'fulfillers',
  inventory: 'inventory',
  fulfillerOrders: 'fulfiller_orders',
  carts: 'carts',
  reservations: 'reservations',
  fulfillments: 'fulfillments',
  shipments: 'shipments',
} as const;
