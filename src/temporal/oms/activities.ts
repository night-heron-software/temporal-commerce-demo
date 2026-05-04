/**
 * OMS Activities
 * Activity proxies for workflow use
 */

import { proxyActivities } from '@temporalio/workflow';
import type { Order, OrderState, OrderStatus } from './types';
import { OrderLineItem, SupplierResolutionContext, SupplierAssignment, Elasticsearch } from '../contracts';

export interface OmsActivities {
  saveOrderToDatabase(order: Order): Promise<void>;
  updateOrderInDatabase(storeId: string, orderId: string, updates: Partial<OrderState>): Promise<void>;
  sendOrderStatusEmail(
    email: string,
    orderId: string,
    status: OrderStatus,
    details?: { trackingNumber?: string; carrier?: string }
  ): Promise<void>;
  sendFeedbackThankYouEmail(email: string, orderId: string): Promise<void>;
  getOrdersByEmail(email: string): Promise<Order[]>;
  getOrderById(orderId: string): Promise<Order | null>;
  resolveSupplierAssignments(items: OrderLineItem[], context: SupplierResolutionContext): Promise<SupplierAssignment[]>;
  insertStatusHistoryEntry(
    storeId: string,
    orderId: string,
    entry: { status: string; timestamp: string; note?: string; updatedBy: string }
  ): Promise<void>;
  indexOrder(doc: Elasticsearch.OrderDocument): Promise<void>;
  indexSupplierOrder(doc: Elasticsearch.SupplierOrderDocument): Promise<void>;
}

// Database write activities: order persistence and status tracking
export const {
  saveOrderToDatabase,
  updateOrderInDatabase,
  insertStatusHistoryEntry
} = proxyActivities<OmsActivities>({
  startToCloseTimeout: '1m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1s',
    backoffCoefficient: 2
  }
});

// Elasticsearch projection activities
export const {
  indexOrder,
  indexSupplierOrder
} = proxyActivities<OmsActivities>({
  startToCloseTimeout: '30s',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1s',
    backoffCoefficient: 2
  }
});

// Email activities: longer timeout for external Mailgun API
export const {
  sendOrderStatusEmail,
  sendFeedbackThankYouEmail
} = proxyActivities<OmsActivities>({
  startToCloseTimeout: '2m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1s',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['InvalidRecipientError']
  }
});

// Query/lookup activities: read-only operations
export const {
  getOrdersByEmail,
  getOrderById,
  resolveSupplierAssignments
} = proxyActivities<OmsActivities>({
  startToCloseTimeout: '1m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1s',
    backoffCoefficient: 2
  }
});
