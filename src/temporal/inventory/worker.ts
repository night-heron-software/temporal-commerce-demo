import { NativeConnection, Worker, WorkerOptions } from '@temporalio/worker';
import { createLogger } from '../../lib';
import { INVENTORY_TASK_QUEUE } from '../contracts';

import * as activities from './activities-impl';
import { transitionRecorderActivities } from '../transition-recorder';

const logger = createLogger('inventory:worker');

export default async function inventoryWorker(
  connection: NativeConnection,
  otelConfig: Pick<WorkerOptions, 'interceptors' | 'sinks'> = {},
): Promise<void> {
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: INVENTORY_TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    activities: { ...activities, ...transitionRecorderActivities },
    ...otelConfig,
  });

  logger.info({ taskQueue: INVENTORY_TASK_QUEUE }, 'Inventory worker started');
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
      await inventoryWorker(connection);
    } finally {
      connection.close();
    }
  })().catch((err) => {
    logger.fatal(err, 'Inventory worker process failed');
    process.exit(1);
  });
}
