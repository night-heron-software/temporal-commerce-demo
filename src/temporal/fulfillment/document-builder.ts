
import { Elasticsearch } from '../contracts';

export function buildFulfillmentDocument(storeId: string, state: any): Elasticsearch.FulfillmentDocument {
  return {
    storeId,
    orderId: state.orderId,
    customerId: state.customerId,
    status: state.status,
    supplierOrderCount: 0,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
}
