import { NativeConnection, Worker, WorkerOptions } from '@temporalio/worker';
import { logger } from '../../lib';
import { createOmsActivities } from './activities-impl';
import { transitionRecorderActivities } from '../transition-recorder';
import { projectionCompletionActivities } from '../projection-completion';
import { OMS_TASK_QUEUE } from '../contracts';

async function start(
  connection: NativeConnection,
  otelConfig: Pick<WorkerOptions, 'interceptors' | 'sinks'> = {},
): Promise<void> {
  const worker = await Worker.create({
    connection,
    workflowsPath: require.resolve('./workflows'),
    activities: {
      ...createOmsActivities(),
      ...transitionRecorderActivities,
      ...projectionCompletionActivities,
    },
    taskQueue: OMS_TASK_QUEUE,
    ...otelConfig,
  });
  logger.info({ taskQueue: OMS_TASK_QUEUE }, 'OMS worker started');
  return worker.run();
}

export default start;
