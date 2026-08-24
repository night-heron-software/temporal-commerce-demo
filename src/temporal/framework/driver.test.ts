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
// Mutable so a test can turn on the server's continue-as-new suggestion (#20).
const infoState = { continueAsNewSuggested: false };
// Warnings the driver emitted this test (#22).
const warnCalls: string[] = [];
// Captures batches handed to the persistWorkflowTransitions activity (ADR-0010 recorder).
let persistedBatches: Array<Array<Record<string, unknown>>> = [];
// Captures calls to the markProjectionsCompleted activity (projection completion).
let markedCalls: Array<Record<string, unknown>> = [];
// Ordered log of domain hooks + marks, for asserting the mark runs after the hook.
let callOrder: string[] = [];

vi.mock('@temporalio/workflow', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    // Captured so a test can assert the driver SAID something, not merely that it behaved
    // (#22: an unresolved timeout must be visible, not silently absorbed).
    warn: (msg: string) => {
      warnCalls.push(msg);
    },
    error: vi.fn(),
  },
  setHandler: (def: unknown, fn: (...a: unknown[]) => void) => {
    handlers.set(def, fn);
  },
  condition: async (pred: () => boolean, timeout?: unknown) => {
    // Timed condition (the driver's state-input wait): a briefly-unsatisfied predicate
    // is a timeout, resolving false like the real API. The budget is deliberately small
    // so a "waiting" state times out before concurrent untimed conditions (the
    // recorder's flusher loop) exhaust their own safety budget.
    const budget = timeout !== undefined ? 100 : 100_000;
    for (let i = 0; i < budget; i++) {
      if (pred()) return true;
      await Promise.resolve();
    }
    if (timeout !== undefined) return false;
    // Untimed conditions (update exchanges) hanging forever is a test bug.
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
    // Server-driven continue-as-new hint. Tests flip this to assert the PRIMARY trigger
    // independently of the iteration bound (#20).
    continueAsNewSuggested: infoState.continueAsNewSuggested,
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
  infoState.continueAsNewSuggested = false;
  warnCalls.length = 0;
  persistedBatches = [];
  markedCalls = [];
  callOrder = [];
});

describe('runStateMachine — continue-as-new threshold counts every input', () => {
  it('counts signals and fires continue-as-new at the threshold', async () => {
    const config: StateMachineConfig<State, never, Ctx, void, Sig> = {
      states: {
        live: {
          // Declared because a waiting state must be (#22); the harness behaves identically,
          // since the driver previously passed its 1 ms default to `condition` regardless.
          timeout: '1 second',
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

  // ── The server's suggestion is the PRIMARY trigger (#20) ──────────────────────────
  // A fixed input count cannot approximate history size: an update running several
  // activities through prepare/finalize emits an order of magnitude more events than an
  // idle tick. Counting alone let a machine with expensive inputs sail past the point
  // Temporal wanted it to roll over. `continueAsNewSuggested` is the server's own view.
  it('continues as new on the SDK suggestion, well below the iteration bound', async () => {
    infoState.continueAsNewSuggested = true;
    let inputs = 0;
    const config: StateMachineConfig<State, never, Ctx, void, Sig> = {
      states: {
        live: {
          transitional: true,
          fn: async (ctx: Ctx) => {
            inputs += 1;
            return { context: { count: ctx.count + 1 }, next: 'live' };
          },
        },
      } as Any,
      initialState: 'live',
      transitionRecording: { enabled: false },
      // Bound set far out of reach, so ONLY the suggestion can fire this.
      continueAsNewThreshold: 10_000,
      serializeForContinueAsNew: serialize as Any,
    };

    await expect(runStateMachine(config, { count: 0 }, [], [])).rejects.toBeInstanceOf(
      ContinueAsNewError,
    );
    // Fired on the first pass — the bound was never approached.
    expect(inputs).toBeLessThan(10);
  });

  // The bound still stands on its own: a machine whose inputs are cheap enough that the
  // suggestion takes a very long time must still cap storage and per-run cost. Temporal's
  // best-practice list asks for both, and the pitfall was using the count INSTEAD of the
  // suggestion — not using it at all.
  it('still continues as new on the iteration bound when the server suggests nothing', async () => {
    infoState.continueAsNewSuggested = false;
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
    // ∅ → a (start), a → b, b → __terminal:done. Transitional states advance on their
    // own — recorded 'automatic', never 'timeout' (nothing elapsed).
    expect(records.map((r) => [r.fromState, r.toState, r.triggerKind])).toEqual([
      ['', 'a', 'start'],
      ['a', 'b', 'automatic'],
      ['b', '__terminal:done', 'automatic'],
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

  it("records a genuine elapsed wait as 'timeout' (distinct from transitional 'automatic')", async () => {
    const config: StateMachineConfig<RState, never, Ctx, void> = {
      states: {
        // Waits for input that never arrives — the timer elapses.
        a: {
          timeout: '1 second',
          fn: async (ctx: Ctx) => ({ context: ctx, next: '__terminal:done' }),
        },
      } as Any,
      initialState: 'a',
    };

    await runStateMachine(config, { count: 0 }, [], []);

    const records = persistedBatches.flat();
    expect(records.map((r) => [r.fromState, r.toState, r.triggerKind])).toEqual([
      ['', 'a', 'start'],
      ['a', '__terminal:done', 'timeout'],
    ]);
  });

  // ── An idle tick is not a transition (#18 / run -009 F-3) ────────────────────────────
  // `onTimeout` returning null means the timer elapsed and there was nothing to do. The
  // driver used to skip RECORDING such a tick while still firing `onTransition`, so effect
  // hooks ran for a no-op: a parked fulfiller order notified its parent every 15 s, the
  // parent re-signalled OMS, and OMS recorded a self-hop row plus a workflow history event
  // per tick — unbounded growth while parked.
  it('an idle tick fires no onTransition and records nothing', async () => {
    const seen: string[] = [];
    let ticks = 0;
    const config: StateMachineConfig<RState, never, Ctx, void> = {
      states: {
        a: {
          timeout: '1 second',
          // Three idle ticks (nothing synthesized — the state reports `idle` and stays
          // put), then terminate so the loop ends. Only the final, real transition may
          // fire the hook or be recorded.
          fn: async (ctx: Ctx) => {
            ticks += 1;
            return ticks > 3
              ? { context: ctx, next: '__terminal:done' }
              : { context: ctx, next: 'a', idle: true };
          },
        },
      } as Any,
      initialState: 'a',
      onTransition: async (from: string, to: string) => {
        seen.push(`${from}->${to}`);
      },
    };

    await runStateMachine(config, { count: 0 }, [], []);

    // Three no-ops produced NOTHING: no hook calls and no rows beyond the start row and
    // the genuine terminal transition. Pre-fix the hook fired four times.
    expect(seen).toEqual(['a->__terminal:done']);
    expect(persistedBatches.flat().map((r) => [r.fromState, r.toState])).toEqual([
      ['', 'a'],
      ['a', '__terminal:done'],
    ]);
  });

  // The other half, and the reason this is a FLAG rather than an inference: a timeout that
  // DOES synthesize a command may route back to SELF while mutating context. That is a real
  // transition — its effects must run and it must be recorded. Inferring "same state +
  // timeout input ⇒ nothing happened" silently swallowed exactly this case.
  it('a timeout-driven SELF transition that changes context still fires and records', async () => {
    const seen: string[] = [];
    let ticks = 0;
    const config: StateMachineConfig<RState, never, Ctx, void> = {
      states: {
        a: {
          timeout: '1 second',
          fn: async (ctx: Ctx) => {
            ticks += 1;
            return ticks >= 2
              ? { context: ctx, next: '__terminal:done' }
              : { context: { count: ctx.count + 1 }, next: 'a' }; // self-hop, context moved
          },
        },
      } as Any,
      initialState: 'a',
      onTransition: async (from: string, to: string) => {
        seen.push(`${from}->${to}`);
      },
    };

    await runStateMachine(config, { count: 0 }, [], []);

    expect(seen).toEqual(['a->a', 'a->__terminal:done']);
    expect(persistedBatches.flat().map((r) => [r.fromState, r.toState, r.triggerKind])).toEqual([
      ['', 'a', 'start'],
      ['a', 'a', 'timeout'],
      ['a', '__terminal:done', 'timeout'],
    ]);
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
          timeout: '1 second', // a waiting state must declare one (#22)
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
    const config = makeConfig(
      async (ctx) => ({ context: { count: ctx.count + 1 }, next: 'live' }),
      {
        continueAsNewThreshold: 2,
        serializeForContinueAsNew: serialize as Any,
      },
    );

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

// ── A waiting state must declare how long it waits (#22) ─────────────────────────────
// Before this, omitting `timeout` fell to a 1 ms default: a thousand wakes a second, each a
// workflow task and history events, all counted toward continue-as-new — no error, no
// warning, the machine just ran hot. Every state in this repo declares one; an omission has
// only ever been a mistake.
describe('runStateMachine — a waiting state must declare a timeout (#22)', () => {
  it('refuses to start when a non-transitional state declares no timeout', async () => {
    const config: StateMachineConfig<'live', never, Ctx, void> = {
      states: { live: { fn: async (ctx: Ctx) => ({ context: ctx, next: 'live' }) } } as Any,
      initialState: 'live',
      transitionRecording: { enabled: false },
    };

    await expect(runStateMachine(config, { count: 0 }, [], [])).rejects.toThrow(
      /waiting state\(s\) \[live\] declare no timeout/,
    );
  });

  // Transitional states never wait — they synthesise their input and advance — so requiring a
  // timeout of them would be nonsense.
  it('does not require a timeout of a transitional state', async () => {
    const config: StateMachineConfig<'live', never, Ctx, void> = {
      states: {
        live: {
          transitional: true,
          fn: async (ctx: Ctx) => ({ context: ctx, next: '__terminal:done' }),
        },
      } as Any,
      initialState: 'live',
      transitionRecording: { enabled: false },
    };

    await expect(runStateMachine(config, { count: 0 }, [], [])).resolves.toBeDefined();
  });

  // The check runs against the registry the driver was HANDED, not a module-level constant:
  // `buildFulfillerOrderStates()` ships a base registry whose waiting states omit `timeout`
  // and spreads memo-derived durations in at run time. That correct pattern must pass.
  it('accepts a timeout injected into the registry at build time', async () => {
    const base = { live: { fn: async (ctx: Ctx) => ({ context: ctx, next: '__terminal:done' }) } };
    const built = { ...base, live: { ...base.live, timeout: '1 second' } };
    const config: StateMachineConfig<'live', never, Ctx, void> = {
      states: built as Any,
      initialState: 'live',
      transitionRecording: { enabled: false },
    };

    await expect(runStateMachine(config, { count: 0 }, [], [])).resolves.toBeDefined();
  });

  // A declared FUNCTION can still resolve to nothing on a given iteration. That must park the
  // machine and say so — never fall back to spinning.
  it('parks and warns when a timeout function resolves to nothing', async () => {
    let calls = 0;
    const config: StateMachineConfig<'live', never, Ctx, void> = {
      states: {
        live: {
          timeout: () => (calls++ === 0 ? undefined : '1 second'),
          fn: async (ctx: Ctx) => ({ context: ctx, next: '__terminal:done' }),
        },
      } as Any,
      initialState: 'live',
      transitionRecording: { enabled: false },
    };

    await runStateMachine(config, { count: 0 }, [], []);
    expect(warnCalls.some((m) => /resolved to nothing/.test(m))).toBe(true);
  });
});

describe('runStateMachine — per-execution state timeouts (ADR-0024)', () => {
  it('resolves a timeout function from the live context each iteration', async () => {
    const resolved: number[] = [];
    const config: StateMachineConfig<'live', never, Ctx, void> = {
      states: {
        live: {
          timeout: (ctx: Ctx) => {
            resolved.push(ctx.count);
            return '5 minutes';
          },
          fn: async (ctx: Ctx) =>
            ctx.count >= 2
              ? { context: ctx, next: '__terminal:done' }
              : { context: { count: ctx.count + 1 }, next: 'live' },
        },
      } as Any,
      initialState: 'live',
      transitionRecording: { enabled: false },
    };
    await runStateMachine(config, { count: 0 }, [], []);
    // Called once per wait, with the CURRENT context — 0, then 1, then 2.
    expect(resolved).toEqual([0, 1, 2]);
  });
});

describe('runStateMachine — rejected outputs (ADR-0024)', () => {
  type Ev = { type: 'bad' } | { type: 'good' } | { type: 'finish' };

  it('a rejection releases the caller with the error but neither transitions nor records', async () => {
    const transitions: Array<{ from: string; to: string }> = [];
    const contextUpdates: number[] = [];
    const config: StateMachineConfig<'live', Ev, Ctx, Ctx> = {
      states: {
        live: {
          timeout: '1 second', // a waiting state must declare one (#22)
          fn: async (ctx: Ctx, input: { kind: string; event?: Ev }) => {
            if (input.kind !== 'event') return { context: ctx, next: 'live' };
            if (input.event!.type === 'bad') {
              // What the decider-native surface returns for a guard refusal:
              // error out, context untouched, marked rejected.
              return { context: ctx, next: 'live', error: 'guard said no', rejected: true };
            }
            if (input.event!.type === 'finish') {
              return { context: ctx, next: '__terminal:done' };
            }
            return {
              context: { count: ctx.count + 1 },
              next: 'live',
              response: { count: ctx.count + 1 },
            };
          },
        },
      } as Any,
      initialState: 'live',
      onContextUpdate: (ctx) => {
        contextUpdates.push(ctx.count);
      },
      onTransition: async (from, to) => {
        transitions.push({ from, to });
      },
    };
    const updateDef = { name: 'apply' };

    const promise = runStateMachine(config, { count: 0 }, updateDef as Any);
    const apply = handlers.get(updateDef)! as (e: Ev) => Promise<Ctx>;

    // Rejected: the caller gets the typed error (single-update form throws it).
    await expect(apply({ type: 'bad' })).rejects.toThrow('guard said no');
    // Accepted: normal transition, response returned.
    await expect(apply({ type: 'good' })).resolves.toEqual({ count: 1 });
    await apply({ type: 'finish' });
    await promise;

    // The rejection fired no hooks: onContextUpdate/onTransition saw only the two
    // real transitions (good → live, finish → terminal).
    expect(transitions).toEqual([
      { from: 'live', to: 'live' },
      { from: 'live', to: '__terminal:done' },
    ]);
    expect(contextUpdates).toEqual([1, 1]);

    // And recorded nothing: initial start record + the two real transitions only —
    // no record whose trigger is the rejected 'bad' command.
    const records = persistedBatches.flat();
    expect(records.map((r) => r.triggerName ?? r.triggerKind)).toEqual(['start', 'good', 'finish']);
  });
});
