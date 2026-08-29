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
  reconcileStockCounters,
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
  /**
   * Absolute epoch-ms deadline for the next FULL consistency sweep, carried across
   * continue-as-new — otherwise a busy shop (whose signal volume is what triggers CAN) would
   * reset the sweep clock at every rollover, re-opening the starvation issue #74 closed.
   */
  nextSweepAt?: number;
}

// ==================
// Workflow
// ==================

const CONSISTENCY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const CONTINUE_AS_NEW_THRESHOLD = 100;

export async function inventoryServiceWorkflow(input?: InventoryServiceInput): Promise<void> {
  const restored = input ?? {};
  let signalCount = restored.signalCount ?? 0;

  log.info('Inventory service workflow started', { signalCount });

  const dirtySkus = new Set<string>(restored.pendingSkus ?? []);

  // The sweep runs on a DEADLINE, not an interval-per-wake. The previous shape re-armed a
  // fresh 5-minute timer on every loop iteration and only swept when a wake found no dirty
  // SKUs — so any signal inside the window deferred expiry + drift healing, and sustained
  // activity starved them indefinitely (issue #74; validation run -011 measured a 16-minute
  // gap under ordinary shopping, and the sweep fired exactly one interval after the shop went
  // quiet). `Date.now()` is deterministic inside a workflow, so the deadline replays.
  let nextSweepAt = restored.nextSweepAt ?? Date.now() + CONSISTENCY_SWEEP_INTERVAL_MS;

  // Signal handler: collect dirty SKUs and increment counter
  setHandler(inventoryChangedSignal, ({ blankSkus }) => {
    for (const sku of blankSkus) {
      dirtySkus.add(sku);
    }
    signalCount++;
  });

  while (true) {
    // Wait for signals OR the sweep deadline, whichever comes first. The timeout is the time
    // REMAINING to the deadline — never a fresh interval — so signal-driven wakes cannot push
    // the sweep out.
    const remaining = nextSweepAt - Date.now();
    if (remaining > 0) {
      await condition(() => dirtySkus.size > 0, remaining);
    }
    // remaining <= 0: the sweep is already due — no wait, straight to work.

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
    }

    // ---- Periodic full consistency sweep, ON SCHEDULE — even when this wake also carried
    // dirty SKUs. An independent `if`, deliberately not the `else` of the branch above: the
    // else-shape is what made every busy wake skip the sweep (issue #74).
    if (Date.now() >= nextSweepAt) {
      log.info('Running periodic consistency sweep');

      try {
        const expiredCount = await expireReservations();
        if (expiredCount > 0) {
          log.info(`Expired ${expiredCount} reservations`);
        }

        // Heal any counter drift (phantom holds, half-applied decrements/transfers)
        const driftCorrections = await reconcileStockCounters();
        if (driftCorrections > 0) {
          log.warn(`Corrected ${driftCorrections} drifted stock counters`);
        }

        await projectStockSummaries();
        await projectReservationViews();
        await projectLowStockAlerts();
        await syncInventoryToES();
      } catch (err) {
        log.warn(`Consistency sweep error: ${err}`);
      }
      nextSweepAt = Date.now() + CONSISTENCY_SWEEP_INTERVAL_MS;
    }

    // ---- ContinueAsNew check ----
    if (signalCount >= CONTINUE_AS_NEW_THRESHOLD) {
      log.info(`Signal count ${signalCount} reached threshold, continuing as new`);
      await condition(allHandlersFinished);
      await continueAsNew<typeof inventoryServiceWorkflow>({
        signalCount: 0,
        pendingSkus: Array.from(dirtySkus),
        nextSweepAt,
      });
    }
  }
}
