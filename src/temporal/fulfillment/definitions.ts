/**
 * Fulfillment Workflow Definitions
 * Signals, queries, and result types
 */

import * as wf from '@temporalio/workflow';
import type {
  FulfillmentWorkflowState,
  FulfillmentOrderStatus,
  ShipmentInfo,
  FulfillerStatusUpdate,
  FulfillmentFulfillerOrderState,
} from './types';

/** Query: get current workflow state */
export const getStatusQuery = wf.defineQuery<FulfillmentWorkflowState>('getStatus');

/** Signal: fulfiller status update (from webhook or polling) */
export const fulfillerStatusSignal =
  wf.defineSignal<[FulfillerStatusUpdate]>('fulfillerStatusUpdate');

/** Signal: child workflow status update */
export const childStatusSignal =
  wf.defineSignal<[FulfillmentFulfillerOrderState]>('childStatusUpdate');

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
