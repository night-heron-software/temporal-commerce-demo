/**
 * Temporal Client — Environment-adaptive singleton
 *
 * Connects to local dev server or Temporal Cloud based on env vars.
 * Uses mTLS when TEMPORAL_TLS_CERT and TEMPORAL_TLS_KEY are set.
 * Injects OpenTelemetry workflow client interceptor when OTEL_ENABLED=true.
 */

import { Connection, Client, type ClientOptions } from '@temporalio/client';
import type { Duration, RetryPolicy, SearchAttributePair } from '@temporalio/common';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
/** Exported for server code that builds Temporal Web UI deep links (order-trace). */
export const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE || 'default';

let cachedClient: Client | null = null;

async function getOtelInterceptors(): Promise<ClientOptions['interceptors']> {
  if (process.env.OTEL_ENABLED !== 'true') return undefined;

  const { OpenTelemetryWorkflowClientInterceptor } =
    await import('@temporalio/interceptors-opentelemetry');
  return {
    workflow: [new OpenTelemetryWorkflowClientInterceptor()],
  };
}

export async function getTemporalClient(): Promise<Client> {
  if (cachedClient) return cachedClient;

  const tlsCert = process.env.TEMPORAL_TLS_CERT;
  const tlsKey = process.env.TEMPORAL_TLS_KEY;

  const connection = await Connection.connect({
    address: TEMPORAL_ADDRESS,
    tls:
      tlsCert && tlsKey
        ? {
            clientCertPair: {
              crt: Buffer.from(tlsCert, 'base64'),
              key: Buffer.from(tlsKey, 'base64'),
            },
          }
        : undefined,
  });

  const interceptors = await getOtelInterceptors();

  cachedClient = new Client({
    connection,
    namespace: TEMPORAL_NAMESPACE,
    interceptors,
  });
  return cachedClient;
}

/**
 * Execute a STANDALONE activity — a single activity run directly from the client with
 * no wrapper workflow (ADR-0006). The activity's own Temporal execution history is the
 * audit trail; the activity must be registered on a worker polling `taskQueue`.
 *
 * Requires Temporal Server >= 1.31 with the `activity.enableStandalone` dynamicconfig
 * gate enabled (see infra/temporal/dynamicconfig/development-sql.yaml) and SDK >= 1.17.
 * The API is Public Preview; this helper is the single place that references it.
 *
 * Pass `typedSearchAttributes` (via `buildActivityTypedSearchAttributes`, ADR-0011) so
 * standalone activities carry the same correlation tags as workflows where available.
 *
 * Bounded by default: callers here are synchronous HTTP handlers awaiting the result,
 * so the helper caps retries (3 attempts, matching the retired proxy-stub policy) and
 * total time (`scheduleToCloseTimeout`, which also bounds the SCHEDULED wait when no
 * worker is polling — the per-attempt `startToCloseTimeout` alone would not).
 */
export async function executeStandaloneActivity<T>(
  activityName: string,
  options: {
    taskQueue: string;
    /** Business-meaningful activity ID (maps to ActivityOptions.id). */
    activityId: string;
    args: unknown[];
    /** Per-attempt run timeout. Defaults to '10 seconds'. */
    startToCloseTimeout?: Duration;
    /** Total cap across scheduling + all attempts. Defaults to '30 seconds'. */
    scheduleToCloseTimeout?: Duration;
    /** Defaults to 3 attempts — a failing dependency errors fast, never hangs the caller. */
    retry?: RetryPolicy;
    typedSearchAttributes?: SearchAttributePair[];
  },
): Promise<T> {
  const client = await getTemporalClient();
  return client.activity.execute<T>(activityName, {
    id: options.activityId,
    taskQueue: options.taskQueue,
    args: options.args,
    startToCloseTimeout: options.startToCloseTimeout ?? '10 seconds',
    scheduleToCloseTimeout: options.scheduleToCloseTimeout ?? '30 seconds',
    retry: options.retry ?? { maximumAttempts: 3 },
    typedSearchAttributes: options.typedSearchAttributes,
  });
}
