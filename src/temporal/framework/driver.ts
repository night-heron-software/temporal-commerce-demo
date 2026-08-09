import {
  allHandlersFinished,
  CancellationScope,
  condition,
  continueAsNew,
  isCancellation,
  log,
  setHandler,
  SignalDefinition,
  ApplicationFailure,
  TemporalFailure,
} from '@temporalio/workflow';
import {
  StateMachineConfig,
  SingleUpdateRegistration,
  MappedUpdateRegistration,
  UpdateExchange,
  StateInput,
  StateOutput,
  SignalRegistration,
  TransitionTrigger,
} from './types';
import { createTransitionRecorder } from './transition-sink';
import { markProjections } from './projection-completion';

function isTerminalState(name: string): boolean {
  return name.startsWith('__terminal:');
}

/** The `type` field of a command event, when present — a friendly trigger name. */
function triggerName(value: unknown): string | undefined {
  return value &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string'
    ? (value as { type: string }).type
    : undefined;
}

function describeTrigger<TEvent, TSignal>(input: StateInput<TEvent, TSignal>): TransitionTrigger {
  if (input.kind === 'timeout') return { kind: 'timeout' };
  if (input.kind === 'signal') return { kind: 'signal', name: triggerName(input.result) };
  return { kind: 'update', name: triggerName(input.event) };
}

function triggerPayload<TEvent, TSignal>(input: StateInput<TEvent, TSignal>): unknown {
  if (input.kind === 'signal') return input.result;
  if (input.kind === 'event') return input.event;
  return undefined;
}

function isMappedUpdate<TEvent, TContext, TResponse>(
  updates:
    | SingleUpdateRegistration<TEvent, TResponse>
    | MappedUpdateRegistration<TEvent, TContext, TResponse>[],
): updates is MappedUpdateRegistration<TEvent, TContext, TResponse>[] {
  return Array.isArray(updates);
}

export async function runStateMachine<
  TState extends string,
  TEvent,
  TContext,
  TResponse,
  TSignal = never,
>(
  config: StateMachineConfig<TState, TEvent, TContext, TResponse, TSignal>,
  initialContext: TContext,
  updates:
    | SingleUpdateRegistration<TEvent, TResponse>
    | MappedUpdateRegistration<TEvent, TContext, TResponse>[],
  signals?: SignalDefinition<[TSignal]> | SignalRegistration<TSignal>[],
): Promise<TContext> {
  let ctx = initialContext;
  let currentStateName = config.initialState;
  // Counts every processed input (update, signal, or timeout) toward the
  // continue-as-new threshold. Signals and timeouts grow workflow history just as
  // updates do, so a purely signal-driven workflow (e.g. identity account lifecycle)
  // must be able to continue-as-new too — counting only updates would never fire.
  let inputCount = 0;

  // FIFO queue for update exchanges — prevents concurrent overwrites
  const updateQueue: UpdateExchange<TEvent, TResponse>[] = [];
  const signalQueue: TSignal[] = [];

  // ── Register Signal Handlers ──
  if (signals) {
    if (Array.isArray(signals)) {
      for (const sig of signals) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setHandler(sig.definition, (...args: any[]) => {
          signalQueue.push(sig.toSignal(...args));
        });
      }
    } else {
      setHandler(signals, (result: TSignal) => {
        signalQueue.push(result);
      });
    }
  }

  // ── Register Update Handlers ──
  if (isMappedUpdate(updates)) {
    for (const update of updates) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setHandler(update.definition, async (...args: any[]): Promise<TResponse> => {
        if (isTerminalState(currentStateName)) {
          throw new Error('Workflow is in a terminal state');
        }
        const event = update.toEvent(...args) as TEvent;
        const entry: UpdateExchange<TEvent, TResponse> = { event, processed: false };
        updateQueue.push(entry);
        await condition(() => entry.processed);
        if (entry.error) {
          if (update.formatError) {
            return update.formatError(entry.error, ctx) as TResponse;
          }
          throw ApplicationFailure.nonRetryable(entry.error);
        }
        if (update.formatResponse) {
          return update.formatResponse(entry.result!, ctx);
        }
        return entry.result!;
      });
    }
  } else {
    setHandler(updates, async (event: TEvent): Promise<TResponse> => {
      if (isTerminalState(currentStateName)) {
        throw new Error('Workflow is in a terminal state');
      }
      const entry: UpdateExchange<TEvent, TResponse> = { event, processed: false };
      updateQueue.push(entry);
      await condition(() => entry.processed);
      if (entry.error) {
        throw ApplicationFailure.nonRetryable(entry.error);
      }
      return entry.result!;
    });
  }

  // ── Async transition recorder (ADR-0010) ──
  // On by default; no-ops for untagged workflows or when opted out. record() is non-blocking;
  // a background flusher coroutine batch-persists off the hot path.
  const recorder = createTransitionRecorder<TContext>(config.transitionRecording);
  const flusher = recorder?.runFlusher();
  let recorderShutdown = false;
  const shutdownRecorder = async (): Promise<void> => {
    if (!recorder || recorderShutdown) return;
    recorderShutdown = true;
    recorder.close();
    await recorder.drain();
    await flusher;
  };

  // ── Run Start Hook ──
  if (config.onStart) {
    const startResult = await config.onStart(ctx);
    ctx = startResult.context;
    if (startResult.nextState) {
      currentStateName = startResult.nextState as TState;
    }
    if (config.onContextUpdate) {
      config.onContextUpdate(ctx, currentStateName);
    }
  }

  // Record the initial state as the machine's first transition (∅ → initialState).
  recorder?.record({
    from: '',
    to: currentStateName,
    trigger: { kind: 'start' },
    context: ctx,
    at: new Date().toISOString(),
  });

  // ── Driver Loop ──
  try {
    while (true) {
      // 1. Check for terminal state
      if (isTerminalState(currentStateName)) {
        break;
      }

      // 2. Continue-As-New check (top of loop, non-blocking drain)
      const threshold = config.continueAsNewThreshold || 100;
      if (config.serializeForContinueAsNew && inputCount >= threshold) {
        // Wait for handlers to finish OR new input to arrive
        await condition(
          () => allHandlersFinished() || updateQueue.length > 0 || signalQueue.length > 0,
        );
        // If all handlers finished and no new input queued, safe to continue-as-new
        if (allHandlersFinished() && updateQueue.length === 0 && signalQueue.length === 0) {
          const nextInput = config.serializeForContinueAsNew(ctx, currentStateName);
          // Flush buffered transitions before the run ends (the next run gets a fresh recorder).
          await shutdownRecorder();
          await continueAsNew(nextInput);
        }
        // Otherwise: new input arrived during drain — fall through to process it
      }

      // Resolve the configuration for the current state
      const stateConfig = config.states[currentStateName];
      if (!stateConfig) {
        throw new Error(`State config not found for state: ${currentStateName}`);
      }

      // 3. Wait for input (update, signal, or timeout)
      let input: StateInput<TEvent, TSignal>;
      let activeExchange: UpdateExchange<TEvent, TResponse> | null = null;
      let inputEventDesc: TEvent | 'timeout' | 'signal' | 'automatic';

      if (stateConfig.transitional) {
        // Transitional states never wait: the synthesized timeout-shaped input keeps the
        // state-function contract uniform, but the transition is recorded as 'automatic' —
        // nothing timed out, the state advances by design.
        input = { kind: 'timeout', timestamp: new Date().toISOString() };
        inputEventDesc = 'automatic';
      } else {
        const timeout =
          (typeof stateConfig.timeout === 'function'
            ? stateConfig.timeout(ctx)
            : stateConfig.timeout) ?? '1 millisecond';
        const woke = await condition(
          () => updateQueue.length > 0 || signalQueue.length > 0,
          timeout,
        );

        if (!woke) {
          input = { kind: 'timeout', timestamp: new Date().toISOString() };
          inputEventDesc = 'timeout';
        } else if (signalQueue.length > 0) {
          input = {
            kind: 'signal',
            result: signalQueue.shift()!,
            timestamp: new Date().toISOString(),
          };
          inputEventDesc = 'signal';
        } else {
          activeExchange = updateQueue.shift()!;
          input = {
            kind: 'event',
            event: activeExchange.event,
            timestamp: new Date().toISOString(),
          };
          inputEventDesc = activeExchange.event;
        }
      }

      // 5. Dispatch to state function
      let output: StateOutput<TState, TContext, TResponse>;
      try {
        output = await stateConfig.fn(ctx, input);
      } catch (err) {
        log.error('State function threw an unhandled error', {
          state: currentStateName,
          error: String(err),
        });
        if (activeExchange) {
          activeExchange.error = err instanceof Error ? err.message : String(err);
          activeExchange.processed = true;
        }
        // Do not crash the host workflow execution for update errors if we can continue
        if (activeExchange) {
          continue;
        }
        throw err;
      }

      // 6. Apply context — unless the input was REJECTED (ADR-0024). A rejection
      // changes nothing: the caller gets the error (step 7b/8), but context hooks,
      // onTransition, and recording (7c) all skip — a rejection is not a transition
      // and must not project.
      const previousStateName = currentStateName;
      if (!output.rejected) {
        ctx = output.context;
        if (config.onContextUpdate) {
          config.onContextUpdate(ctx, output.next);
        }
      }

      // 7. Trigger onTransition Hook
      if (config.onTransition && !output.rejected) {
        try {
          await config.onTransition(
            previousStateName,
            output.next,
            inputEventDesc,
            ctx,
            input.timestamp,
          );
        } catch (transitionErr) {
          log.error('onTransition hook threw an error', {
            from: previousStateName,
            to: output.next,
            error: String(transitionErr),
          });
        }
      }

      // 7b. Compute the update result before recording, so it can be persisted
      // in the transition record (ADR-0010) rather than requiring fragile
      // Temporal history cross-referencing.
      let updateResult: unknown;
      if (activeExchange) {
        if (output.error) {
          activeExchange.error = output.error;
        } else if (output.response !== undefined) {
          activeExchange.result = output.response;
          updateResult = output.response;
        } else {
          activeExchange.result = undefined as unknown as TResponse;
        }
      }

      // 7c. Record the transition (ADR-0010) — on a real state change, or any command
      // (update/signal) so context mutations within a state are captured too. Idle timeout
      // ticks that change nothing are skipped.
      if (
        recorder &&
        !output.rejected &&
        (output.next !== previousStateName || input.kind !== 'timeout')
      ) {
        recorder.record({
          from: previousStateName,
          to: output.next,
          // Transitional states get a timeout-SHAPED input (uniform state-fn contract)
          // but nothing elapsed — record 'automatic' so the trace tells the truth.
          trigger: stateConfig.transitional ? { kind: 'automatic' } : describeTrigger(input),
          triggerPayload: triggerPayload(input),
          context: ctx,
          at: input.timestamp,
          prepareActivities: output.activities?.prepare,
          finalizeActivities: output.activities?.finalize,
          updateResult,
        });
      }

      // 8. Release the update handler to return its response to the caller.
      if (activeExchange) {
        activeExchange.processed = true;
      }

      // 9. Advance state
      currentStateName = output.next as TState;

      // 10. Count this processed input toward the continue-as-new threshold
      // (every kind — update, signal, timeout — adds to workflow history).
      inputCount++;
    }
  } catch (err) {
    if (isCancellation(err)) {
      log.info('State machine driver loop caught cancellation', { state: currentStateName });
      // Best-effort flush of buffered transitions before unwinding.
      await CancellationScope.nonCancellable(async () => {
        try {
          await shutdownRecorder();
        } catch (drainErr) {
          log.warn('transition recorder drain failed during cancellation', {
            error: String(drainErr),
          });
        }
        if (config.onCancellation) {
          await config.onCancellation!(ctx, currentStateName);
        }
        // After onCancellation, so the domain's final re-index cannot overwrite the mark.
        try {
          await markProjections(config.projections, ctx, currentStateName, 'canceled');
        } catch (markErr) {
          log.warn('projection completion mark failed during cancellation', {
            error: String(markErr),
          });
        }
      });
      return ctx;
    }
    // Let the flusher coroutine unwind with the failing workflow task.
    recorder?.close();
    // Only a TemporalFailure closes the workflow — a plain Error fails the workflow *task*
    // (retry loop, workflow still open, must not be marked), and the continue-as-new
    // sentinel is not a TemporalFailure either.
    if (err instanceof TemporalFailure && config.projections) {
      try {
        await CancellationScope.nonCancellable(() =>
          markProjections(config.projections, ctx, currentStateName, 'failed'),
        );
      } catch (markErr) {
        log.warn('projection completion mark failed during workflow failure', {
          error: String(markErr),
        });
      }
    }
    throw err;
  }

  // ── Terminal Exit Cleanup ──
  // Drain and reject any queued updates to prevent deadlocks
  while (updateQueue.length > 0) {
    const entry = updateQueue.shift()!;
    entry.error = 'Workflow reached terminal state';
    entry.processed = true;
  }

  await condition(allHandlersFinished);
  // Flush buffered transitions before terminal hooks / return, then stop the flusher coroutine.
  await shutdownRecorder();
  if (config.onTerminal) {
    await config.onTerminal(ctx, currentStateName);
  }
  // After onTerminal, so the domain's final re-index cannot overwrite the mark. A marking
  // failure (activity retries exhausted) must never fail an otherwise-completed workflow.
  try {
    await markProjections(config.projections, ctx, currentStateName, 'completed');
  } catch (markErr) {
    log.warn('projection completion mark failed at terminal exit', { error: String(markErr) });
  }

  return ctx;
}
