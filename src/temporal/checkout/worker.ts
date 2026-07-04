import { NativeConnection, Worker, WorkerOptions } from '@temporalio/worker';
import path from 'path';

import * as activities from './activities-impl';
import { transitionRecorderActivities } from '../transition-recorder';

import { CHECKOUT_TASK_QUEUE } from '../contracts';



async function start(
  connection: NativeConnection,
  otelConfig: Pick<WorkerOptions, 'interceptors' | 'sinks'> = {},
): Promise<void> {
  const worker = await Worker.create({
    connection,
    workflowsPath: require.resolve('./workflows'),
    activities: { ...activities, ...transitionRecorderActivities },
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
      address: TEMPORAL_ADDRESS
    });

    console.log(`[checkout:worker] Connected to Temporal at ${TEMPORAL_ADDRESS}`);

    try {
      await start(connection);
    } finally {
      connection.close();
    }
  })().catch((err) => {
    console.error('[checkout:worker] Fatal:', err);
    process.exit(1);
  });
}
