/**
 * Fulfillment document-builder tests — the fulfillments ES doc carries the
 * correlation-named join field (`correlationId`, ADR-0011), sourced from the workflow
 * state's cart linkage.
 */
import { describe, expect, it } from 'vitest';

import { buildFulfillmentDocument } from './document-builder';
import type { FulfillmentWorkflowState } from './types';

const state: FulfillmentWorkflowState = {
  orderId: 'o-1',
  cartId: 'cart-1',
  customerId: 'cust-1',
  status: 'in_production',
  fulfillerOrders: [],
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:05:00.000Z',
};

describe('buildFulfillmentDocument', () => {
  it('carries correlationId sourced from the state cart linkage', () => {
    const doc = buildFulfillmentDocument(state);
    expect(doc.correlationId).toBe('cart-1');
    expect(doc.orderId).toBe('o-1');
    expect(doc.fulfillerOrderCount).toBe(0);
  });
});
