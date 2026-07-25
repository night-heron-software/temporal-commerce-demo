/**
 * Workflow-side helper that marks a machine's ES projection docs completed at close.
 *
 * Proxies the host-registered {@link MARK_PROJECTIONS_ACTIVITY} by name (workers spread
 * `projectionCompletionActivities` into their bundles, same convention as the transition
 * recorder). Machines without a `projections` config schedule no activity at all, so
 * existing workflows replay unchanged.
 */
import { log, proxyActivities } from '@temporalio/workflow';
import type {
  ProjectionCompletionConfig,
  ProjectionCompletionRef,
  ProjectionWorkflowOutcome,
} from './types';

const { markProjectionsCompleted } = proxyActivities<{
  markProjectionsCompleted(input: {
    refs: ProjectionCompletionRef[];
    outcome: ProjectionWorkflowOutcome;
    closedAt: string;
  }): Promise<void>;
}>({
  startToCloseTimeout: '30 seconds',
  // Bounded: the workflow is already closing — ride out ES blips, then give up (logged by
  // the caller) rather than wedging the close.
  retry: {
    maximumAttempts: 5,
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    backoffCoefficient: 2,
  },
});

/**
 * Stamp the machine's projection docs with the close outcome. No-op without a config or
 * when `refs` resolves empty. Callers wrap this in try/catch — a marking failure must
 * never mask the workflow's own close path.
 */
export async function markProjections<TContext, TState extends string>(
  config: ProjectionCompletionConfig<TContext, TState> | undefined,
  ctx: TContext,
  currentState: TState | `__terminal:${string}`,
  outcome: ProjectionWorkflowOutcome,
): Promise<void> {
  if (!config) return;
  const refs = config.refs(ctx, currentState);
  if (refs.length === 0) return;
  log.debug('Marking projections completed', { outcome, refs });
  await markProjectionsCompleted({
    refs,
    outcome,
    closedAt: new Date().toISOString(),
  });
}
