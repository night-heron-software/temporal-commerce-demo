/**
 * Fulfillment Activities — Workflow-safe proxies
 *
 * This file is imported by workflows.ts and runs inside Temporal's
 * deterministic sandbox. It MUST NOT import any Node.js modules or
 * activity implementations directly. All activity access goes through
 * proxyActivities.
 */

import { proxyActivities } from '@temporalio/workflow';
import type { Suppliers } from '../contracts';
import { Elasticsearch } from '../contracts';

export interface FulfillmentActivities {
  getFeatureFlag(name: string): Promise<boolean>;
  submitSupplierOrder(request: Suppliers.SupplierOrderInput): Promise<Suppliers.SupplierOrderResult>;
  buildFulfillmentPayload(input: {
    storeId: string;
    orderId: string;
    items: any[];
    supplierType: string;
    productType: string;
  }): Promise<any>;
  pollSupplierStatus(input: {
    storeId: string;
    supplierOrderId: string;
    supplierType: string;
  }): Promise<Suppliers.SupplierStatusUpdate>;
  lookupSkuMappings(skus: string[], supplier: string): Promise<Record<string, Suppliers.SupplierSkuMapping>>;
  sendShippedEmail(email: string, orderId: string, confirmationNumber: string, trackingInfo: any): Promise<void>;
  sendDeliveredEmail(email: string, orderId: string, confirmationNumber: string): Promise<void>;
  transferInventoryReservations(cartId: string, items: any[]): Promise<void>;
  fulfillInventoryReservations(cartId: string, items: any[]): Promise<void>;
  releaseInventoryReservations(cartId: string, items: any[]): Promise<void>;
  indexFulfillment(doc: Elasticsearch.FulfillmentDocument): Promise<void>;
  indexShipment(doc: Elasticsearch.ShipmentDocument): Promise<void>;
}

export const {
  getFeatureFlag,
  submitSupplierOrder,
  buildFulfillmentPayload,
  pollSupplierStatus,
  lookupSkuMappings,
  sendShippedEmail,
  sendDeliveredEmail,
  transferInventoryReservations,
  fulfillInventoryReservations,
  releaseInventoryReservations,
  indexFulfillment,
  indexShipment
} = proxyActivities<FulfillmentActivities>({
  startToCloseTimeout: '5m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2s',
    backoffCoefficient: 2
  }
});
