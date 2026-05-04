import { Inventory } from '../contracts';
/**
 * Inventory Service Workflow
 *
 * A single long-lived workflow that handles:
 * 1. Signal-driven targeted projections (SKU-level)
 * 2. Reservation TTL expiration
 * 3. Periodic full CQRS projection as consistency sweep
 * 4. Elasticsearch sync
 *
 * Write-side code signals this workflow with changed SKUs via
 * the inventoryChanged signal.  The workflow batches them and
 * runs targeted projections immediately.
 *
 * ContinueAsNew: The workflow tracks incoming signals and calls
 * continueAsNew after CONTINUE_AS_NEW_THRESHOLD signals to prevent
 * unbounded history growth.
 */

import {
  allHandlersFinished,
  condition,
  continueAsNew,
  log,
  setHandler,
} from '@temporalio/workflow';
import {
  projectStockForSkus,
  projectReservationsForSkus,
  syncInventoryToESForSkus,
  expireReservations,
  projectStockSummaries,
  projectReservationViews,
  projectLowStockAlerts,
  syncInventoryToES,
} from './activities';

// ==================
// Signal Definition (imported from definitions.ts)
// ==================



const inventoryChangedSignal = Inventory.inventoryChangedSignal;
type InventoryChangedPayload = Inventory.InventoryChangedPayload;
export { inventoryChangedSignal };
export type { InventoryChangedPayload };

// ==================
// Workflow Input
// ==================

export interface InventoryServiceInput {
  signalCount?: number;
  pendingSkus?: string[];
}

// ==================
// Workflow
// ==================

const CONSISTENCY_SWEEP_INTERVAL = '5m';
const CONTINUE_AS_NEW_THRESHOLD = 100;

export async function inventoryServiceWorkflow(input?: InventoryServiceInput): Promise<void> {
  const restored = input ?? {};
  let signalCount = restored.signalCount ?? 0;

  log.info('Inventory service workflow started', { signalCount });

  const dirtySkus = new Set<string>(restored.pendingSkus ?? []);

  // Signal handler: collect dirty SKUs and increment counter
  setHandler(inventoryChangedSignal, ({ blankSkus }) => {
    for (const sku of blankSkus) {
      dirtySkus.add(sku);
    }
    signalCount++;
  });

  while (true) {
    // Wait for signals or periodic sweep timer (whichever comes first)
    await condition(() => dirtySkus.size > 0, CONSISTENCY_SWEEP_INTERVAL);

    if (dirtySkus.size > 0) {
      // ---- Signal-driven targeted projection ----
      const skus = Array.from(dirtySkus);
      dirtySkus.clear();

      log.info(`Processing ${skus.length} dirty SKUs`);

      try {
        await projectStockForSkus(skus);
      } catch (err) {
        log.warn(`projectStockForSkus error: ${err}`);
      }

      try {
        await projectReservationsForSkus(skus);
      } catch (err) {
        log.warn(`projectReservationsForSkus error: ${err}`);
      }

      try {
        await syncInventoryToESForSkus(skus);
      } catch (err) {
        log.warn(`syncInventoryToESForSkus error: ${err}`);
      }
    } else {
      // ---- Periodic full consistency sweep ----
      log.info('Running periodic consistency sweep');

      try {
        const expiredCount = await expireReservations();
        if (expiredCount > 0) {
          log.info(`Expired ${expiredCount} reservations`);
        }

        await projectStockSummaries();
        await projectReservationViews();
        await projectLowStockAlerts();
        await syncInventoryToES();
      } catch (err) {
        log.warn(`Consistency sweep error: ${err}`);
      }
    }

    // ---- ContinueAsNew check ----
    if (signalCount >= CONTINUE_AS_NEW_THRESHOLD) {
      log.info(`Signal count ${signalCount} reached threshold, continuing as new`);
      await condition(allHandlersFinished);
      await continueAsNew<typeof inventoryServiceWorkflow>({
        signalCount: 0,
        pendingSkus: Array.from(dirtySkus),
      });
    }
  }
}
