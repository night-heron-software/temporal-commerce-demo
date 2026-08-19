/**
 * Cart document-builder tests — the carts ES doc carries the correlation-named join
 * field (`correlationId`, ADR-0011), sourced from the workflow state's cart linkage
 * (the indexCart activity overrides it with the ambient journey correlationId).
 */
import { describe, expect, it } from 'vitest';

import { buildCartDocument } from './document-builder';
import type { CartDetails } from './types';

const cart: CartDetails = {
  cartId: 'cart-1',
  email: 'shopper@example.com',
  items: [{ lineItemId: 'li-1', variantId: 'v1', quantity: 2, price: 1500 }],
  subtotalPrice: 3000,
  totalDiscounts: 0,
  totalTax: 0,
  totalPrice: 3000,
  shippingCost: 0,
  currency: 'USD',
  appliedCoupons: [],
  cartVersion: 3,
  status: 'active',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:05:00.000Z',
};

describe('buildCartDocument', () => {
  it('carries correlationId sourced from the cart linkage (legacy fallback for the activity override)', () => {
    const doc = buildCartDocument(cart, cart.createdAt);
    expect(doc.correlationId).toBe('cart-1');
    expect(doc.cartId).toBe('cart-1');
    expect(doc.itemCount).toBe(1);
    expect(doc.createdAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('maps the display snapshot onto item docs (backlog #1 / R1)', () => {
    const doc = buildCartDocument(
      {
        ...cart,
        items: [
          {
            ...cart.items[0],
            productId: 'p1',
            productTitle: 'California Surf — Tee [Simulated]',
            variantTitle: 'Baby Blue / 4XL',
            optionLabels: ['Baby Blue', '4XL'],
            thumbnailUrl: 'https://img/front.webp',
          },
        ],
      },
      cart.createdAt,
    );
    expect(doc.items[0]).toMatchObject({
      productTitle: 'California Surf — Tee [Simulated]',
      variantTitle: 'Baby Blue / 4XL',
      optionLabels: ['Baby Blue', '4XL'],
      thumbnailUrl: 'https://img/front.webp',
    });
  });
});
