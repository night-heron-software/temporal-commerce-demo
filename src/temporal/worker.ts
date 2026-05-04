/**
 * Temporal Commerce Demo — Unified Worker Launcher
 *
 * Launches all domain workers in a single process, sharing one NativeConnection.
 * No plugin registry — simulated fulfillment is directly integrated.
 *
 * Usage:
 *   npm run temporal:worker
 *   # or: npx tsx --env-file=.env.local ./src/temporal/worker.ts
 */

import { NativeConnection, Runtime } from '@temporalio/worker';
import { createLogger } from '../lib/logger';

import cartWorker from './cart/worker';
import checkoutWorker from './checkout/worker';
import fulfillmentWorker from './fulfillment/worker';
import identityWorker from './identity/worker';
import inventoryWorker from './inventory/worker';
import omsWorker from './oms/worker';

const log = createLogger('worker');
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';

type PinoLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

Runtime.install({
  logger: {
    log: (level, message, meta) => {
      const pinoLevel = String(level).toLowerCase() as PinoLevel;
      (log[pinoLevel] ?? log.info).call(log, { ...meta }, String(message));
    },
    trace: (message, meta) => log.trace({ ...meta }, String(message)),
    debug: (message, meta) => log.debug({ ...meta }, String(message)),
    info: (message, meta) => log.info({ ...meta }, String(message)),
    warn: (message, meta) => log.warn({ ...meta }, String(message)),
    error: (message, meta) => log.error({ ...meta }, String(message))
  }
});

async function run() {
  const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
  log.info({ address: TEMPORAL_ADDRESS }, 'Connected to Temporal — starting all domain workers');

  const onShutdown = () => {
    log.info('Shutdown signal received. Draining workers...');
  };
  process.once('SIGINT', onShutdown);
  process.once('SIGTERM', onShutdown);

  try {
    await Promise.all([
      cartWorker(connection),
      checkoutWorker(connection),
      fulfillmentWorker(connection),
      identityWorker(connection),
      inventoryWorker(connection),
      omsWorker(connection),
    ]);
    log.info('All workers have cleanly shut down.');
  } finally {
    connection.close();
    log.info('Temporal NativeConnection closed.');
  }
}

run().catch((err) => {
  log.fatal(err, 'Worker process failed');
  process.exit(1);
});
