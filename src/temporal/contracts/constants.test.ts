import { describe, it, expect } from 'vitest';
import {
  buildWorkflowId,
  parseWorkflowId,
  buildWorkflowStartOptions,
  requireCorrelationId,
  WORKFLOW_ID_DELIMITER,
  WORKFLOW_DOMAINS,
  WORKFLOW_ENTITY_SLUGS,
  SEARCH_ATTRIBUTE_KEYS,
  DEMO_STORE_ID,
} from './constants';

const STORE = DEMO_STORE_ID;
const CART = 'a1b20000-0000-4000-8000-000000000002';
const ORDER = 'c3d40000-0000-4000-8000-000000000003';
// The journey correlationId is its own UUID (minted at cart creation) — deliberately ≠ CART.
const CORRELATION = 'e5f60000-0000-4000-8000-000000000004';

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
    const opts = buildWorkflowStartOptions({
      storeId: STORE,
      domain: 'cart',
      entityId: CART,
      correlationId: CORRELATION,
    });
    expect(opts.workflowId).toBe(buildWorkflowId(STORE, 'cart', CART));
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.storeId]).toEqual([STORE]);
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.domain]).toEqual(['cart']);
    expect(opts.memo.domain).toBe('cart');
  });

  it('carries the caller-minted correlationId — its own UUID, never defaulted from cartId', () => {
    const opts = buildWorkflowStartOptions({
      storeId: STORE,
      domain: 'checkout',
      entityId: CART,
      correlationId: CORRELATION,
      cartId: CART,
    });
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.correlationId]).toEqual([CORRELATION]);
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.cartId]).toEqual([CART]);
  });

  it('throws on a falsy-but-defined correlationId instead of silently dropping it (ADR-0031)', () => {
    // The silent `if (correlationId)` drop produced an untagged workflow no visibility sweep
    // could find. An empty string is a threading bug, not an opt-out — `undefined` is the
    // documented opt-out and stays working (see the test below).
    expect(() =>
      buildWorkflowStartOptions({
        storeId: STORE,
        domain: 'checkout',
        entityId: CART,
        correlationId: '',
        cartId: CART,
      }),
    ).toThrow(/empty correlationId/);
  });

  it('does NOT fall back to cartId when correlationId is explicitly opted out', () => {
    const opts = buildWorkflowStartOptions({
      storeId: STORE,
      domain: 'fulfillment',
      entityId: ORDER,
      correlationId: undefined,
      cartId: CART,
      orderId: ORDER,
    });
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.correlationId]).toBeUndefined();
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.cartId]).toEqual([CART]);
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.orderId]).toEqual([ORDER]);
  });

  it('omits correlation keys when there is nothing to correlate on (service singletons)', () => {
    const opts = buildWorkflowStartOptions({
      storeId: STORE,
      domain: 'identity',
      entityId: CART,
      correlationId: undefined,
    });
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.correlationId]).toBeUndefined();
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.orderId]).toBeUndefined();
    expect(opts.searchAttributes[SEARCH_ATTRIBUTE_KEYS.cartId]).toBeUndefined();
  });

  it('merges caller memo on top of the default domain memo', () => {
    const opts = buildWorkflowStartOptions({
      storeId: STORE,
      domain: 'order',
      entityId: ORDER,
      correlationId: CORRELATION,
      memo: { confirmationNumber: 'DEMO-123' },
    });
    expect(opts.memo).toEqual({ domain: 'order', confirmationNumber: 'DEMO-123' });
  });
});

describe('requireCorrelationId (ADR-0031)', () => {
  it('returns the value when present', () => {
    expect(requireCorrelationId(CORRELATION, 'test site')).toBe(CORRELATION);
  });

  it('throws naming the site when the journey key is missing — never falls back', () => {
    // Replaces the `?? cartId` child-start fallbacks. Under the welded model those were
    // no-ops; decoupled they would file a journey under the WRONG key, which is worse than
    // orphaning — an orphan is visible as an absence, a mis-filed journey looks real.
    expect(() => requireCorrelationId(undefined, 'checkout child start')).toThrow(
      /No CorrelationId available for checkout child start/,
    );
    expect(() => requireCorrelationId('', 'reservation document')).toThrow(/reservation document/);
  });
});
