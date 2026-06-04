/**
 * Temporal Worker OpenTelemetry Configuration Helper
 *
 * Returns interceptors and sinks configuration for Worker.create()
 * when OTEL_ENABLED=true. Returns empty config when disabled.
 *
 * Usage in domain worker factories:
 *   import { getWorkerOtelConfig } from '../lib/worker-otel';
 *
 *   const otelConfig = await getWorkerOtelConfig();
 *   const worker = await Worker.create({
 *     connection,
 *     workflowsPath: require.resolve('./workflows'),
 *     activities,
 *     taskQueue: MY_TASK_QUEUE,
 *     ...otelConfig,
 *   });
 */

import type { WorkerOptions } from '@temporalio/worker';

type OtelWorkerConfig = Pick<WorkerOptions, 'interceptors' | 'sinks'>;

/**
 * Build Temporal Worker OTel interceptors and sinks config.
 * Returns empty object when OTEL_ENABLED !== 'true' (zero overhead).
 */
export async function getWorkerOtelConfig(): Promise<OtelWorkerConfig> {
  if (process.env.OTEL_ENABLED !== 'true') return {};

  const { OpenTelemetryActivityInboundInterceptor } =
    await import('@temporalio/interceptors-opentelemetry');

  return {
    interceptors: {
      activityInbound: [(ctx) => new OpenTelemetryActivityInboundInterceptor(ctx)],
    },
  };
}
