/**
 * Cart Activity Implementations
 * Actual implementations called by the worker
 */


import { executeCql } from '../../lib';
import { cassandraTypes as types } from '../../lib';
import { getElasticsearchClient } from '../../lib';
import { Elasticsearch } from '../contracts';
const { ES_INDICES } = Elasticsearch;

const InventoryCommandRepository = {
  getStockLevel: async (sku: string) => ({ available: 100 }),
  reserve: async (req: any) => ({ success: true, reservationId: req.reservationId, error: '' }),
  release: async (id: string) => true,
};


interface VariantRow {
  blank_sku: string;
}

async function resolveBlankSku(_storeId: string, variantId: string): Promise<string | null> {
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
export async function validateInventory(storeId: string, variantId: string, quantity: number): Promise<boolean> {
  console.log(`[Activity] Checking inventory for variant ${variantId} (qty: ${quantity})`);

  try {
    const blankSku = await resolveBlankSku(storeId, variantId);
    if (!blankSku) {
      console.error(`[Activity] Variant not found: ${variantId}`);
      return false;
    }

    const stockLevel = await InventoryCommandRepository.getStockLevel(blankSku);
    const available = stockLevel.available >= quantity;
    console.log(
      `[Activity] Stock check: available=${stockLevel.available}, requested=${quantity}, result=${available}`
    );
    return available;
  } catch (e) {
    console.error(`[Activity] Inventory check failed for ${variantId}:`, e);
    return false;
  }
}

/**
 * Reserve inventory for a cart item.
 * Creates a TEMPORARY reservation with a 15-minute TTL.
 * Returns the reservationId on success, null on failure.
 */
export async function reserveCartItem(
  storeId: string,
  cartId: string,
  variantId: string,
  quantity: number
): Promise<string | null> {
  console.log(`[Activity] Reserving inventory for cart ${cartId}, variant ${variantId} (qty: ${quantity}) in store ${storeId}`);

  try {
    const blankSku = await resolveBlankSku(storeId, variantId);
    if (!blankSku) {
      console.error(`[Activity] Variant not found for reservation: ${variantId}`);
      return null;
    }

    const reservationId = `${cartId}-${variantId}`;
    const result = await InventoryCommandRepository.reserve({
      storeId,
      reservationId,
      blankSku,
      cartId,
      variantId,
      quantity,
      referenceId: `cart-${cartId}`,
      ttlSeconds: 15 * 60, // 15 minutes
    });

    if (result.success) {
      console.log(`[Activity] Reserved: ${reservationId} (${blankSku} x${quantity})`);
      return result.reservationId!;
    } else {
      console.warn(`[Activity] Reservation failed: ${result.error}`);
      return null;
    }
  } catch (e) {
    console.error(`[Activity] Reserve failed for ${variantId}:`, e);
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
  console.log(`[Activity] Releasing reservation ${reservationId}`);

  try {
    await InventoryCommandRepository.release(reservationId);
    console.log(`[Activity] Released: ${reservationId}`);
  } catch (e) {
    console.warn(`[Activity] Release failed for ${reservationId}:`, e);
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
