/**
 * Inventory Activities
 * Activity proxies for workflow use
 */

import { proxyActivities } from '@temporalio/workflow';

export interface InventoryActivities {
  // Targeted (signal-driven)
  projectStockForSkus(blankSkus: string[]): Promise<void>;
  projectReservationsForSkus(blankSkus: string[]): Promise<void>;
  syncInventoryToESForSkus(blankSkus: string[]): Promise<void>;
  // Full-scan (periodic consistency)
  expireReservations(): Promise<number>;
  projectStockSummaries(): Promise<void>;
  projectReservationViews(): Promise<void>;
  projectLowStockAlerts(): Promise<void>;
  syncInventoryToES(): Promise<void>;
}

export const {
  projectStockForSkus,
  projectReservationsForSkus,
  syncInventoryToESForSkus,
  expireReservations,
  projectStockSummaries,
  projectReservationViews,
  projectLowStockAlerts,
  syncInventoryToES,
} = proxyActivities<InventoryActivities>({
  startToCloseTimeout: '30s',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1s',
    backoffCoefficient: 2
  }
});
