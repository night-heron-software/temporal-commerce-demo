import { Elasticsearch } from '../contracts';
import type { FulfillmentWorkflowState } from './types';

export function buildFulfillmentDocument(
  state: FulfillmentWorkflowState,
): Elasticsearch.FulfillmentDocument {
  return {
    orderId: state.orderId,
    customerId: state.customerId,
    status: state.status,
    fulfillerOrderCount: state.fulfillerOrders.length,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
}
