/**
 * Supplier Contracts
 *
 * Supplier-agnostic types for managing catalogs, designs, orders, inventory,
 * and webhooks across any supplier (SwiftPod, Printify, etc.).
 *
 * NOTE: POD-specific adapter interfaces (PODSupplierAdapter) have been removed
 * from contracts. Only the generic SupplierAdapter interface is defined here.
 */

// ============================================================================
// Catalog
// ============================================================================

export interface CatalogItem {
  catalogItemId: string;
  productId: string;
  supplierType: string;
  supplierItemId: string;
  sku: string;
  name: string;
  brand?: string;
  model?: string;
  options: CatalogOption[];
  imageUrl?: string;        // GCS URL
  localImageUrl?: string;   // local /images/... URL
  originalImageUrl?: string;  // Supplier CDN URL before GCS rewrite
  printAreas: PrintAreaSpec[];
  blankCost: number; // cents
  inStock: boolean;
  stockCount?: number;
  discontinued: boolean;
  weight?: number; // grams
  raw: Record<string, unknown>;
}

export interface CatalogOption {
  type: string; // Normalized: "Color", "Size"
  value: string;
  attributes: Record<string, string>;
}

export interface PrintAreaSpec {
  position: string; // "front", "back", "left_sleeve", etc.
  widthPx?: number;
  heightPx?: number;
  dpi: number; // default: 300
  printCost?: number; // cents
}

// ============================================================================
// Designs
// ============================================================================

export interface DesignAsset {
  designId: string;
  designUrl: string; // print-ready artwork (GCP/CDN, publicly accessible)
  name: string;
  widthPx: number;
  heightPx: number;
  previewUrl?: string;
}

export interface DesignPlacement {
  designId: string;
  position: string;
  x?: number; // normalized, 0.5 = center
  y?: number;
  scale?: number; // 1.0 = native
  angle?: number; // degrees
}

// ============================================================================
// Production Cost
// ============================================================================

export interface ProductionCost {
  blankCost: number; // cents
  printAreaCosts: PrintAreaCost[];
  totalCost: number; // computed: blankCost + sum(printAreaCosts[].cost)
  currency: string; // ISO e.g. "USD"
}

export interface PrintAreaCost {
  position: string;
  cost: number; // cents
}

// ============================================================================
// Orders
// ============================================================================

export interface SupplierOrderRequest {
  externalOrderId: string;
  lineItems: SupplierOrderLineItem[];
  shippingMethod: string;
  shippingAddress: SupplierShippingAddress;
  testOrder?: boolean;
}

export interface SupplierOrderLineItem {
  sku: string;
  quantity: number;
  orderItemId: string;
  printFiles: PrintFile[];
  supplierMetadata?: Record<string, unknown>;
}

export interface PrintFile {
  key: string; // print area position
  url: string; // publicly accessible URL
  x?: number; // normalized position (0.5 = center)
  y?: number;
  scale?: number; // 1.0 = native
  angle?: number; // degrees
}

export interface SupplierShippingAddress {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  address1: string;
  address2?: string;
  city: string;
  region: string;
  zip: string;
  country: string;
}

export type DynamicOrderStatus =
  | 'draft'
  | 'pending'
  | 'in_production'
  | 'on_hold'
  | 'shipped'
  | 'cancelled'
  | 'failed';

export interface SupplierOrderResult {
  success: boolean;
  supplierOrderId?: string;
  lineItemIds?: Record<string, string>;
  errorCode?: string;
  errorMessage?: string;
}

// ============================================================================
// Shipping & Tracking
// ============================================================================

export interface Shipment {
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string;
  trackingStatus?: string;
  shippedItems?: ShippedItem[];
  isPrimary?: boolean;
  labelUrl?: string;
}

export interface ShippedItem {
  orderItemId: string;
  quantity: number;
}

// ============================================================================
// Stock Sync
// ============================================================================

export interface StockUpdate {
  supplierType: string;
  sku: string;
  stockCount: number;
  inStock: boolean;
  timestamp: string; // ISO
}

// ============================================================================
// Webhook Events
// ============================================================================

export type WebhookEventType =
  | 'order.status_changed'
  | 'order.production_started'
  | 'shipment.created'
  | 'shipment.delivered'
  | 'stock.changed';

export interface WebhookEvent {
  eventType: WebhookEventType;
  supplierType: string;
  supplierOrderId?: string;
  payload: Record<string, unknown>;
  timestamp: string; // ISO
}

// ============================================================================
// Shipping Address (Fulfillment-level, defined here to avoid circular dependency)
// ============================================================================

export interface ShippingAddress {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  address1: string;
  address2?: string;
  city: string;
  region: string;
  zip: string;
  country: string;
}

// ============================================================================
// Generic Supplier Adapter Interface
// ============================================================================

export interface SupplierAdapter {
  readonly supplierType: string;

  // Catalog
  /** Iterate over all catalog items from this supplier */
  syncCatalog?(): AsyncGenerator<CatalogItem>;
  /** Look up a single catalog item by SKU */
  getCatalogItem?(sku: string): Promise<CatalogItem | null>;

  /** Submit order to supplier */
  submitOrder(request: SupplierOrderInput): Promise<SupplierOrderResult>;

  /** Get current order status */
  getOrderStatus(supplierOrderId: string): Promise<SupplierStatusUpdate>;

  /** Cancel order if possible */
  cancelOrder(supplierOrderId: string): Promise<{ success: boolean; message?: string }>;

  // Stock & Webhooks
  /** Parse a raw webhook payload into a normalized stock update */
  parseStockUpdate?(payload: unknown): StockUpdate;
  /** Parse a raw webhook payload into a normalized webhook event */
  parseWebhookEvent?(payload: unknown): WebhookEvent;
}

// ============================================================================
// Supplier Order Input/Output
// ============================================================================

export interface SupplierOrderInput {
  fulfillmentId: string;
  supplierType: string; // Plugin-defined
  items: SupplierLineItemInput[];
  shippingAddress: ShippingAddress;
  shippingMethod: 'standard' | 'express' | 'economy';
}

export interface SupplierLineItemInput {
  sku: string;
  supplierProductId: string;
  supplierVariantId: string | number;
  quantity: number;
  externalId?: string;
}

export interface SupplierStatusUpdate {
  supplierOrderId: string;
  status: 'in_production' | 'partially_shipped' | 'shipped' | 'delivered' | 'cancelled' | 'failed';
  lineItems?: Array<{
    supplierLineItemId: string;
    status:
      | 'pending'
      | 'submitted'
      | 'in_production'
      | 'shipped'
      | 'delivered'
      | 'cancelled'
      | 'failed';
  }>;
  shipmentInfo?: {
    carrier: string;
    trackingNumber: string;
    trackingUrl?: string;
    items: Array<{ sku: string; quantity: number }>;
  };
  timestamp: string;
}

export interface DynamicSupplierStatusUpdate {
  supplierOrderId: string;
  status: DynamicOrderStatus;
  shipments?: Shipment[];
  failureReason?: string;
  timestamp: string;
}

// ============================================================================
// SKU Mapping
// ============================================================================

export interface SupplierSkuMapping {
  sku: string;
  supplier: string; // Plugin-defined
  supplierProductId: string;
  supplierVariantId: number;
  printProviderId?: number;
  createdAt: string;
  updatedAt: string;
}
