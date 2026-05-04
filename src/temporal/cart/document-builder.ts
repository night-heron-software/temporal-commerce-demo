/**
 * Shared Cart Document Builder
 *
 * Builds a CartDocument for Elasticsearch from CartDetails.
 * Used by both the cart workflow (real-time sync) and reindex route (bulk).
 */

import type { CartDetails } from './types';
import { Elasticsearch } from '../contracts';
type CartDocument = Elasticsearch.CartDocument;

/**
 * Builds an ES CartDocument from workflow state.
 * Pure function - no side effects, safe to use in workflow or API context.
 */
export function buildCartDocument(storeId: string, cart: CartDetails, createdAt?: string): CartDocument {
  return {
    storeId,
    cartId: cart.cartId,
    items: cart.items.map((item) => ({
      lineItemId: item.lineItemId,
      variantId: item.variantId,
      quantity: item.quantity,
      price: item.price
    })),
    itemCount: cart.items.length,
    subtotalPrice: cart.subtotalPrice,
    totalPrice: cart.totalPrice,
    currency: cart.currency,
    status: cart.status,
    appliedCoupons: cart.appliedCoupons,
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}
