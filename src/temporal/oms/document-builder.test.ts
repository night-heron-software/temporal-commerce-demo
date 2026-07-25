/**
 * OMS document-builder tests — the ES projection carries the correlation-named join
 * field (`correlationId`, ADR-0011) on order and fulfiller-order docs, sourced from the
 * order record's journey correlationId (its own UUID; domain `cartId` stays a separate
 * field).
 */
import { describe, expect, it } from 'vitest';

import { buildFulfillerOrderDocument, buildOrderDocument } from './document-builder';
import type { FulfillerOrder, Order, OrderState } from './types';

const order: Order = {
  orderId: 'o-1',
  cartId: 'cart-1',
  correlationId: 'corr-1',
  customerEmail: 'jane@example.com',
  items: [{ lineItemId: 'li-1', variantId: 'v-1', quantity: 2, price: 1500 }],
  shippingAddress: {
    firstName: 'Jane',
    lastName: 'Doe',
    address1: '1 Main St',
    city: 'Sandy',
    state: 'UT',
    postalCode: '84070',
    country: 'US',
    email: 'jane@example.com',
  },
  paymentMethod: { type: 'mock', token: 'tok_1', last4: '4242' },
  subtotal: 3000,
  shippingCost: 500,
  tax: 210,
  totalDiscounts: 0,
  total: 3710,
  currency: 'USD',
  status: 'paid',
  createdAt: '2026-07-01T00:00:00.000Z',
  confirmationNumber: 'CONF-1',
};

const fulfillerOrder: FulfillerOrder = {
  fulfillerOrderId: 'fo-1',
  orderId: 'o-1',
  fulfillerId: 'default-fulfiller',
  fulfillerName: 'Default Fulfiller',
  status: 'processing',
  items: [{ assignmentId: 'a-1', variantId: 'v-1', quantity: 2 }],
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:05:00.000Z',
  statusHistory: [{ status: 'pending', timestamp: '2026-07-01T00:00:00.000Z' }],
};

const state: OrderState = {
  order,
  status: 'processing',
  statusHistory: [],
  assignments: [],
  fulfillerOrders: [fulfillerOrder],
};

describe('buildOrderDocument', () => {
  it("carries the order record's journey correlationId (its own UUID, not the cartId)", () => {
    const doc = buildOrderDocument(order, state, order.customerEmail);
    expect(doc.correlationId).toBe('corr-1');
    expect(doc.cartId).toBe('cart-1');
    expect(doc.orderId).toBe('o-1');
  });

  it('stays communication-free — the summaries are joined by the indexOrder activity, not the pure builder', () => {
    const doc = buildOrderDocument(order, state, order.customerEmail);
    expect('communications' in doc).toBe(false);
  });
});

describe('buildFulfillerOrderDocument', () => {
  it('carries the caller-supplied correlationId', () => {
    const doc = buildFulfillerOrderDocument(fulfillerOrder, order.correlationId);
    expect(doc.correlationId).toBe('corr-1');
    expect(doc.fulfillerOrderId).toBe('fo-1');
    expect(doc.orderId).toBe('o-1');
  });

  it('leaves non-terminal fulfiller orders live (no lifecycle fields)', () => {
    const doc = buildFulfillerOrderDocument(fulfillerOrder, order.correlationId);
    expect(doc.workflowStatus).toBeUndefined();
    expect(doc.workflowOutcome).toBeUndefined();
    expect(doc.workflowClosedAt).toBeUndefined();
  });

  it('stamps lifecycle fields at write time for terminal statuses (the owning child closed)', () => {
    const delivered = buildFulfillerOrderDocument(
      { ...fulfillerOrder, status: 'delivered' },
      order.correlationId,
    );
    expect(delivered.workflowStatus).toBe('completed');
    expect(delivered.workflowOutcome).toBe('completed');
    expect(delivered.workflowClosedAt).toBe(fulfillerOrder.updatedAt);

    const rejected = buildFulfillerOrderDocument(
      { ...fulfillerOrder, status: 'rejected' },
      order.correlationId,
    );
    expect(rejected.workflowStatus).toBe('completed');
    expect(rejected.workflowOutcome).toBe('completed');
  });
});
