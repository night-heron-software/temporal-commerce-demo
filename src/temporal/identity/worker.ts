/**
 * Identity Domain Worker
 *
 * Activities-only worker: the identity domain has no workflows — its operations
 * are STANDALONE activities executed directly from the client (ADR-0006), so this
 * worker registers activity implementations on identity-queue and nothing else.
 */

import { NativeConnection, Worker, WorkerOptions } from '@temporalio/worker';
import { createLogger } from '../../lib';
import { IDENTITY_TASK_QUEUE } from '../contracts';

import * as activities from './activities-impl';
import { transitionRecorderActivities } from '../transition-recorder';

const logger = createLogger('identity:worker');

export default async function identityWorker(
  connection: NativeConnection,
  otelConfig: Pick<WorkerOptions, 'interceptors' | 'sinks'> = {},
): Promise<void> {
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: IDENTITY_TASK_QUEUE,
    activities: { ...activities, ...transitionRecorderActivities },
    ...otelConfig,
  });

  logger.info({ taskQueue: IDENTITY_TASK_QUEUE }, 'Identity worker started');
  await worker.run();
}

// Allow standalone execution
if (require.main === module) {
  const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';

  (async () => {
    const connection = await NativeConnection.connect({
      address: TEMPORAL_ADDRESS,
    });

    logger.info({ address: TEMPORAL_ADDRESS }, 'Connected to Temporal');

    try {
      await identityWorker(connection);
    } finally {
      connection.close();
    }
  })().catch((err) => {
    logger.fatal(err, 'Identity worker process failed');
    process.exit(1);
  });
}
