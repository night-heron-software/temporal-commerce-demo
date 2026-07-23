/**
 * Temporal Worker interceptor configuration helper.
 *
 * Returns the interceptors (and, with OTel, sinks) configuration for Worker.create().
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

import type { ActivityInboundCallsInterceptor, WorkerOptions } from '@temporalio/worker';
import {
  CORRELATION_ID_HEADER,
  decodeCorrelationHeader,
} from '../temporal/framework/correlation-header';
import { runWithCorrelationId } from './correlation-context';

type OtelWorkerConfig = Pick<WorkerOptions, 'interceptors' | 'sinks'>;

/**
 * Activity-inbound interceptor establishing ambient correlation: decodes the
 * `correlationId` header injected by the workflow-outbound interceptor
 * (`src/temporal/framework/activity-capture.ts`) and runs the activity inside
 * `runWithCorrelationId`, so the pino mixin in `logger.ts` stamps every activity log
 * line — and therefore every `system_errors` doc — with the correlationId. Activities
 * scheduled without the header (untagged workflows) run unchanged.
 */
const correlationActivityInbound: ActivityInboundCallsInterceptor = {
  execute(input, next) {
    const correlationId = decodeCorrelationHeader(input.headers?.[CORRELATION_ID_HEADER]);
    if (correlationId === undefined) return next(input);
    return runWithCorrelationId(correlationId, () => next(input));
  },
};

/**
 * Build Temporal Worker interceptors + sinks config for state-machine workers.
 *
 * ALWAYS registers, independent of OTel:
 *   - the per-phase activity-capture **workflow** interceptor (ADR-0010) via
 *     `interceptors.workflowModules` (which also injects the correlation header), and
 *   - the correlation **activity-inbound** interceptor above.
 *
 * When `OTEL_ENABLED=true` it additionally installs the OTel activity-inbound
 * interceptor — after the correlation interceptor, so correlation context is outermost
 * and wraps the traced execution. Everything lives in the single `interceptors` object so
 * nothing clobbers anything else when spread into `Worker.create`.
 */
export async function getWorkerOtelConfig(): Promise<OtelWorkerConfig> {
  // `require.resolve` gives the workflow bundler a concrete path to the interceptor module.
  const workflowModules = [require.resolve('../temporal/framework/interceptors')];

  if (process.env.OTEL_ENABLED !== 'true') {
    return {
      interceptors: { workflowModules, activityInbound: [() => correlationActivityInbound] },
    };
  }

  const { OpenTelemetryActivityInboundInterceptor } =
    await import('@temporalio/interceptors-opentelemetry');

  return {
    interceptors: {
      workflowModules,
      activityInbound: [
        () => correlationActivityInbound,
        (ctx) => new OpenTelemetryActivityInboundInterceptor(ctx),
      ],
    },
  };
}
