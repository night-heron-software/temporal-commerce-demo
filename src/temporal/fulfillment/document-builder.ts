
import { Elasticsearch } from '../contracts';

export function buildFulfillmentDocument(state: any): Elasticsearch.FulfillmentDocument {
  return {
    orderId: state.orderId,
    customerId: state.customerId,
    status: state.status,
    supplierOrderCount: 0,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
}
