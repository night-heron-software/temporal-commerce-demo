
import { NativeConnection, Worker } from '@temporalio/worker';
import { logger } from '../../lib';
import { FULFILLMENT_TASK_QUEUE } from '../contracts';

import { createFulfillmentActivities } from './activities-impl';

export default async function start(connection: NativeConnection): Promise<void> {
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: FULFILLMENT_TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    activities: createFulfillmentActivities(),
  });

  logger.info({ taskQueue: FULFILLMENT_TASK_QUEUE }, 'Fulfillment worker started');
  await worker.run();
}
