/**
 * Fulfillment Workflow Types
 * Core data structures for the fulfillment workflow
 */

// Re-export ShippingAddress from fulfillers (single source of truth)
export type { ShippingAddress, FulfillerStatusUpdate, FulfillerOrderResult } from './fulfillers';
import type { ShippingAddress, FulfillerStatusUpdate } from './fulfillers';
import type { FulfillerOrderStatus } from './oms';

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

/**
 * Fulfillment Workflow Definitions
 * Signals, queries, and result types
 */

import * as wf from '@temporalio/workflow';

/** Query: get current workflow state */
export const getStatusQuery = wf.defineQuery<FulfillmentWorkflowState>('getStatus');

/** Signal: fulfiller status update (from webhook or polling) */
export const fulfillerStatusSignal =
  wf.defineSignal<[FulfillerStatusUpdate]>('fulfillerStatusUpdate');

/** Signal: cancel fulfillment */
export const cancelSignal = wf.defineSignal('cancel');

/** Per-fulfiller outcome in the result */
export interface FulfillmentFulfillerOrderResult {
  fulfillerOrderId: string;
  status: FulfillmentOrderStatus;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  shipments?: ShipmentInfo[];
}

/** Workflow result type */
export interface FulfillmentResult {
  status: FulfillmentOrderStatus;
  fulfillerOrders: FulfillmentFulfillerOrderResult[];
  error?: string;
}
