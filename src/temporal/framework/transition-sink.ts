/**
 * AsyncTransitionRecorder — in-workflow buffered sink for the state-transition projection
 * (ADR-0010). `record()` is a non-blocking O(1) enqueue; `runFlusher()` is a background
 * coroutine that batch-persists transitions off the state machine's hot path via the
 * host-provided `persistWorkflowTransitions` activity. Tenant/correlation come from the
 * identity resolver (convention: Search Attributes with a workflow-ID fallback), so no
 * per-domain wiring is needed.
 *
 * Workflow-safe: only imports `@temporalio/workflow`. The node-side activity is proxied by
 * name ({@link PERSIST_TRANSITIONS_ACTIVITY}); hosts register an implementation on the workers
 * that run recorded machines.
 */
import { condition, log, proxyActivities, workflowInfo } from '@temporalio/workflow';
import { conventionIdentityResolver } from './identity';
import type {
  TransitionPersistRecord,
  TransitionRecordInput,
  TransitionRecordingConfig,
  TransitionSink,
  TransitionTrigger,
} from './types';

const { persistWorkflowTransitions } = proxyActivities<{
  persistWorkflowTransitions(records: TransitionPersistRecord[]): Promise<void>;
}>({
  startToCloseTimeout: '30 seconds',
  // Bounded so a sustained persistence outage eventually gives up (audit data loss, logged)
  // rather than wedging drain()/continue-as-new. Backoff rides out transient blips (several
  // minutes).
  retry: {
    maximumAttempts: 10,
    initialInterval: '1 second',
    maximumInterval: '60 seconds',
    backoffCoefficient: 2,
  },
});

const MAX_BATCH = 25;
const MAX_BUFFER = 500; // hard cap → drop-oldest under sustained back-pressure
const MAX_FIELD_BYTES = 256 * 1024;

function capJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return JSON.stringify({ __unserializable: true });
  }
  if (serialized === undefined) return undefined;
  if (serialized.length > MAX_FIELD_BYTES) {
    return JSON.stringify({ __truncated: true, bytes: serialized.length });
  }
  return serialized;
}

/**
 * Build a recorder for the current workflow, or `undefined` when recording is disabled or the
 * identity resolver yields no tenant id (nothing to tenant-scope).
 */
export function createTransitionRecorder<TContext>(
  config?: TransitionRecordingConfig<TContext>,
): TransitionSink<TContext> | undefined {
  if (config?.enabled === false) return undefined;

  const identity = (config?.identity ?? conventionIdentityResolver())();
  const tenantId = identity?.tenantId;
  if (tenantId === undefined) return undefined;
  const tags = identity?.tags;

  const { workflowId, runId, workflowType } = workflowInfo();

  const serialize = config?.serialize ?? ((ctx: TContext) => ctx as unknown);
  const redact = config?.redactPayload ?? ((_t: TransitionTrigger, p: unknown) => p);

  const pending: TransitionPersistRecord[] = [];
  let seq = 0;
  let inFlight = 0;
  let closed = false;
  let dropped = 0;

  return {
    record(input: TransitionRecordInput<TContext>): void {
      pending.push({
        tenantId,
        workflowId,
        at: input.at,
        runId,
        seq: seq++,
        workflowType,
        tags,
        fromState: input.from,
        toState: input.to,
        triggerKind: input.trigger.kind,
        triggerName: input.trigger.name,
        triggerPayload: capJson(redact(input.trigger, input.triggerPayload)),
        contextSnapshot: capJson(serialize(input.context)),
        prepareActivities: input.prepareActivities?.length
          ? capJson(input.prepareActivities)
          : undefined,
        finalizeActivities: input.finalizeActivities?.length
          ? capJson(input.finalizeActivities)
          : undefined,
        updateResult: input.updateResult !== undefined ? capJson(input.updateResult) : undefined,
      });
      if (pending.length > MAX_BUFFER) {
        pending.shift();
        dropped++;
        log.warn('[transition-recorder] buffer overflow — dropped oldest transition', {
          workflowId,
          dropped,
        });
      }
    },

    async runFlusher(): Promise<void> {
      while (true) {
        await condition(() => pending.length > 0 || closed);
        if (pending.length === 0 && closed) return;
        const batch = pending.splice(0, MAX_BATCH);
        inFlight++;
        try {
          await persistWorkflowTransitions(batch);
        } catch (err) {
          log.warn('[transition-recorder] persist failed after retries — dropping batch', {
            workflowId,
            count: batch.length,
            error: String(err),
          });
        } finally {
          inFlight--;
        }
      }
    },

    async drain(): Promise<void> {
      await condition(() => pending.length === 0 && inFlight === 0);
    },

    async flushNow(): Promise<void> {
      // Deliberately does NOT use `condition()` or the coroutine: both are cancellable, and this
      // exists precisely for the moment when the workflow is being cancelled. Callers run it
      // inside `CancellationScope.nonCancellable`.
      while (pending.length > 0) {
        const batch = pending.splice(0, MAX_BATCH);
        try {
          await persistWorkflowTransitions(batch);
        } catch (err) {
          // Same disposition as the coroutine: a failed persist drops its batch rather than
          // wedging shutdown. Losing the row is bad; hanging a cancelling workflow is worse.
          log.warn('[transition-recorder] final flush failed — dropping batch', {
            workflowId,
            count: batch.length,
            error: String(err),
          });
          return;
        }
      }
    },

    close(): void {
      closed = true;
    },
  };
}
