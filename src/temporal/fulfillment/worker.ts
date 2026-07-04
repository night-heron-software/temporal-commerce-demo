
import { NativeConnection, Worker, WorkerOptions } from '@temporalio/worker';
import { logger } from '../../lib';
import { FULFILLMENT_TASK_QUEUE } from '../contracts';

import { createFulfillmentActivities } from './activities-impl';
import { transitionRecorderActivities } from '../transition-recorder';

export default async function start(
  connection: NativeConnection,
  otelConfig: Pick<WorkerOptions, 'interceptors' | 'sinks'> = {},
): Promise<void> {
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: FULFILLMENT_TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    activities: { ...createFulfillmentActivities(), ...transitionRecorderActivities },
    ...otelConfig,
  });

  logger.info({ taskQueue: FULFILLMENT_TASK_QUEUE }, 'Fulfillment worker started');
  await worker.run();
}
