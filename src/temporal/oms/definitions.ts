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
import type {
  OrderState,
  UpdateStatusSignal,
  CancelOrderSignal,
  SubmitFeedbackSignal,
  RefundOrderSignal,
  RequestReturnSignal,
  ConfirmReturnSignal,
  DenyReturnSignal,
  FulfillmentStatusUpdate,
} from './types';

// ==================
// OMS Workflow Updates & Queries
// ==================

export const updateStatusUpdate = defineUpdate<OrderState, [UpdateStatusSignal]>('updateStatus');
export const cancelOrderUpdate = defineUpdate<OrderState, [CancelOrderSignal]>('cancelOrder');
export const submitFeedbackUpdate = defineUpdate<OrderState, [SubmitFeedbackSignal]>(
  'submitFeedback',
);
export const refundOrderUpdate = defineUpdate<OrderState, [RefundOrderSignal]>('refundOrder');
export const requestReturnUpdate = defineUpdate<OrderState, [RequestReturnSignal]>('requestReturn');
export const confirmReturnUpdate = defineUpdate<OrderState, [ConfirmReturnSignal]>('confirmReturn');
export const denyReturnUpdate = defineUpdate<OrderState, [DenyReturnSignal]>('denyReturn');
export const getOrderStateQuery = defineQuery<OrderState>('getOrderState');

// Signal for receiving fulfillment status updates from child workflows
export const fulfillmentStatusSignal = defineSignal<[FulfillmentStatusUpdate]>('fulfillmentStatus');
