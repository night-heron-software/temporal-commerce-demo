import { Elasticsearch } from '../contracts';
import type { FulfillmentWorkflowState } from './types';

export function buildFulfillmentDocument(
  state: FulfillmentWorkflowState,
): Elasticsearch.FulfillmentDocument {
  return {
    orderId: state.orderId,
    // Correlation-named join field (ADR-0011); the value is sourced from the cart linkage.
    correlationId: state.cartId,
    customerId: state.customerId,
    status: state.status,
    fulfillerOrderCount: state.fulfillerOrders.length,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}
