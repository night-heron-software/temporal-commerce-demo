/**
 * Authoring ergonomics for the state-machine framework.
 *
 * Implements the readability suggestions from the state-machine critique (§7):
 *  - §7.5 typed terminals      → `terminal(reason)` + `Terminal<R>`
 *  - §7.1 co-located phases    → `defineTransitions()` (one event = one entry,
 *                                its prepare/decide/finalize together)
 *  - §7.6 fewer generics       → `defineDomain<…>()` binds the shared type params once
 *  - §7.2 declarative façade   → `route()` for routing-only states
 *  - §7.4 compile-time purity  → per-event `decide` return type excludes Promise
 *
 * Everything here is ADDITIVE and compiles down to the existing
 * `definePureState` → `runStateMachine` driver. The driver's execution semantics
 * (prepare → decide → finalize, FIFO queue, durability) are unchanged.
 */

import { definePureState } from './pure-state';
import type {
  DecisionResult,
  PureStateHandler,
  StateConfig,
  StateInput,
  StateFunction,
} from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ── §7.5 Typed terminals ───────────────────────────────────────────────

/** A terminal state name, branded by its reason. */
export type Terminal<R extends string> = `__terminal:${R}`;

/**
 * Build a terminal state name without the stringly-typed `__terminal:` prefix.
 * Constrain the reason to catch typos at compile time:
 *   terminal<'cancelled' | 'complete'>('cancelled')  // ok
 *   terminal<'cancelled' | 'complete'>('canceled')   // compile error
 */
export function terminal<R extends string>(reason: R): Terminal<R> {
  return `__terminal:${reason}`;
}

/**
 * Test the read side of a terminal without hardcoding the `__terminal:` prefix —
 * the companion to `terminal()`. `isTerminal(state)` is true for any terminal;
 * `isTerminal(state, 'complete')` is true only for that specific terminal. Use this in
 * `onTerminal`/`onCancellation` hooks instead of `state === '__terminal:complete'`.
 */
export function isTerminal(state: string, reason?: string): boolean {
  return reason === undefined ? state.startsWith('__terminal:') : state === `__terminal:${reason}`;
}

// ── §7.1 Co-located per-event transitions ──────────────────────────────

/** A decision target: another state, or a terminal. */
type Next<TState extends string> = TState | `__terminal:${string}`;

/** A decision that is statically guaranteed not to be a Promise (§7.4). */
type SyncDecision<TState extends string, TContext, TResponse, TFinalize> =
  DecisionResult<TState, TContext, TResponse, TFinalize> & { then?: never };

/** One event's three phases, co-located. `prepare`/`finalize` optional. */
export interface TransitionHandler<
  TState extends string,
  TContext,
  TResponse,
  TEventMember,
  TPrepared = void,
  TFinalize = void,
> {
  /** Impure, async. Gather data / call activities for this event. */
  prepare?: (ctx: Readonly<TContext>, event: TEventMember) => Promise<TPrepared>;
  /**
   * Pure, synchronous. Compute the transition. Must not be async (§7.4).
   * `meta` carries the deterministic `input.timestamp` (matching the signal/timeout
   * decides) so handlers stamp records from it rather than reaching for `Date.now()`.
   */
  decide: (
    ctx: Readonly<TContext>,
    event: TEventMember,
    meta: InputMeta,
    prepared: TPrepared,
  ) => SyncDecision<TState, TContext, TResponse, TFinalize>;
  /** Impure, async. Commit side effects after the decision. */
  finalize?: (
    ctx: Readonly<TContext>,
    decision: DecisionResult<TState, TContext, TResponse, TFinalize>,
  ) => Promise<void>;
}

/**
 * Metadata about the driver input, passed to timeout/signal `decide`. Exposes the
 * deterministic `input.timestamp` so signal handlers can stamp history entries
 * (e.g. fulfiller-order status history) without reaching for `Date.now()`.
 */
export interface InputMeta {
  /** ISO-8601 timestamp of the input, supplied deterministically by the driver. */
  timestamp: string;
}

/**
 * One signal kind's three phases, co-located — the signal-side analogue of
 * `TransitionHandler`. Identical in shape except `decide` additionally receives
 * `meta` (matching the legacy `onSignal.decide` arg order) so handlers can stamp
 * history entries with the deterministic `meta.timestamp` rather than `Date.now()`.
 */
export interface SignalHandler<
  TState extends string,
  TContext,
  TResponse,
  TSignalMember,
  TPrepared = void,
  TFinalize = void,
> {
  /** Impure, async. Gather data / call activities for this signal kind. */
  prepare?: (ctx: Readonly<TContext>, signal: TSignalMember) => Promise<TPrepared>;
  /** Pure, synchronous. Compute the transition. Must not be async (§7.4). */
  decide: (
    ctx: Readonly<TContext>,
    signal: TSignalMember,
    meta: InputMeta,
    prepared: TPrepared,
  ) => SyncDecision<TState, TContext, TResponse, TFinalize>;
  /** Impure, async. Commit side effects after the decision. */
  finalize?: (
    ctx: Readonly<TContext>,
    decision: DecisionResult<TState, TContext, TResponse, TFinalize>,
  ) => Promise<void>;
}

/**
 * Per-kind signal dispatch map — the signal-side analogue of `TransitionMap`.
 * Each `kind` of a discriminated-union signal gets its own named `SignalHandler`,
 * so signals are authored exactly like updates. Only available when `TSignal` is a
 * discriminated union (`{ kind: string }`); single-payload signals use `onSignal`.
 */
export type SignalMap<TState extends string, TContext, TResponse, TSignal> =
  TSignal extends { kind: string }
    ? {
        [K in TSignal['kind']]?: SignalHandler<
          TState,
          TContext,
          TResponse,
          Extract<TSignal, { kind: K }>,
          Any,
          Any
        >;
      }
    : never;

/**
 * Handlers for the non-event inputs (timeout / signal) of a state.
 * `prepare` (impure I/O, e.g. polling) runs before `decide`; its result is passed to
 * `decide` as the final `prepared` argument. `decide` stays pure/synchronous.
 *
 * Signals dispatch two ways — use one per state:
 *  - `onSignals` — a per-kind map (preferred for discriminated-union signals); a signal whose
 *    `kind` has no entry stays in the current state.
 *  - `onSignal`  — a single catch-all (single-payload signals, or signal-ignoring states).
 * If both are supplied, `onSignals` is authoritative and `onSignal` is ignored.
 */
export interface InputHandlers<TState extends string, TContext, TResponse, TSignal> {
  onTimeout?: {
    prepare?: (ctx: Readonly<TContext>) => Promise<Any>;
    decide: (ctx: Readonly<TContext>, meta: InputMeta, prepared?: Any) => SyncDecision<TState, TContext, TResponse, Any>;
    finalize?: (ctx: Readonly<TContext>, decision: DecisionResult<TState, TContext, TResponse, Any>) => Promise<void>;
  };
  onSignal?: {
    prepare?: (ctx: Readonly<TContext>, signal: TSignal) => Promise<Any>;
    decide: (ctx: Readonly<TContext>, signal: TSignal, meta: InputMeta, prepared?: Any) => SyncDecision<TState, TContext, TResponse, Any>;
    finalize?: (ctx: Readonly<TContext>, decision: DecisionResult<TState, TContext, TResponse, Any>) => Promise<void>;
  };
  onSignals?: SignalMap<TState, TContext, TResponse, TSignal>;
}

/** Map of event discriminant → its co-located transition handler. */
export type TransitionMap<
  TState extends string,
  TContext,
  TResponse,
  TEvent extends { type: string },
> = {
  [K in TEvent['type']]?: TransitionHandler<
    TState,
    TContext,
    TResponse,
    Extract<TEvent, { type: K }>,
    Any,
    Any
  >;
};

// Internal boxed prepared/finalize payloads carry the originating key so the
// composite decide/finalize can route to the right per-event handler.
interface Boxed {
  __t: string;
  payload: unknown;
}

/**
 * Compose co-located per-event transitions into a single `PureStateHandler`
 * for the existing driver. The duplicated `switch (event.type)` across separate
 * prepare and decide phases (the critique's headline problem) disappears: each
 * event's phases live in one object.
 */
export function defineTransitions<
  TState extends string,
  TEvent extends { type: string },
  TContext,
  TResponse,
  TSignal = never,
>(
  self: TState,
  map: TransitionMap<TState, TContext, TResponse, TEvent>,
  inputs: InputHandlers<TState, TContext, TResponse, TSignal> = {},
): StateConfig<TState, TEvent, TContext, TResponse, TSignal> {
  const table = map as unknown as Record<string, TransitionHandler<TState, TContext, TResponse, Any, Any, Any>>;
  const signalTable = inputs.onSignals as
    | Record<string, SignalHandler<TState, TContext, TResponse, Any, Any, Any>>
    | undefined;

  const handler: PureStateHandler<TState, TEvent, TContext, TResponse, TSignal, Boxed, Boxed> = {
    async prepare(ctx, input: StateInput<TEvent, TSignal>): Promise<Boxed> {
      if (input.kind === 'event') {
        const t = table[input.event.type];
        const payload = t?.prepare ? await t.prepare(ctx, input.event as Any) : undefined;
        return { __t: input.event.type, payload };
      }
      if (input.kind === 'timeout') {
        const payload = inputs.onTimeout?.prepare ? await inputs.onTimeout.prepare(ctx) : undefined;
        return { __t: '__timeout', payload };
      }
      // signal — per-kind map (onSignals) takes precedence over the catch-all onSignal.
      if (signalTable) {
        const k = (input.result as Any).kind as string;
        const h = signalTable[k];
        const payload = h?.prepare ? await h.prepare(ctx, input.result as Any) : undefined;
        return { __t: `__signal:${k}`, payload };
      }
      const payload = inputs.onSignal?.prepare ? await inputs.onSignal.prepare(ctx, input.result) : undefined;
      return { __t: '__signal', payload };
    },

    decide(ctx, input: StateInput<TEvent, TSignal>, prepared: Boxed): DecisionResult<TState, TContext, TResponse, Boxed> {
      const wrap = (
        d: DecisionResult<TState, TContext, TResponse, Any>,
        key: string,
        hasFinalize: boolean,
      ): DecisionResult<TState, TContext, TResponse, Boxed> =>
        hasFinalize && d.finalize !== undefined
          ? { ...d, finalize: { __t: key, payload: d.finalize } }
          : { ...d, finalize: undefined };

      if (input.kind === 'event') {
        const t = table[input.event.type];
        if (!t) {
          return { context: ctx as TContext, next: self, error: `No transition for '${input.event.type}' in state '${self}'` };
        }
        return wrap(
          t.decide(ctx, input.event as Any, { timestamp: input.timestamp }, prepared.payload),
          input.event.type,
          !!t.finalize,
        );
      }
      if (input.kind === 'timeout') {
        if (!inputs.onTimeout) return { context: ctx as TContext, next: self };
        return wrap(
          inputs.onTimeout.decide(ctx, { timestamp: input.timestamp }, prepared.payload),
          '__timeout',
          !!inputs.onTimeout.finalize,
        );
      }
      // signal — per-kind map (onSignals) takes precedence; an unmapped kind stays in state.
      if (signalTable) {
        const k = (input.result as Any).kind as string;
        const h = signalTable[k];
        if (!h) return { context: ctx as TContext, next: self };
        return wrap(
          h.decide(ctx, input.result as Any, { timestamp: input.timestamp }, prepared.payload),
          `__signal:${k}`,
          !!h.finalize,
        );
      }
      if (!inputs.onSignal) return { context: ctx as TContext, next: self };
      return wrap(
        inputs.onSignal.decide(ctx, input.result, { timestamp: input.timestamp }, prepared.payload),
        '__signal',
        !!inputs.onSignal.finalize,
      );
    },

    async finalize(ctx, decision: DecisionResult<TState, TContext, TResponse, Boxed>): Promise<void> {
      const box = decision.finalize;
      if (!box) return;
      const t =
        box.__t === '__timeout'
          ? inputs.onTimeout
          : box.__t === '__signal'
            ? inputs.onSignal
            : box.__t.startsWith('__signal:')
              ? signalTable?.[box.__t.slice('__signal:'.length)]
              : table[box.__t];
      if (t?.finalize) {
        await t.finalize(ctx, { ...decision, finalize: box.payload } as Any);
      }
    },
  };

  return { fn: definePureState(handler, self) };
}

// ── §7.2 Declarative façade for routing-only states ────────────────────

/** A table of event → next-state (or terminal) for states that do no I/O. */
export type RouteTable<TState extends string, TEvent extends { type: string }> = {
  [K in TEvent['type']]?: Next<TState>;
};

/**
 * Build a routing-only state from a declarative table — the closest analogue to
 * XState's `on: { … }`. Each event maps straight to a next state; context is
 * carried through unchanged. For anything needing I/O, use `defineTransitions`.
 */
export function route<
  TState extends string,
  TEvent extends { type: string },
  TContext,
  TResponse,
  TSignal = never,
>(
  self: TState,
  table: RouteTable<TState, TEvent>,
  options: { timeout?: Next<TState>; signal?: Next<TState> } = {},
): StateConfig<TState, TEvent, TContext, TResponse, TSignal> {
  const handler: PureStateHandler<TState, TEvent, TContext, TResponse, TSignal, void, void> = {
    decide(ctx, input): DecisionResult<TState, TContext, TResponse, void> {
      if (input.kind === 'event') {
        const next = (table as unknown as Record<string, Next<TState> | undefined>)[input.event.type];
        return { context: ctx as TContext, next: next ?? self };
      }
      if (input.kind === 'timeout') return { context: ctx as TContext, next: options.timeout ?? self };
      return { context: ctx as TContext, next: options.signal ?? self };
    },
  };
  return { fn: definePureState(handler, self) };
}

// ── §7.6 Domain factory — bind the shared generics once ────────────────

/**
 * Capture a domain's shared type parameters once, returning helpers that no
 * longer require re-declaring them on every state. Replaces the seven-parameter
 * `PureStateHandler<…>` ceremony at each call site.
 *
 *   const cart = defineDomain<CartStateName, CartEvent, CartCtx, CartResponse, CartSignal>();
 *   const active = cart.transitions('active', { addItem: { prepare, decide } });
 *   const review = cart.route('review', { submit: 'paying', cancel: cart.terminal('cancelled') });
 */
export function defineDomain<
  TState extends string,
  TEvent extends { type: string },
  TContext,
  TResponse,
  TSignal = never,
>() {
  return {
    /** Co-located per-event transitions (§7.1). */
    transitions: (
      self: TState,
      map: TransitionMap<TState, TContext, TResponse, TEvent>,
      inputs?: InputHandlers<TState, TContext, TResponse, TSignal>,
    ) => defineTransitions<TState, TEvent, TContext, TResponse, TSignal>(self, map, inputs),

    /** Declarative routing-only state (§7.2). */
    route: (
      self: TState,
      table: RouteTable<TState, TEvent>,
      options?: { timeout?: Next<TState>; signal?: Next<TState> },
    ) => route<TState, TEvent, TContext, TResponse, TSignal>(self, table, options),

    /** Wrap an existing prepare/decide/finalize handler (escape hatch). */
    state: <TPrepared = void, TFinalize = void>(
      self: TState,
      handler: PureStateHandler<TState, TEvent, TContext, TResponse, TSignal, TPrepared, TFinalize>,
    ): StateConfig<TState, TEvent, TContext, TResponse, TSignal> => ({
      fn: definePureState(handler, self) as StateFunction<TState, TEvent, TContext, TResponse, TSignal>,
    }),

    /** Typed terminal (§7.5). */
    terminal,
  };
}
