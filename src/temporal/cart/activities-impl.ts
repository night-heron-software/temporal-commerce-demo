/**
 * Cart Activity Implementations
 * Wired to real InventoryCommandRepository for Cassandra-backed inventory
 */

import { InventoryCommandRepository } from '../inventory/db/inventory-command-repository';
import { executeCql } from '../../lib';
import { cassandraTypes as types } from '../../lib';
import { getElasticsearchClient } from '../../lib';
import { logger } from '../../lib';
import { Elasticsearch } from '../contracts';
const { ES_INDICES } = Elasticsearch;

interface VariantRow {
  blank_sku: string;
}

async function resolveBlankSku(variantId: string): Promise<string | null> {
  const variants = await executeCql<VariantRow>(
    `SELECT blank_sku FROM variants WHERE id = ?`,
    [types.Uuid.fromString(variantId)]
  );
  if (variants.length > 0) return variants[0].blank_sku;

  return null;
}

/**
 * Validate that requested quantity is available for an item.
 * Reads from inventory_stock_w via InventoryCommandRepository.
 */
export async function validateInventory(variantId: string, quantity: number): Promise<boolean> {
  logger.info({ variantId, quantity }, 'Checking inventory');

  try {
    const blankSku = await resolveBlankSku(variantId);
    if (!blankSku) {
      logger.error({ variantId }, 'Variant not found');
      return false;
    }

    const stockLevel = await InventoryCommandRepository.getStockLevel(blankSku);
    const available = stockLevel.available >= quantity;
    logger.info(
      { blankSku, available: stockLevel.available, requested: quantity, result: available },
      'Stock check complete'
    );
    return available;
  } catch (e) {
    logger.error({ variantId, err: e }, 'Inventory check failed');
    return false;
  }
}

/**
 * Reserve inventory for a cart item.
 * Creates a TEMPORARY reservation with a 15-minute TTL via real InventoryCommandRepository.
 * Returns the reservationId on success, null on failure.
 */
export async function reserveCartItem(
  cartId: string,
  variantId: string,
  quantity: number
): Promise<string | null> {
  logger.info({ cartId, variantId, quantity }, 'Reserving inventory for cart item');

  try {
    const blankSku = await resolveBlankSku(variantId);
    if (!blankSku) {
      logger.error({ variantId }, 'Variant not found for reservation');
      return null;
    }

    const reservationId = `${cartId}-${variantId}`;
    const result = await InventoryCommandRepository.reserve({
      reservationId,
      blankSku,
      cartId,
      variantId,
      quantity,
      referenceId: `cart-${cartId}`,
      ttlSeconds: 15 * 60, // 15 minutes
    });

    if (result.success) {
      logger.info({ reservationId, blankSku, quantity }, 'Reserved inventory');
      return result.reservationId!;
    } else {
      logger.warn({ blankSku, error: result.error }, 'Reservation failed');
      return null;
    }
  } catch (e) {
    logger.error({ variantId, err: e }, 'Reserve failed');
    return null;
  }
}

/**
 * Release an inventory reservation (item removed from cart or quantity reduced).
 */
export async function releaseCartItem(
  cartId: string,
  variantId: string
): Promise<void> {
  const reservationId = `${cartId}-${variantId}`;
  logger.info({ reservationId }, 'Releasing reservation');

  try {
    await InventoryCommandRepository.release(reservationId);
    logger.info({ reservationId }, 'Released reservation');
  } catch (e) {
    logger.warn({ reservationId, err: e }, 'Release failed');
  }
}

export async function indexCart(doc: Elasticsearch.CartDocument): Promise<void> {
  const client = getElasticsearchClient();
  await client.index({
    index: ES_INDICES.carts,
    id: doc.cartId,
    document: doc
  });
}

export async function deleteCart(cartId: string): Promise<void> {
  const client = getElasticsearchClient();
  await client
    .delete({
      index: ES_INDICES.carts,
      id: cartId
    })
    .catch(() => {
      /* ignore if not found */
    });
}
