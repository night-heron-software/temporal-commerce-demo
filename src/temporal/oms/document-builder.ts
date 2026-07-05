/**
 * Shared OMS Document Builders
 *
 * Builds OrderDocument and FulfillerOrderDocument for Elasticsearch.
 * Used by both the order workflow (real-time sync) and reindex route (bulk).
 */

import type { OrderState, Order, FulfillerOrder } from './types';
import { Elasticsearch } from '../contracts';
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
 */
export function buildFulfillerOrderDocument(
  fulfillerOrder: FulfillerOrder,
): FulfillerOrderDocument {
  return {
    fulfillerOrderId: fulfillerOrder.fulfillerOrderId,
    orderId: fulfillerOrder.orderId,
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
  };
}
