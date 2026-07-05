import { describe, it, expect } from 'vitest';
import {
  buildWorkflowId,
  parseWorkflowId,
  buildWorkflowStartOptions,
  WORKFLOW_ID_DELIMITER,
  WORKFLOW_DOMAINS,
  WORKFLOW_ENTITY_SLUGS,
  SEARCH_ATTRIBUTE_KEYS,
  DEMO_STORE_ID,
} from './constants';

const STORE = DEMO_STORE_ID;
const CART = 'a1b20000-0000-4000-8000-000000000002';
const ORDER = 'c3d40000-0000-4000-8000-000000000003';

describe('buildWorkflowId', () => {
  it('joins components with the dot delimiter', () => {
    expect(buildWorkflowId(STORE, 'cart', CART)).toBe(
      [STORE, 'cart', CART].join(WORKFLOW_ID_DELIMITER),
    );
  });

  it('accepts reserved singleton slugs as entityId', () => {
    expect(buildWorkflowId(STORE, 'inventory', WORKFLOW_ENTITY_SLUGS.inventoryService)).toBe(
      [STORE, 'inventory', 'service'].join(WORKFLOW_ID_DELIMITER),
    );
  });

  it('throws when a component contains the delimiter (would break parsing)', () => {
    expect(() => buildWorkflowId(`bad${WORKFLOW_ID_DELIMITER}store`, 'cart', CART)).toThrow();
    expect(() => buildWorkflowId(STORE, 'cart', `bad${WORKFLOW_ID_DELIMITER}entity`)).toThrow();
  });

  it('round-trips through parseWorkflowId for every domain', () => {
    for (const domain of WORKFLOW_DOMAINS) {
      const id = buildWorkflowId(STORE, domain, CART);
      expect(parseWorkflowId(id)).toEqual({ storeId: STORE, domain, entityId: CART });
    }
  });
});

describe('parseWorkflowId', () => {
  it('returns null for a string that is not the three-part shape', () => {
    expect(parseWorkflowId('not-an-id')).toBeNull();
    expect(parseWorkflowId('a.b.c.d')).toBeNull();
  });
});

describe('buildWorkflowStartOptions', () => {
  it('builds the workflowId and always tags storeId + domain', () => {
    const opts = buildWorkflowStartOptions({ storeId: STORE, domain: 'cart', entityId: CART });
    expect(opts.workflowId).toBe(buildWorkflowId(STORE, 'cart', CART));
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.storeId]).toEqual([STORE]);
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.domain]).toEqual(['cart']);
    expect(opts.memo.domain).toBe('cart');
  });

  it('defaults correlationId to cartId when not given', () => {
    const opts = buildWorkflowStartOptions({
      storeId: STORE,
      domain: 'checkout',
      entityId: CART,
      cartId: CART,
    });
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.correlationId]).toEqual([CART]);
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.cartId]).toEqual([CART]);
  });

  it('prefers an explicit correlationId over cartId and includes orderId', () => {
    const opts = buildWorkflowStartOptions({
      storeId: STORE,
      domain: 'fulfillment',
      entityId: ORDER,
      correlationId: CART,
      cartId: CART,
      orderId: ORDER,
    });
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.correlationId]).toEqual([CART]);
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.orderId]).toEqual([ORDER]);
  });

  it('omits correlation keys when there is nothing to correlate on', () => {
    const opts = buildWorkflowStartOptions({ storeId: STORE, domain: 'identity', entityId: CART });
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.correlationId]).toBeUndefined();
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.orderId]).toBeUndefined();
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.cartId]).toBeUndefined();
  });

  it('merges caller memo on top of the default domain memo', () => {
    const opts = buildWorkflowStartOptions({
      storeId: STORE,
      domain: 'order',
      entityId: ORDER,
      memo: { confirmationNumber: 'DEMO-123' },
    });
    expect(opts.memo).toEqual({ domain: 'order', confirmationNumber: 'DEMO-123' });
  });
});
