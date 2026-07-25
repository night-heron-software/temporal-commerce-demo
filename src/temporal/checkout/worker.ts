import { NativeConnection, Worker, WorkerOptions } from '@temporalio/worker';
import { createLogger } from '../../lib';

import * as activities from './activities-impl';
import { transitionRecorderActivities } from '../transition-recorder';
import { projectionCompletionActivities } from '../projection-completion';

import { CHECKOUT_TASK_QUEUE } from '../contracts';

const logger = createLogger('checkout:worker');

async function start(
  connection: NativeConnection,
  otelConfig: Pick<WorkerOptions, 'interceptors' | 'sinks'> = {},
): Promise<void> {
  const worker = await Worker.create({
    connection,
    workflowsPath: require.resolve('./workflows'),
    activities: {
      ...activities,
      ...transitionRecorderActivities,
      ...projectionCompletionActivities,
    },
    taskQueue: CHECKOUT_TASK_QUEUE,
    ...otelConfig,
  });
  return worker.run();
}

export default start;

// Allow standalone execution
if (require.main === module) {
  const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';

  (async () => {
    const connection = await NativeConnection.connect({
      address: TEMPORAL_ADDRESS,
    });

    logger.info({ address: TEMPORAL_ADDRESS }, 'Connected to Temporal');

    try {
      await start(connection);
    } finally {
      connection.close();
    }
  })().catch((err) => {
    logger.fatal(err, 'Checkout worker process failed');
    process.exit(1);
  });
}
