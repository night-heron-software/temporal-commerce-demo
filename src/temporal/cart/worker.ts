import { NativeConnection, Worker } from '@temporalio/worker';
import path from 'path';

import * as activities from './activities-impl';

import { CART_TASK_QUEUE } from '../contracts';



async function start(connection: NativeConnection): Promise<void> {
  const worker = await Worker.create({
    connection,
    workflowsPath: require.resolve('./workflows'),
    activities,
    taskQueue: CART_TASK_QUEUE
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

    console.log(`[cart:worker] Connected to Temporal at ${TEMPORAL_ADDRESS}`);

    try {
      await start(connection);
    } finally {
      connection.close();
    }
  })().catch((err) => {
    console.error('[cart:worker] Fatal:', err);
    process.exit(1);
  });
}
