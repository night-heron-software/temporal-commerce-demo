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
export function buildCartDocument(cart: CartDetails, createdAt?: string): CartDocument {
  return {
    cartId: cart.cartId,
    // Correlation-named join field (ADR-0011). CartDetails only carries the cartId;
    // the indexCart activity overrides this with the ambient journey correlationId,
    // so this value is only the legacy fallback (since #33 they are distinct UUIDs).
    correlationId: cart.cartId,
    email: cart.email,
    userId: cart.userId,
    items: cart.items.map((item) => ({
      lineItemId: item.lineItemId,
      variantId: item.variantId,
      quantity: item.quantity,
      price: item.price,
      productId: item.productId,
      productTitle: item.productTitle,
      variantTitle: item.variantTitle,
      optionLabels: item.optionLabels,
      thumbnailUrl: item.thumbnailUrl,
    })),
    itemCount: cart.items.length,
    subtotalPrice: cart.subtotalPrice,
    totalPrice: cart.totalPrice,
    currency: cart.currency,
    status: cart.status,
    appliedCoupons: cart.appliedCoupons,
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
