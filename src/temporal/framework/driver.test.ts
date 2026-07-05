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
let canPayload: unknown;
const handlers = new Map<unknown, (...a: unknown[]) => void>();
// Captures batches handed to the persistWorkflowTransitions activity (ADR-0010 recorder).
let persistedBatches: Array<Array<Record<string, unknown>>> = [];

vi.mock('@temporalio/workflow', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
  isCancellation: () => false,
  CancellationScope: { nonCancellable: async (fn: () => Promise<void>) => fn() },
  ApplicationFailure: { nonRetryable: (m: string) => new Error(m) },
  proxyActivities: () => ({
    persistWorkflowTransitions: async (records: Array<Record<string, unknown>>) => {
      persistedBatches.push(records);
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
});
