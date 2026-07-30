/**
 * The standalone-activity tagging builder must follow the same no-fallback rule as
 * `buildWorkflowStartOptions` (#33): the CorrelationId attribute carries only a real
 * journey UUID — never a cartId stand-in, which would pollute every correlation query
 * with entities that merely share a cart.
 */
import { describe, expect, it } from 'vitest';

import { buildActivityTypedSearchAttributes } from './activity-tagging';
import { SEARCH_ATTRIBUTE_KEYS } from './constants';

function byKey(pairs: ReturnType<typeof buildActivityTypedSearchAttributes>) {
  return Object.fromEntries(pairs.map((p) => [p.key.name, p.value]));
}

describe('buildActivityTypedSearchAttributes', () => {
  it('never falls back to cartId for the CorrelationId attribute', () => {
    const pairs = buildActivityTypedSearchAttributes({
      storeId: 'demo',
      domain: 'checkout',
      cartId: 'cart-1',
    });

    const attrs = byKey(pairs);
    expect(attrs[SEARCH_ATTRIBUTE_KEYS.cartId]).toBe('cart-1');
    expect(attrs[SEARCH_ATTRIBUTE_KEYS.correlationId]).toBeUndefined();
  });

  it('tags the journey correlationId independently of the cartId', () => {
    const pairs = buildActivityTypedSearchAttributes({
      storeId: 'demo',
      domain: 'checkout',
      correlationId: 'corr-1',
      cartId: 'cart-1',
      orderId: 'order-1',
    });

    const attrs = byKey(pairs);
    expect(attrs[SEARCH_ATTRIBUTE_KEYS.correlationId]).toBe('corr-1');
    expect(attrs[SEARCH_ATTRIBUTE_KEYS.cartId]).toBe('cart-1');
    expect(attrs[SEARCH_ATTRIBUTE_KEYS.orderId]).toBe('order-1');
    expect(attrs[SEARCH_ATTRIBUTE_KEYS.storeId]).toBe('demo');
    expect(attrs[SEARCH_ATTRIBUTE_KEYS.domain]).toBe('checkout');
  });

  it('emits only the provided keys', () => {
    expect(buildActivityTypedSearchAttributes({})).toEqual([]);

    const pairs = buildActivityTypedSearchAttributes({ storeId: 'demo', domain: 'identity' });
    expect(pairs.map((p) => p.key.name).sort()).toEqual([
      SEARCH_ATTRIBUTE_KEYS.domain,
      SEARCH_ATTRIBUTE_KEYS.storeId,
    ]);
  });
});
