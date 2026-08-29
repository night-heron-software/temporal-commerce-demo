/**
 * Worker Deployment Versioning config, shared by every `Worker.create` in the fleet (ported
 * from the parent platform's `@nightheron/infrastructure`).
 *
 * ADR-0030 chose Worker Versioning over `patched()`: a workflow stays on the worker version it
 * started on until it finishes, so an incompatible change to workflow code cannot break an
 * execution that is already in flight. The cost, accepted there, is a drain tail as long as the
 * longest-lived workflow — a 30-day cart, here.
 *
 * **Opt-in.** With no `WORKER_BUILD_ID` set this returns `{}` and the fleet runs exactly as it
 * did before, registering no deployment version — normal `npm run dev:worker` is unchanged.
 *
 * Set `WORKER_BUILD_ID` (and optionally `WORKER_DEPLOYMENT_NAME`) to run a versioned worker
 * set. Two sets with different build ids can poll the same task queues at once; `temporal
 * worker deployment set-current-version` decides which one NEW executions go to, while pinned
 * executions stay where they started.
 */
import type { WorkerDeploymentVersion, VersioningBehavior } from '@temporalio/common';

/** The deployment all of this repo's workers belong to, unless overridden. */
const DEFAULT_DEPLOYMENT_NAME = 'temporal-commerce-demo';

/** Spread into `Worker.create` — the same shape as `getWorkerOtelConfig`, spread alongside it. */
export interface WorkerVersioningConfig {
  workerDeploymentOptions?: {
    version: WorkerDeploymentVersion;
    useWorkerVersioning: true;
    defaultVersioningBehavior: VersioningBehavior;
  };
}

/** The build id this process is running as, or undefined when versioning is off. */
export function workerBuildId(): string | undefined {
  return process.env.WORKER_BUILD_ID?.trim() || undefined;
}

/** The deployment name this process registers under. */
export function workerDeploymentName(): string {
  return process.env.WORKER_DEPLOYMENT_NAME?.trim() || DEFAULT_DEPLOYMENT_NAME;
}

/**
 * Build the versioning options for a worker, or `{}` when `WORKER_BUILD_ID` is unset.
 *
 * `PINNED` is the default behaviour and the reason ADR-0030 picked this mechanism at all: it is
 * what lets a parked child finish on the code it started with. `AUTO_UPGRADE` would move a
 * workflow to the newest version on its next task, reintroducing exactly the
 * replay-compatibility exposure versioning was adopted to remove.
 */
export function getWorkerVersioningConfig(): WorkerVersioningConfig {
  const buildId = workerBuildId();
  if (!buildId) return {};

  return {
    workerDeploymentOptions: {
      version: { buildId, deploymentName: workerDeploymentName() },
      useWorkerVersioning: true,
      defaultVersioningBehavior: 'PINNED',
    },
  };
}
