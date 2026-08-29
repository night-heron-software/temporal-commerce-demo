/**
 * Temporal Commerce Demo — Unified Worker Launcher
 *
 * Launches all domain workers in a single process, sharing one NativeConnection.
 * No plugin registry — simulated fulfillment is directly integrated.
 *
 * Usage:
 *   npm run dev:worker
 *   # or: npx tsx --env-file=.env.local ./src/temporal/worker.ts
 */

import { initTracing, shutdownTracing } from '../lib/tracing';
// Initialize OTel BEFORE other imports so auto-instrumentations hook into modules
initTracing('demo-workers');

import { NativeConnection, Runtime } from '@temporalio/worker';
import { createLogger } from '../lib/logger';
import { getWorkerOtelConfig } from '../lib/worker-otel';
import {
  getWorkerVersioningConfig,
  workerBuildId,
  workerDeploymentName,
} from '../lib/worker-versioning';

import cartWorker from './cart/worker';
import checkoutWorker from './checkout/worker';
import fulfillmentWorker from './fulfillment/worker';
import identityWorker from './identity/worker';
import inventoryWorker from './inventory/worker';
import omsWorker from './oms/worker';

const log = createLogger('worker');
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE || 'default';

type PinoLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

Runtime.install({
  // Worker/client SDK metrics (schedule-to-start latency, activity failures, poll counts)
  // exposed for Prometheus. Workers run on the HOST, so the in-container Prometheus scrapes
  // this via host.docker.internal:9466 (see observability/prometheus.yml).
  telemetryOptions: {
    metrics: { prometheus: { bindAddress: '0.0.0.0:9466' } },
  },
  logger: {
    log: (level, message, meta) => {
      const pinoLevel = String(level).toLowerCase() as PinoLevel;
      (log[pinoLevel] ?? log.info).call(log, { ...meta }, String(message));
    },
    trace: (message, meta) => log.trace({ ...meta }, String(message)),
    debug: (message, meta) => log.debug({ ...meta }, String(message)),
    info: (message, meta) => log.info({ ...meta }, String(message)),
    warn: (message, meta) => log.warn({ ...meta }, String(message)),
    error: (message, meta) => log.error({ ...meta }, String(message)),
  },
});

async function run() {
  // Build TLS config for Temporal Cloud (same pattern as temporal-client.ts)
  const tlsCert = process.env.TEMPORAL_TLS_CERT;
  const tlsKey = process.env.TEMPORAL_TLS_KEY;
  const tls =
    tlsCert && tlsKey
      ? {
          clientCertPair: {
            crt: Buffer.from(tlsCert, 'base64'),
            key: Buffer.from(tlsKey, 'base64'),
          },
        }
      : undefined;

  // Get OTel worker config (interceptors/sinks) — no-op when OTEL_ENABLED !== 'true'
  const otelConfig = await getWorkerOtelConfig();
  // Worker Versioning (ADR-0030), opt-in via WORKER_BUILD_ID — {} when unset, so the default
  // launch is byte-identical to before. Spread into every domain worker alongside otel.
  const versioningConfig = getWorkerVersioningConfig();
  if (versioningConfig.workerDeploymentOptions) {
    log.info(
      { buildId: workerBuildId(), deploymentName: workerDeploymentName() },
      'worker versioning ON — this process registers a pinned deployment version',
    );
  }
  const sharedConfig = { ...otelConfig, ...versioningConfig };

  // Connect with retry — Temporal's Docker health check passes before gRPC
  // is fully ready for external connections, causing TransportErrors on cold start.
  const MAX_RETRIES = 10;
  let connection: NativeConnection | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS, tls });
      break;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `Failed to connect to Temporal at ${TEMPORAL_ADDRESS} after ${MAX_RETRIES} attempts: ${err}`,
        );
      }
      const delay = Math.min(attempt * 3, 15);
      log.warn(
        { attempt, maxRetries: MAX_RETRIES, delaySec: delay },
        `Temporal connection failed, retrying in ${delay}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    }
  }
  if (!connection) {
    throw new Error(`Failed to establish Temporal connection after ${MAX_RETRIES} attempts`);
  }
  log.info(
    { address: TEMPORAL_ADDRESS, namespace: TEMPORAL_NAMESPACE, tls: !!tls },
    'Connected to Temporal — starting all domain workers',
  );

  const onShutdown = () => {
    log.info('Shutdown signal received. Draining workers...');
  };
  process.once('SIGINT', onShutdown);
  process.once('SIGTERM', onShutdown);

  try {
    await Promise.all([
      cartWorker(connection, sharedConfig),
      checkoutWorker(connection, sharedConfig),
      fulfillmentWorker(connection, sharedConfig),
      identityWorker(connection, sharedConfig),
      inventoryWorker(connection, sharedConfig),
      omsWorker(connection, sharedConfig),
    ]);
    log.info('All workers have cleanly shut down.');
  } finally {
    connection.close();
    await shutdownTracing();
    log.info('Temporal NativeConnection closed.');
  }
}

run().catch((err) => {
  log.fatal(err, 'Worker process failed');
  process.exit(1);
});
