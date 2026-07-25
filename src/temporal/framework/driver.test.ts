import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Driver-level tests for the continue-as-new (CAN) threshold counting.
 *
 * The fix under test: the driver counts EVERY processed input (update, signal, or
 * timeout) toward the CAN threshold — not just updates. A purely signal-driven
 * workflow (e.g. the identity account lifecycle) must be able to continue-as-new so
 * its history stays bounded; counting only updates would never fire.
 *
 * The Temporal workflow runtime is mocked so the otherwise-pure driver loop runs
 * in-process: `condition` polls its predicate across microtasks (mirroring the real
 * "resolve when the predicate holds" semantics), and `continueAsNew` throws a sentinel
 * the way Temporal does — so the loop unwinds and we can inspect the serialized payload.
 */

class ContinueAsNewError extends Error {}
// vi.hoisted: the mock factory references these classes eagerly (`TemporalFailure:
// MockTemporalFailure`), so they must initialize before the hoisted vi.mock runs.
// MockTemporalFailure mirrors the SDK's failure hierarchy — only TemporalFailure
// subclasses close a workflow (the driver's failure-path mark gates on instanceof).
// MockCancelledError is the sentinel recognized by the mocked isCancellation.
const { MockTemporalFailure, MockCancelledError } = vi.hoisted(() => {
  class MockTemporalFailure extends Error {}
  class MockCancelledError extends Error {}
  return { MockTemporalFailure, MockCancelledError };
});
let canPayload: unknown;
const handlers = new Map<unknown, (...a: unknown[]) => void>();
// Captures batches handed to the persistWorkflowTransitions activity (ADR-0010 recorder).
let persistedBatches: Array<Array<Record<string, unknown>>> = [];
// Captures calls to the markProjectionsCompleted activity (projection completion).
let markedCalls: Array<Record<string, unknown>> = [];
// Ordered log of domain hooks + marks, for asserting the mark runs after the hook.
let callOrder: string[] = [];

vi.mock('@temporalio/workflow', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setHandler: (def: unknown, fn: (...a: unknown[]) => void) => {
    handlers.set(def, fn);
  },
  condition: async (pred: () => boolean) => {
    for (let i = 0; i < 100_000; i++) {
      if (pred()) return true;
      await Promise.resolve();
    }
    throw new Error('test condition never satisfied');
  },
  continueAsNew: (input: unknown) => {
    canPayload = input;
    throw new ContinueAsNewError();
  },
  allHandlersFinished: () => true,
  isCancellation: (e: unknown) => e instanceof MockCancelledError,
  CancellationScope: { nonCancellable: async (fn: () => Promise<void>) => fn() },
  ApplicationFailure: { nonRetryable: (m: string) => new MockTemporalFailure(m) },
  TemporalFailure: MockTemporalFailure,
  proxyActivities: () => ({
    persistWorkflowTransitions: async (records: Array<Record<string, unknown>>) => {
      persistedBatches.push(records);
    },
    markProjectionsCompleted: async (input: Record<string, unknown>) => {
      markedCalls.push(input);
      callOrder.push('mark');
    },
  }),
  workflowInfo: () => ({
    workflowId: 'store-1.cart.entity-1',
    runId: 'run-1',
    workflowType: 'cartWorkflow',
    searchAttributes: { StoreId: ['store-1'], CorrelationId: ['cart-1'], Domain: ['cart'] },
  }),
}));

import { runStateMachine } from './driver';
import type { StateMachineConfig, SignalRegistration } from './types';

interface Ctx {
  count: number;
}
type State = 'live';
type Sig = { kind: 'bump' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const THRESHOLD = 3;
const serialize = (ctx: Ctx, state: State) => ({ restored: ctx, state });

beforeEach(() => {
  handlers.clear();
  canPayload = undefined;
  persistedBatches = [];
  markedCalls = [];
  callOrder = [];
});

describe('runStateMachine — continue-as-new threshold counts every input', () => {
  it('counts signals and fires continue-as-new at the threshold', async () => {
    const config: StateMachineConfig<State, never, Ctx, void, Sig> = {
      states: {
        live: {
          fn: async (ctx: Ctx, input: { kind: string }) =>
            input.kind === 'signal'
              ? { context: { count: ctx.count + 1 }, next: 'live' }
              : { context: ctx, next: 'live' },
        },
      } as Any,
      initialState: 'live',
      transitionRecording: { enabled: false },
      continueAsNewThreshold: THRESHOLD,
      serializeForContinueAsNew: serialize as Any,
    };
    const bumpDef = { name: 'bump' };
    const signals: SignalRegistration<Sig>[] = [
      { definition: bumpDef as Any, toSignal: () => ({ kind: 'bump' }) },
    ];

    // Start the loop (registers handlers synchronously, then parks on `condition`),
    // then deliver exactly THRESHOLD signals.
    const promise = runStateMachine(config, { count: 0 }, [], signals);
    const bump = handlers.get(bumpDef)!;
    for (let i = 0; i < THRESHOLD; i++) bump();

    await expect(promise).rejects.toBeInstanceOf(ContinueAsNewError);
    // Serialized payload reflects the live state and the context after 3 signals.
    expect(canPayload).toEqual({ restored: { count: THRESHOLD }, state: 'live' });
  });

  it('counts timeouts too (transitional self-loop fires CAN at the threshold)', async () => {
    const config: StateMachineConfig<State, never, Ctx, void, Sig> = {
      states: {
        live: {
          transitional: true,
          fn: async (ctx: Ctx) => ({ context: { count: ctx.count + 1 }, next: 'live' }),
        },
      } as Any,
      initialState: 'live',
      transitionRecording: { enabled: false },
      continueAsNewThreshold: THRESHOLD,
      serializeForContinueAsNew: serialize as Any,
    };

    await expect(runStateMachine(config, { count: 0 }, [], [])).rejects.toBeInstanceOf(
      ContinueAsNewError,
    );
    expect(canPayload).toEqual({ restored: { count: THRESHOLD }, state: 'live' });
  });

  it('does not continue-as-new when no serializer is configured', async () => {
    let timeouts = 0;
    const config: StateMachineConfig<State, never, Ctx, void, Sig> = {
      states: {
        live: {
          transitional: true,
          fn: async (ctx: Ctx) => {
            timeouts += 1;
            // Reach a terminal after a few inputs so the loop ends naturally.
            return timeouts >= THRESHOLD + 2
              ? { context: ctx, next: '__terminal:done' }
              : { context: { count: ctx.count + 1 }, next: 'live' };
          },
        },
      } as Any,
      initialState: 'live',
      transitionRecording: { enabled: false },
      continueAsNewThreshold: THRESHOLD,
      // no serializeForContinueAsNew
    };

    await runStateMachine(config, { count: 0 }, [], []);
    expect(canPayload).toBeUndefined();
  });
});

describe('runStateMachine — transition recording (ADR-0010)', () => {
  type RState = 'a' | 'b';

  it('records the initial state + each transition and flushes at terminal', async () => {
    const config: StateMachineConfig<RState, never, Ctx, void> = {
      states: {
        a: { transitional: true, fn: async (ctx: Ctx) => ({ context: ctx, next: 'b' }) },
        b: {
          transitional: true,
          fn: async (ctx: Ctx) => ({ context: ctx, next: '__terminal:done' }),
        },
      } as Any,
      initialState: 'a',
    };

    await runStateMachine(config, { count: 0 }, [], []);

    const records = persistedBatches.flat();
    // ∅ → a (start), a → b, b → __terminal:done
    expect(records.map((r) => [r.fromState, r.toState, r.triggerKind])).toEqual([
      ['', 'a', 'start'],
      ['a', 'b', 'timeout'],
      ['b', '__terminal:done', 'timeout'],
    ]);
    // Tenant/correlation resolved from the mocked Search Attributes.
    expect(records[0]).toMatchObject({
      tenantId: 'store-1',
      workflowId: 'store-1.cart.entity-1',
      tags: { CorrelationId: 'cart-1', Domain: 'cart' },
      workflowType: 'cartWorkflow',
    });
    // Per-run monotonic seq.
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2]);
    // Full JSON snapshot of the context stored per transition.
    expect(JSON.parse(records[0].contextSnapshot as string)).toEqual({ count: 0 });
  });

  it('is a no-op when disabled', async () => {
    const config: StateMachineConfig<RState, never, Ctx, void> = {
      states: {
        a: {
          transitional: true,
          fn: async (ctx: Ctx) => ({ context: ctx, next: '__terminal:done' }),
        },
      } as Any,
      initialState: 'a',
      transitionRecording: { enabled: false },
    };

    await runStateMachine(config, { count: 0 }, [], []);
    expect(persistedBatches).toEqual([]);
  });

  it('persists the Update handler return value on update-driven transitions only', async () => {
    type Resp = { ok: boolean; total: number };
    const updDef = { name: 'setThing' };
    const config: StateMachineConfig<RState, never, Ctx, Resp> = {
      states: {
        a: {
          fn: async (ctx: Ctx, input: { kind: string }) =>
            // Updates are delivered to the state fn as kind 'event'.
            input.kind === 'event'
              ? { context: ctx, next: '__terminal:done', response: { ok: true, total: 42 } }
              : { context: ctx, next: 'a' },
        },
      } as Any,
      initialState: 'a',
    };
    const updates = [{ definition: updDef as Any, toEvent: () => ({ kind: 'setThing' }) }];

    const run = runStateMachine(config, { count: 0 }, updates as Any, []);
    const setThing = handlers.get(updDef)! as () => Promise<Resp>;
    const [response] = await Promise.all([setThing(), run]);

    // The caller still receives the response as before.
    expect(response).toEqual({ ok: true, total: 42 });

    const records = persistedBatches.flat();
    const updateRecord = records.find((r) => r.triggerKind === 'update');
    expect(updateRecord).toBeDefined();
    // The Update return value is persisted, serialized and size-capped, on the record.
    expect(JSON.parse(updateRecord!.updateResult as string)).toEqual({ ok: true, total: 42 });
    // Non-update-driven records (the ∅ → initial start record) carry no result.
    for (const r of records.filter((r) => r.triggerKind !== 'update')) {
      expect(r.updateResult).toBeUndefined();
    }
  });
});

describe('runStateMachine — projection completion at close', () => {
  const REFS = [{ index: 'carts', id: 'cart-1' }];

  /** One-state machine that closes however `fn` decides; records hook order. */
  const makeConfig = (
    fn: (ctx: Ctx) => Promise<{ context: Ctx; next: string }>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    overrides: Record<string, any> = {},
  ): StateMachineConfig<State, never, Ctx, void, Sig> =>
    ({
      states: { live: { transitional: true, fn } } as Any,
      initialState: 'live',
      transitionRecording: { enabled: false },
      projections: { refs: () => REFS },
      onTerminal: async () => {
        callOrder.push('onTerminal');
      },
      onCancellation: async () => {
        callOrder.push('onCancellation');
      },
      ...overrides,
    }) as Any;

  it('terminal close marks refs with outcome completed, after onTerminal', async () => {
    const config = makeConfig(async (ctx) => ({ context: ctx, next: '__terminal:done' }));

    await runStateMachine(config, { count: 0 }, [], []);

    expect(markedCalls).toHaveLength(1);
    expect(markedCalls[0]).toMatchObject({ refs: REFS, outcome: 'completed' });
    expect(typeof markedCalls[0].closedAt).toBe('string');
    expect(callOrder).toEqual(['onTerminal', 'mark']);
  });

  it('cancellation marks refs with outcome canceled, after onCancellation', async () => {
    const config = makeConfig(async () => {
      throw new MockCancelledError('cancelled');
    });

    await runStateMachine(config, { count: 0 }, [], []);

    expect(markedCalls).toHaveLength(1);
    expect(markedCalls[0]).toMatchObject({ refs: REFS, outcome: 'canceled' });
    expect(callOrder).toEqual(['onCancellation', 'mark']);
  });

  it('a TemporalFailure marks refs with outcome failed and still rejects with the original error', async () => {
    const boom = new MockTemporalFailure('boom');
    const config = makeConfig(async () => {
      throw boom;
    });

    await expect(runStateMachine(config, { count: 0 }, [], [])).rejects.toBe(boom);

    expect(markedCalls).toHaveLength(1);
    expect(markedCalls[0]).toMatchObject({ refs: REFS, outcome: 'failed' });
  });

  it('a plain Error (workflow-task retry, not a close) does not mark', async () => {
    const config = makeConfig(async () => {
      throw new Error('transient');
    });

    await expect(runStateMachine(config, { count: 0 }, [], [])).rejects.toThrow('transient');
    expect(markedCalls).toEqual([]);
  });

  it('continue-as-new does not mark (the workflow is not closing)', async () => {
    const config = makeConfig(async (ctx) => ({ context: { count: ctx.count + 1 }, next: 'live' }), {
      continueAsNewThreshold: 2,
      serializeForContinueAsNew: serialize as Any,
    });

    await expect(runStateMachine(config, { count: 0 }, [], [])).rejects.toBeInstanceOf(
      ContinueAsNewError,
    );
    expect(markedCalls).toEqual([]);
  });

  it('no projections config schedules no mark activity', async () => {
    const config = makeConfig(async (ctx) => ({ context: ctx, next: '__terminal:done' }), {
      projections: undefined,
    });

    await runStateMachine(config, { count: 0 }, [], []);
    expect(markedCalls).toEqual([]);
  });

  it('a marking failure never fails a completed workflow', async () => {
    const config = makeConfig(async (ctx) => ({ context: ctx, next: '__terminal:done' }), {
      projections: {
        refs: () => {
          throw new Error('refs blew up');
        },
      },
    });

    const result = await runStateMachine(config, { count: 0 }, [], []);
    expect(result).toEqual({ count: 0 });
    expect(markedCalls).toEqual([]);
  });
});
