/**
 * Workflow-level tests for the long-lived inventory service workflow, via the shared
 * {@link withWorkflowEnv} harness (time-skipping Temporal test env, mocked I/O activities).
 *
 * The workflow exposes no queries, so every assertion goes through the activity mocks
 * (`vi.waitFor` + call inspection). Error-path mocks reject with a non-retryable
 * ApplicationFailure so tests don't sit through real-time retry backoff.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import { withWorkflowEnv } from '../../test-support/workflow-env';
import {
  INVENTORY_TASK_QUEUE,
  WORKFLOW_ENTITY_SLUGS,
  buildWorkflowStartOptions,
  DEMO_STORE_ID,
} from '../contracts/constants';
import { inventoryServiceWorkflow, inventoryChangedSignal } from './workflows';

const WORKFLOWS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflows.ts');

const WAIT = { timeout: 15_000 } as const;

function makeActivities() {
  return {
    // Targeted (signal-driven)
    projectStockForSkus: vi.fn(async () => undefined),
    projectReservationsForSkus: vi.fn(async () => undefined),
    syncInventoryToESForSkus: vi.fn(async () => undefined),
    // Full-scan (periodic consistency sweep)
    expireReservations: vi.fn(async () => 0),
    projectStockSummaries: vi.fn(async () => undefined),
    projectReservationViews: vi.fn(async () => undefined),
    projectLowStockAlerts: vi.fn(async () => undefined),
    syncInventoryToES: vi.fn(async () => undefined),
  };
}

function inventoryWorker(activities: ReturnType<typeof makeActivities>) {
  return { taskQueue: INVENTORY_TASK_QUEUE, workflowsPath: WORKFLOWS_PATH, activities };
}

const startOpts = () => ({
  taskQueue: INVENTORY_TASK_QUEUE,
  ...buildWorkflowStartOptions({
    storeId: DEMO_STORE_ID,
    domain: 'inventory',
    entityId: WORKFLOW_ENTITY_SLUGS.inventoryService,
  }),
  args: [{}] as [Record<string, never>],
});

/** Per-call SKU arrays for a targeted-projection mock (its only argument). */
function skuCalls(mock: { mock: { calls: unknown[][] } }): string[][] {
  return mock.mock.calls.map((call) => call[0] as string[]);
}

/** Union of SKUs across every call to a targeted-projection mock. */
function allSkusSeen(mock: { mock: { calls: unknown[][] } }): string[] {
  return [...new Set(skuCalls(mock).flat())].sort();
}

describe('inventoryServiceWorkflow (Temporal test env)', () => {
  it('runs the three targeted projections for signalled SKUs, not the full sweep', async () => {
    const activities = makeActivities();
    await withWorkflowEnv([inventoryWorker(activities)], async (env) => {
      const handle = await env.client.workflow.start(inventoryServiceWorkflow, startOpts());

      await handle.signal(inventoryChangedSignal, { blankSkus: ['SKU-A', 'SKU-B'] });

      await vi.waitFor(() => {
        expect(allSkusSeen(activities.projectStockForSkus)).toEqual(['SKU-A', 'SKU-B']);
        expect(allSkusSeen(activities.projectReservationsForSkus)).toEqual(['SKU-A', 'SKU-B']);
        expect(allSkusSeen(activities.syncInventoryToESForSkus)).toEqual(['SKU-A', 'SKU-B']);
      }, WAIT);

      expect(activities.expireReservations).not.toHaveBeenCalled();
      expect(activities.projectStockSummaries).not.toHaveBeenCalled();
      expect(activities.syncInventoryToES).not.toHaveBeenCalled();

      await handle.terminate('test complete');
    });
  }, 120_000);

  it('dedupes repeated SKUs within a signal', async () => {
    const activities = makeActivities();
    await withWorkflowEnv([inventoryWorker(activities)], async (env) => {
      const handle = await env.client.workflow.start(inventoryServiceWorkflow, startOpts());

      await handle.signal(inventoryChangedSignal, { blankSkus: ['SKU-A', 'SKU-A', 'SKU-B'] });

      await vi.waitFor(() => {
        expect(activities.projectStockForSkus).toHaveBeenCalled();
      }, WAIT);

      for (const skus of skuCalls(activities.projectStockForSkus)) {
        expect(skus.length).toBe(new Set(skus).size);
      }
      expect(allSkusSeen(activities.projectStockForSkus)).toEqual(['SKU-A', 'SKU-B']);

      await handle.terminate('test complete');
    });
  }, 120_000);

  it('runs the full consistency sweep when the 5m timer fires with no dirty SKUs', async () => {
    const activities = makeActivities();
    await withWorkflowEnv([inventoryWorker(activities)], async (env) => {
      const handle = await env.client.workflow.start(inventoryServiceWorkflow, startOpts());

      // Drive one targeted batch through first so we know the loop is parked on the
      // condition with a fresh 5m timer before we advance the clock.
      await handle.signal(inventoryChangedSignal, { blankSkus: ['SKU-A'] });
      await vi.waitFor(() => {
        expect(activities.syncInventoryToESForSkus).toHaveBeenCalled();
      }, WAIT);

      await env.sleep('5m');

      await vi.waitFor(() => {
        expect(activities.expireReservations).toHaveBeenCalled();
        expect(activities.projectStockSummaries).toHaveBeenCalled();
        expect(activities.projectReservationViews).toHaveBeenCalled();
        expect(activities.projectLowStockAlerts).toHaveBeenCalled();
        expect(activities.syncInventoryToES).toHaveBeenCalled();
      }, WAIT);

      await handle.terminate('test complete');
    });
  }, 120_000);

  it('isolates a targeted-projection failure: siblings still run and the loop survives', async () => {
    const activities = makeActivities();
    activities.projectStockForSkus.mockRejectedValue(
      ApplicationFailure.create({ message: 'projection exploded', nonRetryable: true }),
    );
    await withWorkflowEnv([inventoryWorker(activities)], async (env) => {
      const handle = await env.client.workflow.start(inventoryServiceWorkflow, startOpts());

      await handle.signal(inventoryChangedSignal, { blankSkus: ['SKU-A'] });

      // Each targeted projection has its own try/catch — the failure doesn't stop siblings.
      await vi.waitFor(() => {
        expect(activities.projectReservationsForSkus).toHaveBeenCalled();
        expect(activities.syncInventoryToESForSkus).toHaveBeenCalled();
      }, WAIT);

      // The loop is still alive: a later signal is processed.
      await handle.signal(inventoryChangedSignal, { blankSkus: ['SKU-B'] });
      await vi.waitFor(() => {
        expect(allSkusSeen(activities.syncInventoryToESForSkus)).toContain('SKU-B');
      }, WAIT);

      await handle.terminate('test complete');
    });
  }, 120_000);

  it('survives a sweep failure (single try/catch: later sweep steps are skipped, loop lives on)', async () => {
    const activities = makeActivities();
    activities.expireReservations.mockRejectedValue(
      ApplicationFailure.create({ message: 'sweep exploded', nonRetryable: true }),
    );
    await withWorkflowEnv([inventoryWorker(activities)], async (env) => {
      const handle = await env.client.workflow.start(inventoryServiceWorkflow, startOpts());

      // Park the loop on the condition, then fire the sweep timer.
      await handle.signal(inventoryChangedSignal, { blankSkus: ['SKU-A'] });
      await vi.waitFor(() => {
        expect(activities.syncInventoryToESForSkus).toHaveBeenCalled();
      }, WAIT);
      await env.sleep('5m');

      await vi.waitFor(() => {
        expect(activities.expireReservations).toHaveBeenCalled();
      }, WAIT);
      // The sweep shares one try/catch, so steps after the failure are skipped.
      expect(activities.projectStockSummaries).not.toHaveBeenCalled();

      // The loop survived: a fresh signal is still processed.
      await handle.signal(inventoryChangedSignal, { blankSkus: ['SKU-B'] });
      await vi.waitFor(() => {
        expect(allSkusSeen(activities.syncInventoryToESForSkus)).toContain('SKU-B');
      }, WAIT);

      await handle.terminate('test complete');
    });
  }, 120_000);

  it('continues-as-new after 100 signals, carrying processing forward', async () => {
    const activities = makeActivities();
    await withWorkflowEnv([inventoryWorker(activities)], async (env) => {
      const handle = await env.client.workflow.start(inventoryServiceWorkflow, startOpts());
      const firstRunId = handle.firstExecutionRunId;

      for (let i = 0; i < 100; i++) {
        await handle.signal(inventoryChangedSignal, { blankSkus: [`SKU-${i}`] });
      }

      await vi.waitFor(async () => {
        const desc = await env.client.workflow.getHandle(handle.workflowId, firstRunId).describe();
        expect(desc.status.name).toBe('CONTINUED_AS_NEW');
      }, WAIT);

      // The new run keeps processing signals.
      await handle.signal(inventoryChangedSignal, { blankSkus: ['SKU-AFTER-CAN'] });
      await vi.waitFor(() => {
        expect(allSkusSeen(activities.syncInventoryToESForSkus)).toContain('SKU-AFTER-CAN');
      }, WAIT);

      await handle.terminate('test complete');
    });
  }, 120_000);
});
