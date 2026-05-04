import { NativeConnection, Worker } from '@temporalio/worker';
import { logger } from '../../lib';
import { createOmsActivities } from './activities-impl';
import { OMS_TASK_QUEUE } from '../contracts';

async function start(connection: NativeConnection): Promise<void> {
  const worker = await Worker.create({
    connection,
    workflowsPath: require.resolve('./workflows'),
    activities: createOmsActivities(),
    taskQueue: OMS_TASK_QUEUE
  });
  logger.info({ taskQueue: OMS_TASK_QUEUE }, 'OMS worker started');
  return worker.run();
}

export default start;
