/**
 * Identity Domain Worker
 *
 * Standalone Temporal worker for the identity domain.
 * Handles: users, shoppers, API tokens, feature flags, and audit logging.
 */

import { NativeConnection, Worker } from '@temporalio/worker';
import { createLogger } from '../../lib';
import { IDENTITY_TASK_QUEUE } from '../contracts';

import * as activities from './activities-impl';

const logger = createLogger('identity:worker');

export default async function identityWorker(connection: NativeConnection): Promise<void> {
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: IDENTITY_TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    activities,
  });

  logger.info({ taskQueue: IDENTITY_TASK_QUEUE }, 'Identity worker started');
  await worker.run();
}

// Allow standalone execution
if (require.main === module) {
  const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';

  (async () => {
    const connection = await NativeConnection.connect({
      address: TEMPORAL_ADDRESS
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
