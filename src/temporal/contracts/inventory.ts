export interface InventoryItem {
  variantId: string;
  supplierLocations: Record<string, SupplierLocation>; // keyed by supplierId
  reservations: Record<string, Reservation>; // Item-level reservations (pre-assignment)
}

export interface SupplierLocation {
  supplierId: string; // UUID
  supplierName: string;
  cost: number;
  totalStock: number;
  orderedStock: number;
  reservedStock: number;
  reservations: Record<string, Reservation>; // Supplier-level reservations
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

// Database supplier record (company)
export interface Supplier {
  id: string;
  name: string;
}

// Database supplier location record (warehouse)
export interface SupplierLocationRecord {
  supplierId: string;
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

// Updates
export const reserveInventoryUpdate = 'reserveInventory';
export interface ReserveInventoryArgs {
  reservationId: string;
  cartId: string;
  variantId: string;
  quantity: number;
  referenceId: string;
  ttlSeconds: number;
}

export type ReserveInventoryResult =
  | { success: true; reservation: Reservation }
  | { success: false; error: string };

// Update: Set supplier location stock (replaces adminSetStock)
export const setSupplierStockUpdate = 'setSupplierStock';
export interface SetSupplierStockArgs {
  supplierId: string;
  supplierName: string;
  cost: number;
  totalStock: number;
  orderedStock?: number;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}
export type SetSupplierStockResult = {
  supplierId: string;
  previousStock: number;
  newStock: number;
  available: number;
};

// Signal: Transfer reservation to supplier location
export const transferReservationSignal = 'transferReservation';
export interface TransferReservationArgs {
  reservationId: string;
  supplierId: string;
  quantity: number; // Allows partial transfers for splitting
}

// Signals
export const updateReservationSignal = 'updateReservation';
export interface UpdateReservationArgs {
  reservationId: string;
  newQuantity: number;
}

export const releaseReservationSignal = 'releaseReservation';
export interface ReleaseReservationArgs {
  reservationId: string;
}

export const confirmReservationSignal = 'confirmReservation';
export interface ConfirmReservationArgs {
  reservationId: string;
}

export const fulfillReservationSignal = 'fulfillReservation';
export interface FulfillReservationArgs {
  reservationId: string;
}

export const cancelReservationSignal = 'cancelReservation';
export interface CancelReservationArgs {
  reservationId: string;
}

// Queries
export const getStockLevelQuery = 'getStockLevel';
export const getFullStateQuery = 'getFullState';


import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';




// ==================
// Inventory Workflow Definitions
// ==================

// Queries
export const getStockLevelQueryDef = defineQuery<StockLevel>(getStockLevelQuery);
export const getFullStateQueryDef = defineQuery<InventoryItem>(getFullStateQuery);

// Updates
export const setSupplierStockUpdateDef = defineUpdate<SetSupplierStockResult, [SetSupplierStockArgs]>(setSupplierStockUpdate);
export const reserveInventoryUpdateDef = defineUpdate<ReserveInventoryResult, [ReserveInventoryArgs]>(reserveInventoryUpdate);

// Signals
export const transferReservationSignalDef = defineSignal<[TransferReservationArgs]>(transferReservationSignal);
export const updateReservationSignalDef = defineSignal<[UpdateReservationArgs]>(updateReservationSignal);
export const releaseReservationSignalDef = defineSignal<[ReleaseReservationArgs]>(releaseReservationSignal);
export const confirmReservationSignalDef = defineSignal<[ConfirmReservationArgs]>(confirmReservationSignal);
export const fulfillReservationSignalDef = defineSignal<[FulfillReservationArgs]>(fulfillReservationSignal);
export const cancelReservationSignalDef = defineSignal<[CancelReservationArgs]>(cancelReservationSignal);

// Service-level signal for the inventoryServiceWorkflow
export interface InventoryChangedPayload {
  blankSkus: string[];
}
export const inventoryChangedSignal = defineSignal<[InventoryChangedPayload]>('inventoryChanged');

// Re-export the string names for external consumers that need them



