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

/** Shipment tracking details forwarded to the customer's shipped email. */
export interface TrackingInfo {
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string;
}

export interface FulfillmentActivities {
  getFeatureFlag(name: string): Promise<boolean>;
  submitSupplierOrder(request: Suppliers.SupplierOrderInput): Promise<Suppliers.SupplierOrderResult>;
  sendShippedEmail(
    email: string,
    orderId: string,
    confirmationNumber: string,
    trackingInfo: TrackingInfo,
  ): Promise<void>;
  sendDeliveredEmail(email: string, orderId: string, confirmationNumber: string): Promise<void>;
  transferInventoryReservations(
    cartId: string,
    items: Array<{ variantId: string; supplierId: string; quantity: number }>,
  ): Promise<void>;
  fulfillInventoryReservations(cartId: string, items: Array<{ variantId: string }>): Promise<void>;
  releaseInventoryReservations(cartId: string, items: Array<{ variantId: string }>): Promise<void>;
  indexFulfillment(doc: Elasticsearch.FulfillmentDocument): Promise<void>;
  indexShipment(doc: Elasticsearch.ShipmentDocument): Promise<void>;
}

export const {
  getFeatureFlag,
  submitSupplierOrder,
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
