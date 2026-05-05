/**
 * Fulfillment Workflow Types
 * Core data structures for the fulfillment workflow
 */

// Re-export ShippingAddress from suppliers (single source of truth)
import { Fulfillment, Suppliers, OMS } from '../contracts';
export type ShippingAddress = Fulfillment.ShippingAddress;
export type SupplierStatusUpdate = Suppliers.SupplierStatusUpdate;
export type SupplierOrderResult = Suppliers.SupplierOrderResult;

type SupplierOrderStatus = OMS.SupplierOrderStatus;

// ============================================================================
// OMS → Fulfillment Request
// ============================================================================

/** Sent from OMS to start fulfillment with pre-decided supplier orders */
export interface FulfillmentOrderRequest {
  orderId: string;
  cartId: string; // Needed for inventory reservation IDs
  customerId: string;
  customerEmail?: string; // For shipping notifications
  confirmationNumber?: string; // Order confirmation # for email subject
  shippingAddress: ShippingAddress;
  shippingMethod?: 'standard' | 'express' | 'economy';
  supplierOrders: FulfillmentSupplierOrderInput[];
}

/** One supplier's portion of the order, pre-decided by the OMS */
export interface FulfillmentSupplierOrderInput {
  supplierOrderId: string; // OMS-generated ID
  supplierId: string;
  supplierType: 'simulated' | 'printify-dynamic' | 'swiftpod';
  items: FulfillmentItem[];
}

export interface FulfillmentItem {
  sku: string;
  productId: string;
  variantId: string;
  quantity: number;
  unitPrice: number; // Cents
  title: string;
}

// ============================================================================
// Fulfillment Status Model
// ============================================================================

export type FulfillmentOrderStatus =
  | 'received'
  | 'validating'
  | 'submitting'
  | 'in_production'
  | 'partially_shipped'
  | 'shipped'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export type FulfillmentLineItemStatus =
  | 'pending'
  | 'submitted'
  | 'in_production'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'failed';

// ============================================================================
// Workflow State
// ============================================================================

export interface FulfillmentWorkflowState {
  orderId: string;
  cartId: string;
  customerId: string;
  customerEmail?: string;
  confirmationNumber?: string;
  status: FulfillmentOrderStatus;
  supplierOrders: FulfillmentSupplierOrderState[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  errorMessage?: string;
}

/** Per-supplier-order execution state */
export interface FulfillmentSupplierOrderState {
  supplierOrderId: string; // OMS ID for signal matching
  supplierId: string;
  supplierType: 'simulated' | 'printify-dynamic' | 'swiftpod';
  items: FulfillmentLineItemState[];
  status: FulfillmentOrderStatus;
  omsStatus?: SupplierOrderStatus; // Mapped status for OMS signaling
  supplierExternalId?: string; // External supplier's order ID (e.g., Printify or SIM-xxx)
  shipments?: ShipmentInfo[];
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  submittedAt?: string;
  shippedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface FulfillmentLineItemState {
  sku: string;
  productId: string;
  quantity: number;
  status: FulfillmentLineItemStatus;
  supplierLineItemId?: string;
}

// ============================================================================
// Shipment Tracking
// ============================================================================

export interface ShipmentInfo {
  shipmentId: string;
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string;
  items: ShipmentItemRef[];
  shippedAt?: string;
  deliveredAt?: string;
}

export interface ShipmentItemRef {
  sku: string;
  quantity: number;
}
