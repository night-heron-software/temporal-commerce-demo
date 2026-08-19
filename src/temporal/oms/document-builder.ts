/**
 * Shared OMS Document Builders
 *
 * Builds OrderDocument and FulfillerOrderDocument for Elasticsearch.
 * Used by both the order workflow (real-time sync) and reindex route (bulk).
 */

import type { OrderState, Order, FulfillerOrder } from './types';
import { Elasticsearch } from '../contracts';
// Direct module import (not the contracts barrel): this is the builder's only runtime
// value from contracts — the barrel would drag cart.ts's module-scope defineUpdate into
// every consumer's import graph (breaking workflow-mocked tests).
import { deriveLifecycleFromStatus } from '../contracts/elasticsearch';
type OrderDocument = Elasticsearch.OrderDocument;
type FulfillerOrderDocument = Elasticsearch.FulfillerOrderDocument;

/**
 * Builds an ES OrderDocument from workflow state.
 * Pure function - no side effects, safe to use in workflow or API context.
 */
export function buildOrderDocument(
  order: Order,
  state: OrderState,
  customerEmail: string,
): OrderDocument {
  return {
    orderId: order.orderId,
    cartId: order.cartId,
    // The journey's correlationId (ADR-0011) — its own UUID carried on the order record.
    correlationId: order.correlationId,
    confirmationNumber: order.confirmationNumber,
    customerEmail,
    customerName: `${order.shippingAddress.firstName} ${order.shippingAddress.lastName}`,
    status: state.status,
    subtotal: order.subtotal,
    shippingCost: order.shippingCost,
    tax: order.tax,
    totalDiscounts: order.totalDiscounts,
    total: order.total,
    currency: order.currency,
    shippingAddress: {
      firstName: order.shippingAddress.firstName,
      lastName: order.shippingAddress.lastName,
      address1: order.shippingAddress.address1,
      address2: order.shippingAddress.address2,
      city: order.shippingAddress.city,
      state: order.shippingAddress.state,
      postalCode: order.shippingAddress.postalCode,
      country: order.shippingAddress.country,
      phone: order.shippingAddress.phone,
      email: order.shippingAddress.email,
    },
    paymentMethod: {
      type: order.paymentMethod.type,
      last4: order.paymentMethod.last4,
    },
    items: order.items.map((item) => ({
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
    itemCount: order.items.length,
    variantIds: order.items.map((item) => item.variantId),
    assignments: state.assignments.map((a) => ({
      assignmentId: a.assignmentId,
      lineItemId: a.lineItemId,
      variantId: a.variantId,
      fulfillerId: a.fulfillerId,
      fulfillerName: a.fulfillerName,
      quantity: a.quantity,
      status: a.status,
      fulfillerOrderId: a.fulfillerOrderId,
      carrier: a.carrier,
    })),
    fulfillerOrders: state.fulfillerOrders.map((so) => ({
      fulfillerOrderId: so.fulfillerOrderId,
      fulfillerId: so.fulfillerId,
      fulfillerName: so.fulfillerName,
      status: so.status,
      itemCount: so.items.length,
      carrier: so.carrier,
      trackingNumber: so.trackingNumber,
      rejectionReason: so.rejectionReason,
      createdAt: so.createdAt,
      updatedAt: so.updatedAt,
    })),
    statusHistory: state.statusHistory.map((h) => ({
      status: h.status,
      timestamp: h.timestamp,
      note: h.note,
      updatedBy: h.updatedBy,
    })),
    deliveredAt: state.deliveredAt,
    // Refund ledger (backlog #4 / R4): on every push, so it survives the immediate
    // workflow close a full refund causes.
    refunds: state.refunds?.map((r) => ({
      refundId: r.refundId,
      timestamp: r.timestamp,
      reason: r.reason,
      lines: r.lines.map((l) => ({ lineItemId: l.lineItemId, quantity: l.quantity })),
      refundAmount: r.refundAmount,
      taxAmount: r.taxAmount,
    })),
    customerFeedback: state.customerFeedback
      ? {
          rating: state.customerFeedback.rating,
          comment: state.customerFeedback.comment,
          submittedAt: state.customerFeedback.submittedAt,
        }
      : undefined,
    createdAt: order.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Builds an ES FulfillerOrderDocument from a FulfillerOrder.
 * Pure function - no side effects.
 *
 * `correlationId` (ADR-0011) is passed by the caller — the FulfillerOrder domain object
 * does not carry it; the order record does (`order.correlationId`).
 */
export function buildFulfillerOrderDocument(
  fulfillerOrder: FulfillerOrder,
  correlationId: string,
): FulfillerOrderDocument {
  return {
    fulfillerOrderId: fulfillerOrder.fulfillerOrderId,
    orderId: fulfillerOrder.orderId,
    correlationId,
    fulfillerId: fulfillerOrder.fulfillerId,
    fulfillerName: fulfillerOrder.fulfillerName,
    status: fulfillerOrder.status,
    itemCount: fulfillerOrder.items.length,
    items: fulfillerOrder.items.map((item) => ({
      assignmentId: item.assignmentId,
      variantId: item.variantId,
      quantity: item.quantity,
    })),
    carrier: fulfillerOrder.carrier,
    trackingNumber: fulfillerOrder.trackingNumber,
    createdAt: fulfillerOrder.createdAt,
    updatedAt: fulfillerOrder.updatedAt,
    rejectionReason: fulfillerOrder.rejectionReason,
    statusHistory: fulfillerOrder.statusHistory.map((h) => ({
      status: h.status,
      timestamp: h.timestamp,
      note: h.note,
    })),
    // The child fulfiller-order workflow closes when the SO reaches a terminal status,
    // but OMS (which runs ~30 days) owns this doc — so lifecycle is derived from the
    // domain status at write time instead of waiting for OMS's own close-mark.
    ...deriveLifecycleFromStatus(
      'fulfiller_orders',
      fulfillerOrder.status,
      fulfillerOrder.updatedAt,
    ),
  };
}
