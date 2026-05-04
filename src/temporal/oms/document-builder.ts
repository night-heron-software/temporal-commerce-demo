/**
 * Shared OMS Document Builders
 *
 * Builds OrderDocument and SupplierOrderDocument for Elasticsearch.
 * Used by both the order workflow (real-time sync) and reindex route (bulk).
 */

import type { OrderState, Order, SupplierOrder } from './types';
import { Elasticsearch } from '../contracts';
type OrderDocument = Elasticsearch.OrderDocument;
type SupplierOrderDocument = Elasticsearch.SupplierOrderDocument;

/**
 * Builds an ES OrderDocument from workflow state.
 * Pure function - no side effects, safe to use in workflow or API context.
 */
export function buildOrderDocument(
  storeId: string,
  order: Order,
  state: OrderState,
  customerEmail: string
): OrderDocument {
  return {
    storeId,
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
      email: order.shippingAddress.email
    },
    paymentMethod: {
      type: order.paymentMethod.type,
      last4: order.paymentMethod.last4
    },
    items: order.items.map((item: any) => ({
      lineItemId: item.lineItemId,
      variantId: item.variantId,
      quantity: item.quantity,
      price: item.price
    })),
    itemCount: order.items.length,
    variantIds: order.items.map((item: any) => item.variantId),
    assignments: state.assignments.map((a) => ({
      assignmentId: a.assignmentId,
      lineItemId: a.lineItemId,
      variantId: a.variantId,
      supplierId: a.supplierId,
      supplierName: a.supplierName,
      quantity: a.quantity,
      status: a.status,
      supplierOrderId: a.supplierOrderId,
      carrier: a.carrier
    })),
    supplierOrders: state.supplierOrders.map((so) => ({
      supplierOrderId: so.supplierOrderId,
      supplierId: so.supplierId,
      supplierName: so.supplierName,
      status: so.status,
      itemCount: so.items.length,
      carrier: so.carrier,
      trackingNumber: so.trackingNumber,
      rejectionReason: so.rejectionReason,
      createdAt: so.createdAt,
      updatedAt: so.updatedAt
    })),
    statusHistory: state.statusHistory.map((h) => ({
      status: h.status,
      timestamp: h.timestamp,
      note: h.note,
      updatedBy: h.updatedBy
    })),
    deliveredAt: state.deliveredAt,
    customerFeedback: state.customerFeedback
      ? {
          rating: state.customerFeedback.rating,
          comment: state.customerFeedback.comment,
          submittedAt: state.customerFeedback.submittedAt
        }
      : undefined,
    createdAt: order.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

/**
 * Builds an ES SupplierOrderDocument from a SupplierOrder.
 * Pure function - no side effects.
 */
export function buildSupplierOrderDocument(storeId: string, supplierOrder: SupplierOrder): SupplierOrderDocument {
  return {
    storeId,
    supplierOrderId: supplierOrder.supplierOrderId,
    orderId: supplierOrder.orderId,
    supplierId: supplierOrder.supplierId,
    supplierName: supplierOrder.supplierName,
    status: supplierOrder.status,
    itemCount: supplierOrder.items.length,
    items: supplierOrder.items.map((item) => ({
      assignmentId: item.assignmentId,
      variantId: item.variantId,
      quantity: item.quantity
    })),
    carrier: supplierOrder.carrier,
    trackingNumber: supplierOrder.trackingNumber,
    createdAt: supplierOrder.createdAt,
    updatedAt: supplierOrder.updatedAt,
    rejectionReason: supplierOrder.rejectionReason,
    statusHistory: supplierOrder.statusHistory.map((h) => ({
      status: h.status,
      timestamp: h.timestamp,
      note: h.note
    }))
  };
}
