import { Inventory, INVENTORY_TASK_QUEUE, INVENTORY_SERVICE_WORKFLOW_TYPE } from '../contracts';
/**
 * Inventory Change Signal Utility
 *
 * Fire-and-forget signaling: after each inventory write, notify the
 * INVENTORY_SERVICE_WORKFLOW_TYPE so it can project the change to read tables
 * and Elasticsearch immediately.
 *
 * Uses signalWithStart to ensure the workflow is always running.
 */

import { getTemporalClient } from '../../lib';

import { logger } from '../../lib';

const WORKFLOW_ID = 'inventory-service';
const SIGNAL_NAME = 'inventoryChanged';

/**
 * Signal the INVENTORY_SERVICE_WORKFLOW_TYPE with changed SKUs.
 * Uses signalWithStart so the workflow is auto-started if not running.
 * Fire-and-forget: logs errors but never throws (writes must not fail).
 */
export async function signalInventoryChanged(blankSkus: string[]): Promise<void> {
  if (blankSkus.length === 0) return;

  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(WORKFLOW_ID);

    // Try signaling the running workflow first (fast path)
    await handle.signal(SIGNAL_NAME, { blankSkus });
  } catch (e: unknown) {
    // If workflow not found, start it with signalWithStart
    const err = e as { name?: string; code?: number };
    if (err.name === 'WorkflowNotFoundError' || err.code === 5) {
      try {
        const client = await getTemporalClient();
        await client.workflow.signalWithStart(INVENTORY_SERVICE_WORKFLOW_TYPE, {
          workflowId: WORKFLOW_ID,
          taskQueue: INVENTORY_TASK_QUEUE,
          signal: SIGNAL_NAME,
          signalArgs: [{ blankSkus }],
        });
        logger.info({ skuCount: blankSkus.length }, 'Started INVENTORY_SERVICE_WORKFLOW_TYPE via signalWithStart');
      } catch (startErr) {
        logger.warn({ err: startErr, skuCount: blankSkus.length }, 'Failed to signalWithStart INVENTORY_SERVICE_WORKFLOW_TYPE');
      }
    } else {
      logger.warn({ err: e, skuCount: blankSkus.length }, 'Failed to signal INVENTORY_SERVICE_WORKFLOW_TYPE');
    }
  }
}
