import { heartbeat } from "@temporalio/activity";
import { logger, getElasticsearchClient } from '../../lib';
import type { Suppliers, Elasticsearch } from '../contracts';
import { ES_INDICES } from '../contracts/elasticsearch';
import { getFlag } from '../../lib/feature-flags';
import { InventoryCommandRepository } from '../inventory/db/inventory-command-repository';

export async function getFeatureFlag(name: string): Promise<boolean> {
  return getFlag(name);
}

export async function submitSupplierOrder(
  request: Suppliers.SupplierOrderInput,
): Promise<Suppliers.SupplierOrderResult> {
  heartbeat("Submitting order to supplier");
  logger.info(
    { supplierType: request.supplierType },
    "submitSupplierOrder called",
  );

  // Demo: always simulate success
  return {
    success: true,
    supplierOrderId: `SIM-${Date.now()}`,
  };
}

export async function buildFulfillmentPayload(
  input: {
    orderId: string;
    items: any[];
    supplierType: string;
    productType: string;
  },
): Promise<any> {
  // Demo: simulated fulfillment — no plugin registry needed
  return { defaultPayload: true, items: input.items };
}

export async function pollSupplierStatus(input: {
  supplierOrderId: string;
  supplierType: string;
}): Promise<Suppliers.SupplierStatusUpdate> {
  logger.info({ input }, "pollSupplierStatus");
  return {
    supplierOrderId: input.supplierOrderId,
    status: "in_production",
    timestamp: new Date().toISOString(),
  };
}

export async function lookupSkuMappings(
  skus: string[],
  supplier: string,
): Promise<Record<string, Suppliers.SupplierSkuMapping>> {
  return {};
}

interface TrackingInfo {
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string;
}

export async function sendShippedEmail(
  email: string,
  orderId: string,
  confirmationNumber: string,
  trackingInfo: TrackingInfo,
): Promise<void> {
  logger.info({ email, orderId, trackingInfo }, "📧 [DEMO] Shipped notification");
}

export async function sendDeliveredEmail(
  email: string,
  orderId: string,
  confirmationNumber: string,
): Promise<void> {
  logger.info({ email, orderId }, "📧 [DEMO] Delivered notification");
}

export async function transferInventoryReservations(
  cartId: string,
  items: Array<{ variantId: string; supplierId: string; quantity: number }>,
): Promise<void> {
  logger.info({ cartId, itemCount: items.length }, 'Transferring inventory reservations to suppliers');

  for (const item of items) {
    const reservationId = `${cartId}-${item.variantId}`;
    await InventoryCommandRepository.transferToSupplier(
      reservationId,
      item.supplierId,
      item.quantity,
    );
  }

  logger.info({ cartId }, 'Inventory reservations transferred');
}

export async function fulfillInventoryReservations(
  cartId: string,
  items: Array<{ variantId: string }>,
): Promise<void> {
  logger.info({ cartId, itemCount: items.length }, 'Fulfilling inventory reservations');
  const esClient = getElasticsearchClient();

  for (const item of items) {
    const reservationId = `${cartId}-${item.variantId}`;
    await InventoryCommandRepository.fulfill(reservationId);

    // Remove reservation doc from ES
    await esClient.delete({
      index: ES_INDICES.reservations,
      id: reservationId,
    }).catch(() => { /* ignore if not found */ });
  }

  logger.info({ cartId }, 'Inventory reservations fulfilled');
}

export async function releaseInventoryReservations(
  cartId: string,
  items: Array<{ variantId: string }>,
): Promise<void> {
  logger.info({ cartId, itemCount: items.length }, 'Releasing inventory reservations');
  const esClient = getElasticsearchClient();

  for (const item of items) {
    const reservationId = `${cartId}-${item.variantId}`;
    // cancel() handles CONFIRMED reservations, release() handles TEMPORARY
    const reservation = await InventoryCommandRepository.getReservation(reservationId);
    if (!reservation) continue;

    if (reservation.status === 'CONFIRMED') {
      await InventoryCommandRepository.cancel(reservationId);
    } else if (reservation.status === 'TEMPORARY') {
      await InventoryCommandRepository.release(reservationId);
    }

    // Remove reservation doc from ES
    await esClient.delete({
      index: ES_INDICES.reservations,
      id: reservationId,
    }).catch(() => { /* ignore if not found */ });
  }

  logger.info({ cartId }, 'Inventory reservations released');
}

export function createFulfillmentActivities() {
  return {
    getFeatureFlag,
    submitSupplierOrder,
    pollSupplierStatus,
    lookupSkuMappings,
    sendShippedEmail,
    sendDeliveredEmail,
    transferInventoryReservations,
    fulfillInventoryReservations,
    releaseInventoryReservations,
    indexFulfillment,
    indexShipment,
    buildFulfillmentPayload,
  };
}

export async function indexFulfillment(
  doc: Elasticsearch.FulfillmentDocument,
): Promise<void> {
  const client = getElasticsearchClient();
  await client.index({
    index: ES_INDICES.fulfillments,
    id: doc.orderId,
    document: doc,
  });
}

export async function indexShipment(
  doc: Elasticsearch.ShipmentDocument,
): Promise<void> {
  const client = getElasticsearchClient();
  await client.index({
    index: ES_INDICES.shipments,
    id: doc.shipmentId,
    document: doc,
  });
}
