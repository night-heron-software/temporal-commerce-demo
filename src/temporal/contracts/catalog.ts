/**
 * Type Definitions for Catalog2 (Cassandra-based)
 * Based on refactor_data_model_request.md API specifications
 */

// --- Product Types ---

export type ProductType = 'PRINTED' | 'PHYSICAL' | 'DIGITAL';

// --- Price ---

export interface Price {
  amount: number; // Integer cents
  currency: string; // ISO 4217 (e.g., "USD")
}

// --- Search API Types ---

export interface SearchResponse {
  collections: CollectionSearchResult[];
}

export interface CollectionSearchResult {
  id: string;
  name: string;
  products: ProductSearchResult[];
}

export interface ProductSearchResult {
  id: string;
  type: ProductType;
  name: string;
  price: Price;
  variantImageUrl: string;
  variantId: string;
}

// --- Variant Detail API Types ---

export interface VariantDetailResponse {
  variant: VariantDetail;
  product: ProductContext;
  relatedVariants: RelatedVariant[];
}

export interface VariantDetail {
  id: string;
  blankSku: string;
  productId: string;
  productName: string;
  productType: ProductType;
  price: Price;
  available: boolean;
  images: ImageMap;
  options: OptionSelection[];
}

export interface ProductContext {
  id: string;
  type: ProductType;
  name: string;
  description: string;
  collectionName?: string;
  brand?: string;
  model?: string;
}

export interface RelatedVariant {
  id: string;
  blankSku: string;
  price: Price;
  available: boolean;
  variantImageUrl: string;
  options: OptionSelection[];
}

// --- Option Types (Polymorphic) ---

export interface OptionSelection {
  optionType: string; // "Color", "Size", "Format", etc.
  value: OptionValue;
}

export type OptionValue = ColorValue | SizeValue | GenericValue;

export interface ColorValue {
  type: 'Color';
  name: string;
  hex: string;
}

export interface SizeValue {
  type: 'Size';
  label: string;
  dimensions?: {
    width: number;
    length: number;
    sleeve?: number;
  };
}

export interface GenericValue {
  type: string; // "Format", "Material", etc.
  label: string;
}

// --- Image Map ---

/** Map of image label → URL (e.g., "front", "back", "detail", "lifestyle") */
export type ImageMap = Record<string, string>;

// --- Order Processing Types ---

export interface OrderLineItem {
  variantId: string;
  productType: ProductType;
  quantity: number;
  unitPrice: Price;
  reservationId?: string; // From Inventory Service (not for DIGITAL)
  productName: string;
  variantDescription: string; // e.g., "Black / Large" or "PDF"
}

// --- Input Types for Workflows ---

export interface Product {
  id: string;
  type: ProductType;
  name: string;
  description?: string;
  price: Price;
  collectionIds?: string[];
  collectionNames?: string[];
  defaultVariantId?: string;
  defaultVariantImageUrl?: string;
  brand?: string;
  model?: string;
}

export interface Variant {
  id: string;
  blankSku: string;
  productId: string;
  productName: string;
  productType: ProductType;
  price: Price;
  available: boolean;
  images?: ImageMap;
  options?: OptionSelection[];
}

export interface ProductInput {
  id?: string;
  type: ProductType;
  name: string;
  description?: string;
  price: Price;
  collectionIds?: string[];
  collectionNames?: string[];
  variants?: VariantInput[];
}

export interface VariantInput {
  id?: string;
  blankSku: string;
  price: Price;
  available?: boolean;
  images?: ImageMap;
  options?: OptionSelection[];
}


