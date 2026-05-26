/**
 * Fulfillment Workflow Definitions
 * Signals, queries, and result types
 */

import * as wf from '@temporalio/workflow';
import type {
  FulfillmentWorkflowState,
  FulfillmentOrderStatus,
  ShipmentInfo,
  SupplierStatusUpdate,
  FulfillmentSupplierOrderState
} from './types';

/** Query: get current workflow state */
export const getStatusQuery = wf.defineQuery<FulfillmentWorkflowState>('getStatus');

/** Signal: supplier status update (from webhook or polling) */
export const supplierStatusSignal = wf.defineSignal<[SupplierStatusUpdate]>('supplierStatusUpdate');

/** Signal: child workflow status update */
export const childStatusSignal = wf.defineSignal<[FulfillmentSupplierOrderState]>('childStatusUpdate');

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
