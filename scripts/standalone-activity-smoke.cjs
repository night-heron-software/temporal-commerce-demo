#!/usr/bin/env node
/**
 * Standalone-activity smoke test.
 *
 * Proves the live Temporal stack supports standalone activities end-to-end:
 * spins up an activity-only worker and invokes it via `client.activity.execute`
 * (the same SDK call `executeStandaloneActivity` in @/lib/temporal-client wraps).
 *
 * This is the load-bearing check that static gates (typecheck/lint/build) cannot make:
 * it surfaces a server with `activity.enableStandalone` unset, which otherwise fails at
 * runtime with `UNIMPLEMENTED: Standalone activity is disabled`.
 *
 * Requires the infra stack up (`npm run infra:up`) and server >= 1.31.0 + SDK >= 1.17.0.
 *
 * Usage:
 *   npm run smoke:standalone
 *   node scripts/standalone-activity-smoke.cjs
 */
const { NativeConnection, Worker } = require('@temporalio/worker');
const { Client, Connection } = require('@temporalio/client');

const ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const NAMESPACE = process.env.TEMPORAL_NAMESPACE || 'default';
const TASK_QUEUE = 'standalone-activity-smoke';
const EXPECTED = 'echo:hello-standalone';

async function main() {
  const workerConn = await NativeConnection.connect({ address: ADDRESS });
  const worker = await Worker.create({
    connection: workerConn,
    namespace: NAMESPACE,
    taskQueue: TASK_QUEUE,
    activities: {
      async smokeEcho(msg) {
        return `echo:${msg}`;
      },
    },
  });
  const runPromise = worker.run();

  const clientConn = await Connection.connect({ address: ADDRESS });
  const client = new Client({ connection: clientConn, namespace: NAMESPACE });

  const result = await client.activity.execute('smokeEcho', {
    id: `standalone-smoke-${Date.now()}`,
    taskQueue: TASK_QUEUE,
    args: ['hello-standalone'],
    startToCloseTimeout: '10s',
  });

  worker.shutdown();
  await runPromise;
  await clientConn.close();
  await workerConn.close();

  if (result !== EXPECTED) {
    throw new Error(`unexpected result: ${JSON.stringify(result)} (expected ${EXPECTED})`);
  }
  console.log(`✓ standalone activity OK — result: ${result} (server=${ADDRESS}, namespace=${NAMESPACE})`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('✗ standalone activity smoke FAILED');
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  },
);
