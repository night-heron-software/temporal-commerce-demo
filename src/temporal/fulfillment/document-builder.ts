import { Elasticsearch } from '../contracts';
import type { FulfillmentWorkflowState } from './types';

export function buildFulfillmentDocument(
  state: FulfillmentWorkflowState,
): Elasticsearch.FulfillmentDocument {
  return {
    orderId: state.orderId,
    // Correlation-named join field (ADR-0011). The workflow state only carries the cart
    // linkage; the indexFulfillment activity overrides this with the ambient journey
    // correlationId, so this value is only the legacy fallback.
    correlationId: state.cartId,
    customerId: state.customerId,
    status: state.status,
    fulfillerOrderCount: state.fulfillerOrders.length,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}
