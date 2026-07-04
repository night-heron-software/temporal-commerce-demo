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
 * Build Temporal Worker interceptors + sinks config for state-machine workers.
 *
 * Always registers the per-phase activity-capture **workflow** interceptor (ADR-0010) via
 * `interceptors.workflowModules`, independent of OTel. When `OTEL_ENABLED=true` it additionally
 * installs the OTel activity-inbound interceptor. Both live in the single `interceptors` object so
 * neither clobbers the other when spread into `Worker.create`.
 */
export async function getWorkerOtelConfig(): Promise<OtelWorkerConfig> {
  // `require.resolve` gives the workflow bundler a concrete path to the interceptor module.
  const workflowModules = [require.resolve('../temporal/framework/interceptors')];

  if (process.env.OTEL_ENABLED !== 'true') {
    return { interceptors: { workflowModules } };
  }

  const { OpenTelemetryActivityInboundInterceptor } =
    await import('@temporalio/interceptors-opentelemetry');

  return {
    interceptors: {
      workflowModules,
      activityInbound: [(ctx) => new OpenTelemetryActivityInboundInterceptor(ctx)],
    },
  };
}
