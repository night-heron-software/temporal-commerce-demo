import { defineSignal } from '@temporalio/workflow';

/**
 * Deterministic reservation id — the single source of truth for the scheme.
 *
 * Every reservation row is keyed per (cart, variant). Sites that derive an id to look a
 * reservation back up (fulfillment transfer/fulfill/release, cart release, reconcile) MUST use
 * this function rather than templating the string inline: PR #17 briefly moved creation to a
 * per-blank-sku key while lookups still derived per-variant ids, silently no-oping every
 * fulfillment-side mutation.
 */
export function buildReservationId(cartId: string, variantId: string): string {
  return `${cartId}-${variantId}`;
}

export interface InventoryItem {
  variantId: string;
  fulfillerLocations: Record<string, FulfillerLocation>; // keyed by fulfillerId
  reservations: Record<string, Reservation>; // Item-level reservations (pre-assignment)
}

export interface FulfillerLocation {
  fulfillerId: string; // UUID
  fulfillerName: string;
  cost: number;
  totalStock: number;
  orderedStock: number;
  reservedStock: number;
  reservations: Record<string, Reservation>; // Fulfiller-level reservations
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

// Database fulfiller record (company)
export interface Fulfiller {
  id: string;
  name: string;
}

// Database fulfiller location record (warehouse)
export interface FulfillerLocationRecord {
  fulfillerId: string;
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

export interface Reservation {
  reservationId: string;
  cartId: string;
  variantId: string;
  quantity: number;
  referenceId: string;
  status: 'TEMPORARY' | 'CONFIRMED' | 'RELEASED' | 'FULFILLED';
  expiresAt: number | null; // Timestamp in ms
  createdAt: number;
}

export interface StockLevel {
  total: number;
  reserved: number;
  available: number;
}

// Service-level signal for the inventoryServiceWorkflow
export interface InventoryChangedPayload {
  blankSkus: string[];
}
export const inventoryChangedSignal = defineSignal<[InventoryChangedPayload]>('inventoryChanged');
