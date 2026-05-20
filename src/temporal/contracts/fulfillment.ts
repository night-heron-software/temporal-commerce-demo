/**
 * Fulfillment Workflow Types
 * Core data structures for the fulfillment workflow
 */

// Re-export ShippingAddress from suppliers (single source of truth)
export type {
  ShippingAddress,
  SupplierStatusUpdate,
  SupplierOrderResult
} from './suppliers';
import type { ShippingAddress, SupplierStatusUpdate } from './suppliers';
import type { SupplierOrderStatus } from './oms';

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
  supplierType: 'simulated';
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
  supplierType: 'simulated';
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


/**
 * Fulfillment Workflow Definitions
 * Signals, queries, and result types
 */

import * as wf from '@temporalio/workflow';


/** Query: get current workflow state */
export const getStatusQuery = wf.defineQuery<FulfillmentWorkflowState>('getStatus');

/** Signal: supplier status update (from webhook or polling) */
export const supplierStatusSignal = wf.defineSignal<[SupplierStatusUpdate]>('supplierStatusUpdate');

/** Signal: cancel fulfillment */
export const cancelSignal = wf.defineSignal('cancel');

/** Per-supplier outcome in the result */
export interface FulfillmentSupplierOrderResult {
  supplierOrderId: string;
  status: FulfillmentOrderStatus;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  shipments?: ShipmentInfo[];
}

/** Workflow result type */
export interface FulfillmentResult {
  status: FulfillmentOrderStatus;
  supplierOrders: FulfillmentSupplierOrderResult[];
  error?: string;
}

/** Workflow ID helpers */
export function fulfillmentIdToWorkflowId(orderId: string): string {
  return `fulfillment-${orderId}`;
}

export function workflowIdToFulfillmentId(workflowId: string): string {
  return workflowId.replace(/^fulfillment-/, '');
}


