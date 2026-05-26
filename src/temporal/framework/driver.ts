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
} from '@temporalio/workflow';
import {
  StateMachineConfig,
  SingleUpdateRegistration,
  MappedUpdateRegistration,
  UpdateExchange,
  StateInput,
  StateOutput,
  SignalRegistration,
} from './types';

function isTerminalState(name: string): boolean {
  return name.startsWith('__terminal:');
}

function isMappedUpdate<TEvent, TContext, TResponse>(
  updates:
    | SingleUpdateRegistration<TEvent, TResponse>
    | MappedUpdateRegistration<TEvent, TContext, TResponse>[],
): updates is MappedUpdateRegistration<TEvent, TContext, TResponse>[] {
  return Array.isArray(updates);
}

export async function runStateMachine<TState extends string, TEvent, TContext, TResponse, TSignal = never>(
  config: StateMachineConfig<TState, TEvent, TContext, TResponse, TSignal>,
  initialContext: TContext,
  updates:
    | SingleUpdateRegistration<TEvent, TResponse>
    | MappedUpdateRegistration<TEvent, TContext, TResponse>[],
  signals?:
    | SignalDefinition<[TSignal]>
    | SignalRegistration<TSignal>[],
): Promise<TContext> {
  let ctx = initialContext;
  let currentStateName = config.initialState;
  let updateCount = 0;

  // FIFO queue for update exchanges — prevents concurrent overwrites
  const updateQueue: UpdateExchange<TEvent, TResponse>[] = [];
  const signalQueue: TSignal[] = [];

  // ── Register Signal Handlers ──
  if (signals) {
    if (Array.isArray(signals)) {
      for (const sig of signals) {
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

  // ── Run Start Hook ──
  if (config.onStart) {
    const startResult = await config.onStart(ctx);
    ctx = startResult.context;
    if (startResult.nextState) {
      currentStateName = startResult.nextState as any;
    }
    if (config.onContextUpdate) {
      config.onContextUpdate(ctx, currentStateName);
    }
  }

  // ── Driver Loop ──
  try {
    while (true) {
      // 1. Check for terminal state
      if (isTerminalState(currentStateName)) {
        break;
      }

      // 2. Continue-As-New check (top of loop, non-blocking drain)
      const threshold = config.continueAsNewThreshold || 100;
      if (config.serializeForContinueAsNew && updateCount >= threshold) {
        // Wait for handlers to finish OR new input to arrive
        await condition(
          () => allHandlersFinished() || updateQueue.length > 0 || signalQueue.length > 0,
        );
        // If all handlers finished and no new input queued, safe to continue-as-new
        if (allHandlersFinished() && updateQueue.length === 0 && signalQueue.length === 0) {
          const nextInput = config.serializeForContinueAsNew(ctx, currentStateName);
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
      const woke = await condition(
        () => updateQueue.length > 0 || signalQueue.length > 0,
        stateConfig.timeout,
      );

      // 4. Consume next input
      let input: StateInput<TEvent, TSignal>;
      let activeExchange: UpdateExchange<TEvent, TResponse> | null = null;
      let inputEventDesc: TEvent | 'timeout' | 'signal';

      if (!woke) {
        input = { kind: 'timeout' };
        inputEventDesc = 'timeout';
      } else if (signalQueue.length > 0) {
        input = { kind: 'signal', result: signalQueue.shift()! };
        inputEventDesc = 'signal';
      } else {
        activeExchange = updateQueue.shift()!;
        input = { kind: 'event', event: activeExchange.event };
        inputEventDesc = activeExchange.event;
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

      // 6. Apply context
      const previousStateName = currentStateName;
      ctx = output.context;
      if (config.onContextUpdate) {
        config.onContextUpdate(ctx, output.next as any);
      }

      // 7. Trigger onTransition Hook
      if (config.onTransition) {
        try {
          await config.onTransition(previousStateName, output.next, inputEventDesc, ctx);
        } catch (transitionErr) {
          log.error('onTransition hook threw an error', {
            from: previousStateName,
            to: output.next,
            error: String(transitionErr),
          });
        }
      }

      // 8. Respond to update handler if active
      if (activeExchange) {
        if (output.error) {
          activeExchange.error = output.error;
        } else if (output.response !== undefined) {
          activeExchange.result = output.response;
          updateCount++;
        } else {
          activeExchange.result = undefined as any;
          updateCount++;
        }
        activeExchange.processed = true;
      }

      // 9. Advance state
      currentStateName = output.next as any;
    }
  } catch (err) {
    if (isCancellation(err)) {
      log.info('State machine driver loop caught cancellation', { state: currentStateName });
      if (config.onCancellation) {
        await CancellationScope.nonCancellable(async () => {
          await config.onCancellation!(ctx, currentStateName);
        });
      }
      return ctx;
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
  if (config.onTerminal) {
    await config.onTerminal(ctx, currentStateName);
  }

  return ctx;
}
