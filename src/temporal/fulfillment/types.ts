/**
 * Fulfillment Workflow Types
 * Core data structures for the fulfillment workflow
 */

// Re-export ShippingAddress from fulfillers (single source of truth)
import { Fulfillment, Fulfillers, OMS } from '../contracts';
export type ShippingAddress = Fulfillment.ShippingAddress;
export type FulfillerStatusUpdate = Fulfillers.FulfillerStatusUpdate;
export type FulfillerOrderResult = Fulfillers.FulfillerOrderResult;

type FulfillerOrderStatus = OMS.FulfillerOrderStatus;

// ============================================================================
// OMS → Fulfillment Request
// ============================================================================

/** Sent from OMS to start fulfillment with pre-decided fulfiller orders */
export interface FulfillmentOrderRequest {
  orderId: string;
  cartId: string; // Needed for inventory reservation IDs
  customerId: string;
  customerEmail?: string; // For shipping notifications
  confirmationNumber?: string; // Order confirmation # for email subject
  shippingAddress: ShippingAddress;
  shippingMethod?: 'standard' | 'express' | 'economy';
  fulfillerOrders: FulfillmentFulfillerOrderInput[];
}

/** One fulfiller's portion of the order, pre-decided by the OMS */
export interface FulfillmentFulfillerOrderInput {
  fulfillerOrderId: string; // OMS-generated ID
  fulfillerId: string;
  fulfillerType: 'simulated';
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
  fulfillerOrders: FulfillmentFulfillerOrderState[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  errorMessage?: string;
}

/** Per-fulfiller-order execution state */
export interface FulfillmentFulfillerOrderState {
  fulfillerOrderId: string; // OMS ID for signal matching
  fulfillerId: string;
  fulfillerType: 'simulated';
  items: FulfillmentLineItemState[];
  status: FulfillmentOrderStatus;
  omsStatus?: FulfillerOrderStatus; // Mapped status for OMS signaling
  fulfillerExternalId?: string; // External fulfiller's order ID (e.g., SIM-xxx)
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
  variantId: string;
  quantity: number;
  status: FulfillmentLineItemStatus;
  fulfillerLineItemId?: string;
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

export type FulfillmentStateName = 'received' | 'in_production';

export type FulfillmentSignal =
  | { kind: 'fulfillerStatus'; update: FulfillerStatusUpdate }
  | { kind: 'cancel' }
  | { kind: 'childStatus'; update: FulfillmentFulfillerOrderState };
