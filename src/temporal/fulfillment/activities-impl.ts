import { heartbeat } from '@temporalio/activity';
import { logger, getElasticsearchClient } from '../../lib';
import type { Fulfillers, Elasticsearch } from '../contracts';
import type { TrackingInfo } from './activities';
import { ES_INDICES } from '../contracts/elasticsearch';
import { getFlag } from '../../lib/feature-flags';
import { InventoryCommandRepository } from '../inventory/db/inventory-command-repository';
import { buildReservationId } from '../contracts/inventory';

export async function getFeatureFlag(name: string): Promise<boolean> {
  return getFlag(name);
}

export async function submitFulfillerOrder(
  request: Fulfillers.FulfillerOrderInput,
): Promise<Fulfillers.FulfillerOrderResult> {
  heartbeat('Submitting order to fulfiller');
  logger.info({ fulfillerType: request.fulfillerType }, 'submitFulfillerOrder called');

  // Demo: always simulate success
  return {
    success: true,
    fulfillerOrderId: `SIM-${Date.now()}`,
  };
}

export async function sendShippedEmail(
  email: string,
  orderId: string,
  confirmationNumber: string,
  trackingInfo: TrackingInfo,
): Promise<void> {
  logger.info({ email, orderId, trackingInfo }, '📧 [DEMO] Shipped notification');
}

export async function sendDeliveredEmail(
  email: string,
  orderId: string,
  _confirmationNumber: string,
): Promise<void> {
  logger.info({ email, orderId }, '📧 [DEMO] Delivered notification');
}

export async function transferInventoryReservations(
  cartId: string,
  items: Array<{ variantId: string; fulfillerId: string; quantity: number }>,
): Promise<void> {
  logger.info(
    { cartId, itemCount: items.length },
    'Transferring inventory reservations to fulfillers',
  );

  for (const item of items) {
    const reservationId = buildReservationId(cartId, item.variantId);
    await InventoryCommandRepository.transferToFulfiller(
      reservationId,
      item.fulfillerId,
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
    const reservationId = buildReservationId(cartId, item.variantId);
    await InventoryCommandRepository.fulfill(reservationId);

    // Remove reservation doc from ES
    await esClient
      .delete({
        index: ES_INDICES.reservations,
        id: reservationId,
      })
      .catch(() => {
        /* ignore if not found */
      });
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
    const reservationId = buildReservationId(cartId, item.variantId);
    // cancel() handles CONFIRMED reservations, release() handles TEMPORARY
    const reservation = await InventoryCommandRepository.getReservation(reservationId);
    if (!reservation) continue;

    if (reservation.status === 'CONFIRMED') {
      await InventoryCommandRepository.cancel(reservationId);
    } else if (reservation.status === 'TEMPORARY') {
      await InventoryCommandRepository.release(reservationId);
    }

    // Remove reservation doc from ES
    await esClient
      .delete({
        index: ES_INDICES.reservations,
        id: reservationId,
      })
      .catch(() => {
        /* ignore if not found */
      });
  }

  logger.info({ cartId }, 'Inventory reservations released');
}

export function createFulfillmentActivities() {
  return {
    getFeatureFlag,
    submitFulfillerOrder,
    sendShippedEmail,
    sendDeliveredEmail,
    transferInventoryReservations,
    fulfillInventoryReservations,
    releaseInventoryReservations,
    indexFulfillment,
    indexShipment,
  };
}

export async function indexFulfillment(doc: Elasticsearch.FulfillmentDocument): Promise<void> {
  const client = getElasticsearchClient();
  await client.index({
    index: ES_INDICES.fulfillments,
    id: doc.orderId,
    document: doc,
  });
}

export async function indexShipment(doc: Elasticsearch.ShipmentDocument): Promise<void> {
  const client = getElasticsearchClient();
  await client.index({
    index: ES_INDICES.shipments,
    id: doc.shipmentId,
    document: doc,
  });
}
