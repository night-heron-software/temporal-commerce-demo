import { log } from '@temporalio/workflow';
import { beginActivityCapture, endActivityCapture } from './activity-capture';
import { SELF } from './types';
import type {
  ActivityCall,
  PureStateHandler,
  StateFunction,
  StateInput,
  StateOutput,
  DecisionResult,
  Self,
} from './types';

/**
 * Converts a PureStateHandler (prepare → decide → finalize) into a
 * standard StateFunction compatible with the existing driver.
 *
 * Error semantics:
 * - If prepare() throws → stays in selfState, returns error to caller.
 * - decide() must never throw (it's synchronous and pure).
 * - If finalize() throws → decision is committed, error is logged.
 */
export function definePureState<
  TState extends string,
  TEvent,
  TContext,
  TResponse,
  TSignal = never,
  TPrepared = void,
  TFinalize = void,
>(
  handler: PureStateHandler<TState, TEvent, TContext, TResponse, TSignal, TPrepared, TFinalize>,
  selfState: TState,
): StateFunction<TState, TEvent, TContext, TResponse, TSignal> {
  // Resolve the "stay put" sentinel to this state's own name. Shared handlers can
  // return `next: SELF` instead of hardcoding a state, so the sentinel never escapes.
  const resolveNext = (
    n: TState | `__terminal:${string}` | Self,
  ): TState | `__terminal:${string}` => (n === SELF ? selfState : n);

  return async (
    ctx: Readonly<TContext>,
    input: StateInput<TEvent, TSignal>,
  ): Promise<StateOutput<TState, TContext, TResponse>> => {
    // ── Phase 1: PREPARE ── (capture the activities scheduled here, ADR-0010)
    const prepareActivities = beginActivityCapture();
    let prepared: TPrepared;
    try {
      prepared = handler.prepare ? await handler.prepare(ctx, input) : (undefined as TPrepared);
    } catch (err) {
      endActivityCapture();
      return {
        context: ctx as TContext,
        next: selfState,
        error: err instanceof Error ? err.message : String(err),
        activities: { prepare: prepareActivities, finalize: [] },
      };
    }
    endActivityCapture();

    // ── Phase 2: DECIDE (pure, synchronous) ──
    const decision = handler.decide(ctx, input, prepared);

    // Runtime guard: catch accidental async decide functions
    if (decision instanceof Promise) {
      log.error('definePureState: decide() returned a Promise — it must be synchronous', {
        state: selfState,
      });
      const awaited = await (decision as unknown as Promise<
        DecisionResult<TState, TContext, TResponse, TFinalize>
      >);
      return {
        context: awaited.context,
        next: resolveNext(awaited.next),
        response: awaited.response,
        error: awaited.error,
        activities: { prepare: prepareActivities, finalize: [] },
      };
    }

    // ── Phase 3: FINALIZE ── (capture the activities scheduled here)
    let finalizeActivities: ActivityCall[] = [];
    if (handler.finalize && decision.finalize !== undefined) {
      finalizeActivities = beginActivityCapture();
      try {
        await handler.finalize(decision.context as Readonly<TContext>, decision);
      } catch (err) {
        log.error('definePureState: finalize phase failed', {
          state: selfState,
          next: decision.next,
          error: String(err),
        });
        // Decision is committed — transition proceeds despite finalize failure
      }
      endActivityCapture();
    }

    return {
      context: decision.context,
      next: resolveNext(decision.next),
      response: decision.response,
      error: decision.error,
      activities: { prepare: prepareActivities, finalize: finalizeActivities },
    };
  };
}
