/**
 * Per-phase activity capture for the state-transition projection (ADR-0010).
 *
 * A workflow outbound interceptor records every activity scheduled while a capture bucket is
 * active — its name, arguments, and result (or error). `definePureState` opens a bucket around the
 * `prepare` phase and another around `finalize`, so each transition knows exactly which activities
 * ran at the beginning vs the end, and what they returned.
 *
 * Workflow-safe (only `@temporalio/workflow`). The module-level bucket is per-workflow-execution
 * (Temporal isolates workflow module state), and is only mutated around the awaited prepare/finalize
 * phases — so capture is deterministic and replay-safe (activity results are replayed from history).
 */
import type {
  ActivityInput,
  LocalActivityInput,
  Next,
  WorkflowInterceptorsFactory,
  WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow';
import type { ActivityCall } from './types';
import { PERSIST_TRANSITIONS_ACTIVITY } from './types';

/**
 * The transition recorder's own activity — excluded from phase capture so the background flusher's
 * writes (which can interleave with an awaited prepare/finalize) are never mis-attributed to a state.
 */
const RECORDER_ACTIVITY = PERSIST_TRANSITIONS_ACTIVITY;

/** Per-value cap so one large arg/result can't bloat a transition row; others are still captured. */
const MAX_VALUE_BYTES = 16 * 1024;

let activeBucket: ActivityCall[] | null = null;

/** Begin collecting activity calls into a fresh bucket; returns it. */
export function beginActivityCapture(): ActivityCall[] {
  const bucket: ActivityCall[] = [];
  activeBucket = bucket;
  return bucket;
}

/** Stop collecting. */
export function endActivityCapture(): void {
  activeBucket = null;
}

/** Keep the value, or replace an oversized/unserializable one with a marker. */
function capValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { __unserializable: true };
  }
  if (serialized === undefined) return undefined;
  if (serialized.length > MAX_VALUE_BYTES) return { __truncated: true, bytes: serialized.length };
  return value;
}

function capture<T>(activityType: string, args: unknown, run: () => Promise<T>): Promise<T> {
  if (!activeBucket || activityType === RECORDER_ACTIVITY) return run();
  const call: ActivityCall = { name: activityType, args: capValue(args) };
  activeBucket.push(call);
  return run().then(
    (result) => {
      call.result = capValue(result);
      return result;
    },
    (err: unknown) => {
      call.error = err instanceof Error ? err.message : String(err);
      throw err;
    },
  );
}

const outbound: WorkflowOutboundCallsInterceptor = {
  scheduleActivity(input: ActivityInput, next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>) {
    return capture(input.activityType, input.args, () => next(input));
  },
  scheduleLocalActivity(
    input: LocalActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleLocalActivity'>,
  ) {
    return capture(input.activityType, input.args, () => next(input));
  },
};

/**
 * Workflow interceptors factory. Registered on state-machine workers via the worker's
 * `interceptors.workflowModules` (see `worker-otel.ts` / `framework/interceptors.ts`).
 */
export const transitionActivityInterceptors: WorkflowInterceptorsFactory = () => ({
  outbound: [outbound],
});
