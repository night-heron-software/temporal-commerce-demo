/**
 * Wait for all Temporal workers to report active pollers.
 *
 * Polls the Temporal task queue describe API for each required queue until
 * all queues have at least one active poller, or times out.
 * Adapted from nightheron-mono/tools/src/ops/wait-for-workers.ts.
 *
 * Usage:
 *   npm run workers-wait
 *   tsx --env-file=.env.local scripts/wait-for-workers.ts
 *
 * Exit codes:
 *   0 — all workers ready
 *   1 — timeout or connection error
 */

import { getTemporalClient } from '../src/lib/temporal-client';
import {
  IDENTITY_TASK_QUEUE,
  INVENTORY_TASK_QUEUE,
  CART_TASK_QUEUE,
  CHECKOUT_TASK_QUEUE,
  OMS_TASK_QUEUE,
  FULFILLMENT_TASK_QUEUE,
} from '../src/temporal/contracts';

const REQUIRED_QUEUES = [
  IDENTITY_TASK_QUEUE,
  INVENTORY_TASK_QUEUE,
  CART_TASK_QUEUE,
  CHECKOUT_TASK_QUEUE,
  OMS_TASK_QUEUE,
  FULFILLMENT_TASK_QUEUE,
];

const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 120_000;

let connectionWarningLogged = false;

async function hasActivePollers(
  client: Awaited<ReturnType<typeof getTemporalClient>>,
  taskQueue: string,
): Promise<boolean> {
  try {
    const [descWorkflow, descActivity] = await Promise.all([
      client.workflowService.describeTaskQueue({
        namespace: 'default',
        taskQueue: { name: taskQueue },
        taskQueueType: 1, // TASK_QUEUE_TYPE_WORKFLOW
      }),
      client.workflowService.describeTaskQueue({
        namespace: 'default',
        taskQueue: { name: taskQueue },
        taskQueueType: 2, // TASK_QUEUE_TYPE_ACTIVITY
      }),
    ]);
    const workflowPollers = descWorkflow?.pollers?.length ?? 0;
    const activityPollers = descActivity?.pollers?.length ?? 0;

    // Reset warning flag on success
    connectionWarningLogged = false;

    return workflowPollers > 0 || activityPollers > 0;
  } catch (err: unknown) {
    if (!connectionWarningLogged) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`   ⚠️ Warning checking pollers on queue ${taskQueue}: ${message}`);
      connectionWarningLogged = true;
    }
    return false;
  }
}

async function waitForWorkers() {
  console.log('⏳ Waiting for Temporal workers to register...');
  console.log(`   Queues: ${REQUIRED_QUEUES.join(', ')}\n`);

  // Connect with retry — Temporal gRPC may not be ready immediately after
  // Docker health check passes (especially during init cold-start).
  let client: Awaited<ReturnType<typeof getTemporalClient>>;
  const MAX_CONNECT_RETRIES = 10;
  for (let attempt = 1; attempt <= MAX_CONNECT_RETRIES; attempt++) {
    try {
      client = await getTemporalClient();
      break;
    } catch (err) {
      if (attempt === MAX_CONNECT_RETRIES) {
        throw new Error(`Failed to connect to Temporal after ${MAX_CONNECT_RETRIES} attempts: ${err}`);
      }
      const delay = Math.min(attempt * 3, 15);
      console.log(`   ⚠️ Temporal connection attempt ${attempt}/${MAX_CONNECT_RETRIES} failed, retrying in ${delay}s...`);
      await new Promise(resolve => setTimeout(resolve, delay * 1000));
    }
  }
  const verifiedClient = client!;
  const startTime = Date.now();
  const deadline = startTime + TIMEOUT_MS;
  const ready = new Set<string>();

  let lastPendingKey = '';
  let lastPrintTime = 0;

  while (Date.now() < deadline) {
    for (const queue of REQUIRED_QUEUES) {
      if (ready.has(queue)) continue;
      if (await hasActivePollers(verifiedClient, queue)) {
        ready.add(queue);
        console.log(`   ✓ ${queue}`);
      }
    }

    if (ready.size === REQUIRED_QUEUES.length) {
      console.log('\n✓ All workers ready.\n');
      process.exit(0);
    }

    const pending = REQUIRED_QUEUES.filter((q) => !ready.has(q));
    const pendingKey = pending.join(',');
    const now = Date.now();

    // Print pending status if the list changed, or every 10 seconds
    if (pendingKey !== lastPendingKey || now - lastPrintTime >= 10000) {
      const elapsedSeconds = Math.round((now - startTime) / 1000);
      console.log(`   Still waiting for: ${pending.join(', ')} (elapsed: ${elapsedSeconds}s)`);
      lastPendingKey = pendingKey;
      lastPrintTime = now;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  const pending = REQUIRED_QUEUES.filter((q) => !ready.has(q));
  console.error(
    `\n❌ Timed out after ${TIMEOUT_MS / 1000}s. Queues with no pollers: ${pending.join(', ')}`,
  );
  process.exit(1);
}

waitForWorkers().catch((err) => {
  console.error('❌ wait-for-workers failed:', err);
  process.exit(1);
});
