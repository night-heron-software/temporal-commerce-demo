/**
 * Elasticsearch Document Types
 * Types for indexed documents matching the ES mappings
 */

// Price type (shared)
export interface PriceDocument {
  amount: number; // cents
  currency: string;
}

// Products Index (with nested variants)
export interface ProductDocument {
  storeId: string;
  id: string;
  name: string;
  sku?: string;
  supplierType?: string;
  description?: string;
  type: 'PRINTED' | 'PHYSICAL' | 'DIGITAL';
  brand?: string;
  model?: string;
  price: PriceDocument;
  collectionIds?: string[];
  collectionNames?: string[];
  defaultVariantId?: string;
  defaultVariantImageUrl?: string;
  localDefaultVariantImageUrl?: string;
  variants: VariantDocument[];
  createdAt: string;
  updatedAt: string;
}

// Variant (nested inside ProductDocument)
export interface VariantDocument {
  id: string;
  blankSku: string;
  price: PriceDocument;
  available: boolean;
  options: OptionDocument[];
  frontImageUrl?: string;
  localFrontImageUrl?: string;
}

export interface OptionDocument {
  optionType: string;
  value: {
    type: string;
    name?: string;
    label?: string;
    hex?: string;
  };
}

// Collections Index
export interface CollectionDocument {
  storeId: string;
  id: string;
  name: string;
  thumbnailUrl?: string;
  productCount: number;
}

// Orders Index
export interface OrderDocument {
  storeId: string;
  orderId: string;
  cartId: string;
  confirmationNumber: string;
  customerEmail: string;
  customerName: string;
  status: string;
  // Pricing
  subtotal: number;
  shippingCost: number;
  tax: number;
  totalDiscounts: number;
  total: number;
  currency: string;
  // Shipping address
  shippingAddress: OrderShippingAddressDocument;
  // Payment
  paymentMethod: OrderPaymentMethodDocument;
  // Line items
  items: OrderItemDocument[];
  itemCount: number;
  variantIds: string[]; // Flattened for easy lookup
  // Assignments and supplier orders
  assignments: OrderAssignmentDocument[];
  supplierOrders: OrderSupplierOrderDocument[];
  // Status tracking
  statusHistory: OrderStatusHistoryDocument[];
  deliveredAt?: string;
  // Customer feedback
  customerFeedback?: OrderCustomerFeedbackDocument;
  // Timestamps
  createdAt: string;
  updatedAt: string;
}

export interface OrderShippingAddressDocument {
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
  email: string;
}

export interface OrderPaymentMethodDocument {
  type: string;
  last4?: string;
}

export interface OrderItemDocument {
  lineItemId: string;
  variantId: string;
  quantity: number;
  price: number;
}

export interface OrderAssignmentDocument {
  assignmentId: string;
  lineItemId: string;
  variantId: string;
  supplierId: string;
  supplierName?: string;
  quantity: number;
  status: string;
  supplierOrderId?: string;
  carrier?: string;
}

export interface OrderSupplierOrderDocument {
  supplierOrderId: string;
  supplierId: string;
  supplierName: string;
  status: string;
  itemCount: number;
  carrier?: string;
  trackingNumber?: string;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrderStatusHistoryDocument {
  status: string;
  timestamp: string;
  note?: string;
  updatedBy: string;
}

export interface OrderCustomerFeedbackDocument {
  rating: number;
  comment?: string;
  submittedAt: string;
}

// Customers Index
export interface CustomerDocument {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  totalSpent: number;
  orderCount: number;
  lastOrderAt: string;
}

// Suppliers Index
export interface SupplierDocument {
  supplierId: string;
  name: string;
  locations: SupplierLocationDocument[];
}

export interface SupplierLocationDocument {
  locationId: string;
  name: string;
  cost: number;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isPrimary: boolean;
}

// Inventory Index
export interface InventoryDocument {
  variantId: string;
  totalStock: number;
  reservedStock: number;
  availableStock: number;
  supplierCount: number;
  supplierLocations: InventorySupplierLocationDocument[];
  reservations: InventoryReservationDocument[]; // Item-level reservations only
  reservationIds: string[]; // Flattened for lookup (all reservations)
  cartIds: string[]; // Flattened for lookup (all unique cart IDs)
}

export interface InventorySupplierLocationDocument {
  supplierId: string;
  supplierName: string;
  totalStock: number;
  reservedStock: number;
  orderedStock: number;
  city: string;
  state: string;
  country: string;
  reservations: InventoryReservationDocument[]; // Supplier-level reservations
}

export interface InventoryReservationDocument {
  reservationId: string;
  cartId: string;
  quantity: number;
  status: string;
  createdAt: number;
  expiresAt: number | null;
}

// Supplier Orders Index
export interface SupplierOrderDocument {
  storeId: string;
  supplierOrderId: string;
  orderId: string;
  supplierId: string;
  supplierName: string;
  status: string;
  items: SupplierOrderItemDocument[];
  itemCount: number;
  carrier?: string;
  trackingNumber?: string;
  createdAt: string;
  updatedAt: string;
  rejectionReason?: string;
  statusHistory: SupplierOrderHistoryEntryDocument[];
}

export interface SupplierOrderItemDocument {
  assignmentId: string;
  variantId: string;
  quantity: number;
}

export interface SupplierOrderHistoryEntryDocument {
  status: string;
  timestamp: string;
  note?: string;
}

// Carts Index (cart workflow state)
export interface CartItemDocument {
  lineItemId: string;
  variantId: string;
  quantity: number;
  price: number;
}

export interface CartDocument {
  storeId: string;
  cartId: string;
  items: CartItemDocument[];
  itemCount: number;
  subtotalPrice: number;
  totalPrice: number;
  currency: string;
  status: string;
  appliedCoupons: string[];
  createdAt: string;
  updatedAt: string;
}

// Reservations Index (inventory reservations)
export interface ReservationDocument {
  reservationId: string;
  cartId: string;
  variantId: string;
  quantity: number;
  status: string;
  expiresAt?: string;
  createdAt: string;
}

// Fulfillments Index (fulfillment workflow state)
export interface FulfillmentDocument {
  storeId: string;
  orderId: string;
  customerId: string;
  status: string;
  supplierOrderCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  errorMessage?: string;
}

// Shipments Index (shipment tracking)
export interface ShipmentDocument {
  shipmentId: string;
  orderId: string;
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string;
  itemCount: number;
  shippedAt?: string;
  deliveredAt?: string;
}

// Index names
export const ES_INDICES = {
  products: 'products',
  collections: 'collections',
  orders: 'orders',
  customers: 'customers',
  suppliers: 'suppliers',
  inventory: 'inventory',
  supplierOrders: 'supplier_orders',
  carts: 'carts',
  reservations: 'reservations',
  fulfillments: 'fulfillments',
  shipments: 'shipments'
} as const;
