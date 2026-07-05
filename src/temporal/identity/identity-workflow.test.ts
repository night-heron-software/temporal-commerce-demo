/**
 * Workflow-level tests for the identity domain, via the shared {@link withWorkflowEnv}
 * harness (time-skipping Temporal test env, mocked I/O activities).
 *
 * These workflows are thin activity wrappers with no production callers yet — the tests
 * lock the activity-forwarding contract and the retry policy (3 attempts) for future use.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowFailedError } from '@temporalio/client';
import { withWorkflowEnv } from '../../test-support/workflow-env';
import { IDENTITY_TASK_QUEUE } from '../contracts/constants';
import {
  createShopperWorkflow,
  updateShopperProfileWorkflow,
  updateShopperPasswordWorkflow,
} from './workflows';

const WORKFLOWS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflows.ts');

function makeActivities() {
  return {
    createShopper: vi.fn(async () => undefined),
    updateShopperProfile: vi.fn(async () => undefined),
    updateShopperPassword: vi.fn(async () => undefined),
  };
}

function identityWorker(activities: ReturnType<typeof makeActivities>) {
  return { taskQueue: IDENTITY_TASK_QUEUE, workflowsPath: WORKFLOWS_PATH, activities };
}

describe('identity workflows (Temporal test env)', () => {
  it('createShopperWorkflow forwards the full shopper to the activity exactly once', async () => {
    const activities = makeActivities();
    await withWorkflowEnv([identityWorker(activities)], async (env) => {
      const shopper = {
        id: 'shopper-1',
        email: 'a@example.com',
        passwordHash: 'hash-1',
        name: 'Ada',
        phone: '555-0100',
      };
      await env.client.workflow.execute(createShopperWorkflow, {
        taskQueue: IDENTITY_TASK_QUEUE,
        workflowId: 'identity-test-create-1',
        args: [shopper],
      });

      expect(activities.createShopper).toHaveBeenCalledTimes(1);
      expect(activities.createShopper).toHaveBeenCalledWith(shopper);
    });
  }, 120_000);

  it('updateShopperProfileWorkflow forwards email and updates (full and partial)', async () => {
    const activities = makeActivities();
    await withWorkflowEnv([identityWorker(activities)], async (env) => {
      await env.client.workflow.execute(updateShopperProfileWorkflow, {
        taskQueue: IDENTITY_TASK_QUEUE,
        workflowId: 'identity-test-profile-1',
        args: ['a@example.com', { name: 'Ada L.', phone: '555-0101' }],
      });
      expect(activities.updateShopperProfile).toHaveBeenCalledWith('a@example.com', {
        name: 'Ada L.',
        phone: '555-0101',
      });

      // Partial update: absent fields stay absent rather than being defaulted.
      await env.client.workflow.execute(updateShopperProfileWorkflow, {
        taskQueue: IDENTITY_TASK_QUEUE,
        workflowId: 'identity-test-profile-2',
        args: ['a@example.com', { name: 'Ada Lovelace' }],
      });
      expect(activities.updateShopperProfile).toHaveBeenLastCalledWith('a@example.com', {
        name: 'Ada Lovelace',
      });
    });
  }, 120_000);

  it('updateShopperPasswordWorkflow forwards email and hash', async () => {
    const activities = makeActivities();
    await withWorkflowEnv([identityWorker(activities)], async (env) => {
      await env.client.workflow.execute(updateShopperPasswordWorkflow, {
        taskQueue: IDENTITY_TASK_QUEUE,
        workflowId: 'identity-test-password-1',
        args: ['a@example.com', 'new-hash'],
      });
      expect(activities.updateShopperPassword).toHaveBeenCalledWith('a@example.com', 'new-hash');
    });
  }, 120_000);

  it('fails the workflow after the 3-attempt retry policy is exhausted', async () => {
    const activities = makeActivities();
    activities.createShopper.mockRejectedValue(new Error('cassandra down'));
    await withWorkflowEnv([identityWorker(activities)], async (env) => {
      await expect(
        env.client.workflow.execute(createShopperWorkflow, {
          taskQueue: IDENTITY_TASK_QUEUE,
          workflowId: 'identity-test-retry-exhausted',
          args: [{ id: 's-1', email: 'a@example.com', passwordHash: 'h', name: 'Ada' }],
        }),
      ).rejects.toThrow(WorkflowFailedError);

      expect(activities.createShopper).toHaveBeenCalledTimes(3);
    });
  }, 120_000);

  it('recovers when the activity fails once and then succeeds', async () => {
    const activities = makeActivities();
    activities.createShopper
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined);
    await withWorkflowEnv([identityWorker(activities)], async (env) => {
      await env.client.workflow.execute(createShopperWorkflow, {
        taskQueue: IDENTITY_TASK_QUEUE,
        workflowId: 'identity-test-retry-recovers',
        args: [{ id: 's-2', email: 'b@example.com', passwordHash: 'h', name: 'Bob' }],
      });

      expect(activities.createShopper).toHaveBeenCalledTimes(2);
    });
  }, 120_000);
});
