/**
 * ProductTypePlugin Interface
 *
 * Defines how a specific kind of product integrates with the core ecommerce
 * platform. The core platform (Cart, Checkout, OMS, Inventory) never contains
 * product-type-specific logic. Instead, it calls into registered plugins
 * to resolve type-specific behavior at runtime.
 *
 * Each product type (POD, dropship, digital, physical) implements this
 * interface in its own independent repository.
 */

import type { FulfillmentItem } from './fulfillment';
import type { Product, Variant } from './catalog';

// ============================================================================
// Supporting Types for Plugin Methods
// ============================================================================

/** Identifies a variant for inventory purposes. */
export interface VariantIdentity {
  variantId: string;
  blankSku: string;
  productId: string;
  productType: string;
}

/** Fulfiller metadata passed to plugin methods. */
export interface FulfillerInfo {
  fulfillerId: string;
  fulfillerName: string;
  fulfillerType: string;
}

/** Context for fulfiller assignment resolution. */
export interface FulfillerResolutionContext {
  preferredFulfillers: string[];
}

/** Result of fulfiller assignment resolution. */
export interface FulfillerAssignment {
  fulfillerId: string;
  fulfillerType: string;
  fulfillerName: string;
  metadata?: Record<string, unknown>;
}

/** Line item representation for plugin fulfiller resolution. */
export interface OrderLineItem {
  lineItemId: string;
  variantId: string;
  productId: string;
  quantity: number;
  productTitle: string;
  variantTitle: string;
  unitPrice: number;
  currency: string;
}

/** Context for building fulfillment payloads. */
export interface FulfillmentPayloadContext {
  orderId: string;
  shippingMethod: string;
}

/** Opaque fulfiller order payload built by plugins. */
export interface FulfillerOrderPayload {
  [key: string]: unknown;
}

/** Stock seeding parameters returned by plugins. */
export interface StockSeedParams {
  totalStock: number;
  reservedStock: number;
}

/** A schema extension (CQL table) that a plugin requires. */
export interface SchemaExtension {
  tableName: string;
  cql: string;
}

/** Context for resolving product presentation data. */
export interface PresentationContext {
  locale?: string;
}

/** Plugin-specific product presentation data. */
export interface ProductPresentationData {
  [key: string]: unknown;
}

/** Shipping address for cost calculation. */
export interface ShippingAddressForCost {
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

/** Landed cost calculation result. */
export interface LandedCost {
  baseCost: number;
  shippingCost: number;
  surcharges: number;
}

/** Context passed to plugin initialization. */
export interface PluginInitContext {
  applySchemaMigrations(extensions: SchemaExtension[]): Promise<void>;
}

// ============================================================================
// ProductTypePlugin Interface
// ============================================================================

export interface ProductTypePlugin {
  /** Unique identifier for this product type (e.g., 'pod', 'dropship', 'digital'). */
  readonly typeId: string;

  /** Human-readable display name. */
  readonly displayName: string;

  // ─── Fulfillment ─────────────────────────────────────────────

  /**
   * Resolve which fulfiller(s) should fulfill a given item.
   * Called by OMS during auto-assignment.
   */
  resolveFulfillerAssignment(
    item: OrderLineItem,
    context: FulfillerResolutionContext,
  ): Promise<FulfillerAssignment[]>;

  /**
   * The Temporal workflow type name for this product type's fulfillment strategy.
   * If null, the core fulfillmentWorkflow handles it with the default strategy.
   */
  readonly fulfillmentWorkflowType: string | null;

  /**
   * Build the fulfiller-specific fulfillment request payload.
   * Handles things like:
   * - POD: design file resolution, geometric layout, blueprint mapping
   * - Dropship: fulfiller PO construction
   * - Digital: download link generation
   */
  buildFulfillmentPayload(
    item: FulfillmentItem,
    context: FulfillmentPayloadContext,
  ): Promise<FulfillerOrderPayload>;

  // ─── Inventory ───────────────────────────────────────────────

  /**
   * Inventory strategy for this product type.
   *
   * - 'tracked': Real stock counts managed per-SKU (physical warehouse)
   * - 'sentinel': High constant stock (POD — always available if fulfiller is active)
   * - 'unlimited': No inventory tracking (digital products)
   * - 'external': Defer to external fulfiller API for availability
   */
  readonly inventoryStrategy: 'tracked' | 'sentinel' | 'unlimited' | 'external';

  /**
   * Build the inventory workflow ID for a given variant.
   * POD uses composite IDs like `inventory-fulfiller-GILDAN64000-navy-L`.
   * Physical warehouse uses `inventory-warehouse-{warehouseId}-{sku}`.
   */
  buildInventoryWorkflowId(variant: VariantIdentity, fulfillerInfo: FulfillerInfo): string;

  /**
   * Resolve the stock seeding parameters for a variant.
   * POD returns sentinel stock (9999). Physical returns actual counts.
   */
  getInitialStockLevel(
    variant: VariantIdentity,
    fulfillerInfo: FulfillerInfo,
  ): Promise<StockSeedParams>;

  // ─── Catalog & Presentation ──────────────────────────────────

  /**
   * Additional Cassandra tables required by this product type.
   * The platform migration system will apply these during initialization.
   */
  readonly schemaExtensions: SchemaExtension[];

  /**
   * Elasticsearch mapping extensions for product documents.
   * Added as nested fields under `productTypeData` in the product index.
   */
  readonly searchMappingExtensions: Record<string, unknown>;

  /**
   * Resolve product-type-specific display data for the storefront.
   * Called when building product detail pages.
   *
   * POD example: returns design previews, available placements, mockup URLs
   * Digital example: returns file format, size, preview URL
   */
  resolveProductPresentation(
    product: Product,
    variant: Variant,
    context: PresentationContext,
  ): Promise<ProductPresentationData>;

  /**
   * React component registry for product-type-specific UI elements.
   * These are dynamically loaded by the storefront based on product type.
   */
  readonly uiComponents: {
    /** Product detail page enhancement (e.g., design customizer). */
    productDetailEnhancement?: string;
    /** Cart line item renderer (e.g., showing design thumbnail). */
    cartLineItemRenderer?: string;
    /** Admin product editor extension. */
    adminProductEditor?: string;
  };

  // ─── Pricing ─────────────────────────────────────────────────

  /**
   * Calculate the landed cost for a fulfillment item.
   * Includes base cost, shipping, and any fulfiller surcharges.
   */
  calculateLandedCost(
    item: FulfillmentItem,
    shippingAddress: ShippingAddressForCost,
  ): Promise<LandedCost>;

  // ─── Catalog Sync (Optional) ─────────────────────────────────

  /**
   * If this product type supports background catalog synchronization
   * from an external source (e.g., fulfiller catalog import),
   * return the workflow type and task queue for the sync process.
   */
  readonly catalogSyncWorkflow?: {
    workflowType: string;
    taskQueue: string;
  };

  // ─── Lifecycle Hooks ─────────────────────────────────────────

  /**
   * Called during platform initialization to register plugin-specific
   * Temporal activities, create required tables, and seed reference data.
   */
  initialize(context: PluginInitContext): Promise<void>;
}
