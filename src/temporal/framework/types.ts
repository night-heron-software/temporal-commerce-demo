import { UpdateDefinition, Duration, SignalDefinition } from '@temporalio/common';

export type StateInput<TEvent, TSignal = never> =
  | { kind: 'event'; event: TEvent; timestamp: string }
  | { kind: 'signal'; result: TSignal; timestamp: string }
  | { kind: 'timeout'; timestamp: string };

/**
 * "Stay in the current state" sentinel for a decision's `next`.
 *
 * A route-table entry that means "remain where I am" uses SELF instead of naming
 * its own state. The machine compiler (`defineMachine`) substitutes the enclosing state
 * before the decision leaves the state function, so downstream code and history never
 * see the sentinel. This lets handlers that are SHARED across states (e.g. a guard that
 * rejects an edit and stays put) avoid hardcoding one state's name — which both reads as
 * the actual intent and lets the diagram generator resolve the edge to the right state
 * instead of leaking a phantom transition.
 */
export const SELF = '__self' as const;
export type Self = typeof SELF;

/** A captured activity call — its name, arguments, and result (or error). Values are size-capped. */
export interface ActivityCall {
  name: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  /**
   * Milliseconds the WORKFLOW waited on this activity — measured in workflow time, so it
   * spans dispatch + queue + execution (schedule-to-close as the workflow experienced it),
   * not the activity's own runtime. That is deliberately the number that explains a slow
   * transition: an activity doing 3ms of work behind 60ms of dispatch reads ~63ms here.
   *
   * Replay-safe: `Date.now()` inside a workflow is SDK-patched to workflow time, which is
   * reconstructed from history event timestamps — a replay recomputes the identical value.
   * Absent for calls whose completion the workflow never observed.
   */
  durationMs?: number;
}

export interface StateOutput<TState extends string, TContext, TResponse> {
  context: TContext;
  next: TState | `__terminal:${string}`;
  response?: TResponse;
  error?: string;
  /**
   * The input was REJECTED (ADR-0024): a guard refused it, prepare threw, or the state
   * does not accept the command. `error` carries the reason; `context` is unchanged and
   * `next` is the same state. The driver releases the caller with the error and skips
   * `onContextUpdate`, `onTransition`, and transition recording — a rejection is not a
   * transition and must not project. Only the decider-native surface sets this; outputs
   * without it behave exactly as before.
   */
  rejected?: boolean;
  /**
   * Activities called during this state's `prepare` and `finalize` phases (ADR-0010), with their
   * args + results. Populated by the machine compiler (`defineMachine`) via the activity-capture
   * interceptor; absent for raw states.
   */
  activities?: { prepare: ActivityCall[]; finalize: ActivityCall[] };
  /**
   * NOTHING HAPPENED: the state's timer elapsed and `onTimeout` synthesized no command
   * (returned null), so no command ran, no context changed, and the state is unchanged.
   * The driver skips `onTransition` AND transition recording — an idle tick is not a
   * transition, exactly as a rejection is not one.
   *
   * Set only by the machine compiler's timeout arm. It is a FACT reported by the state
   * function, deliberately not inferred by the driver from "same state + timeout input":
   * a timeout that DOES synthesize a command may legitimately route back to SELF while
   * mutating context (`'*': SELF` is a common route), and that is a real transition whose
   * effects must run. Inferring conflated the two (backlog #18).
   */
  idle?: boolean;
}

export type StateFunction<TState extends string, TEvent, TContext, TResponse, TSignal = never> = (
  ctx: Readonly<TContext>,
  input: StateInput<TEvent, TSignal>,
) => Promise<StateOutput<TState, TContext, TResponse>>;

export interface StateConfig<TState extends string, TEvent, TContext, TResponse, TSignal = never> {
  fn: StateFunction<TState, TEvent, TContext, TResponse, TSignal>;
  /**
   * How long this state waits for input before a timeout tick. A function form
   * resolves per loop iteration from the live context (ADR-0024: per-execution
   * timeouts — e.g. a fulfiller strategy descriptor tuning its poll cadence) —
   * deterministic inputs only, like everything in the sandbox.
   */
  timeout?: Duration | ((ctx: Readonly<TContext>) => Duration);
  transitional?: boolean;
}

export type StateRegistry<
  TState extends string,
  TEvent,
  TContext,
  TResponse,
  TSignal = never,
> = Record<TState, StateConfig<TState, TEvent, TContext, TResponse, TSignal>>;

export interface UpdateExchange<TEvent, TResponse> {
  event: TEvent;
  result?: TResponse;
  error?: string;
  processed: boolean;
}

export interface StateMachineConfig<
  TState extends string,
  TEvent,
  TContext,
  TResponse,
  TSignal = never,
> {
  states: StateRegistry<TState, TEvent, TContext, TResponse, TSignal>;
  initialState: TState;
  continueAsNewThreshold?: number;
  serializeForContinueAsNew?: (ctx: TContext, currentState: TState) => unknown;
  onTerminal?: (ctx: TContext, terminalState: string) => Promise<void>;
  onCancellation?: (ctx: TContext, currentState: TState | `__terminal:${string}`) => Promise<void>;
  onContextUpdate?: (ctx: TContext, currentState: TState | `__terminal:${string}`) => void;
  onStart?: (
    ctx: TContext,
  ) => Promise<{ context: TContext; nextState?: TState | `__terminal:${string}` }>;
  onTransition?: (
    from: TState,
    to: TState | `__terminal:${string}`,
    // 'automatic' = a transitional state advancing on its own; 'timeout' = a waiting
    // state's timer actually elapsed. Distinct so persisted transitions (ADR-0010)
    // and the order-trace display don't misreport self-advancement as a timeout.
    event: TEvent | 'timeout' | 'signal' | 'automatic',
    ctx: TContext,
    /** Deterministic ISO event-time of the transition — use this instead of reading the clock. */
    at: string,
  ) => Promise<void> | void;
  /**
   * Async state-transition recording (ADR-0010). On by default for every machine — tenant and
   * correlation tags are resolved by the convention identity resolver (Search Attributes with a
   * dot-delimited workflow-ID fallback), so no per-domain wiring is required. Pass
   * `{ enabled: false }` to opt a machine out, `serialize`/`redactPayload` to trim or scrub the
   * stored context snapshot / trigger payload, or `identity` to override how tenant/tags are
   * resolved.
   */
  transitionRecording?: TransitionRecordingConfig<TContext>;
  /**
   * ES projection docs owned by this workflow, marked completed at ANY close —
   * terminal, cancellation, or failure (via the {@link MARK_PROJECTIONS_ACTIVITY}
   * activity, after `onTerminal`/`onCancellation` so the domain's final re-index
   * cannot overwrite the mark). Omit for workflows that own no projection docs —
   * no activity is ever scheduled then.
   */
  projections?: ProjectionCompletionConfig<TContext, TState>;
}

/** See {@link StateMachineConfig.projections}. */
export interface ProjectionCompletionConfig<TContext, TState extends string> {
  /** Resolve the docs to mark from the final context; may return `[]`. */
  refs: (
    ctx: Readonly<TContext>,
    currentState: TState | `__terminal:${string}`,
  ) => ProjectionCompletionRef[];
}

/** One ES doc to stamp with the workflow-lifecycle fields at close. */
export interface ProjectionCompletionRef {
  index: string;
  id: string;
}

/** How the workflow closed, as recorded on its projection docs. */
export type ProjectionWorkflowOutcome = 'completed' | 'canceled' | 'failed';

/** What drove a transition. 'automatic' = a transitional state advancing by design. */
export interface TransitionTrigger {
  kind: 'start' | 'signal' | 'update' | 'timeout' | 'automatic';
  /** The update/signal event `type`, when the command carries one. */
  name?: string;
}

/** Per-transition input handed to the recorder (see {@link TransitionSink}). */
export interface TransitionRecordInput<TContext> {
  from: string;
  to: string;
  trigger: TransitionTrigger;
  triggerPayload?: unknown;
  context: Readonly<TContext>;
  /** Deterministic ISO workflow event-time. */
  at: string;
  /** Activities called in the state's prepare phase (beginning), with args + results. */
  prepareActivities?: ActivityCall[];
  /** Activities called in the state's finalize phase (end), with args + results. */
  finalizeActivities?: ActivityCall[];
  /** The Update handler's return value, when the transition was driven by an update. */
  updateResult?: unknown;
}

export interface TransitionRecordingConfig<TContext> {
  /** Default true. Set false to opt this machine out of transition recording. */
  enabled?: boolean;
  /** Transform the context before it is snapshotted (redact/trim). Default: the context as-is. */
  serialize?: (ctx: TContext) => unknown;
  /** Scrub a trigger payload before it is stored (e.g. drop secrets). Default: as-is. */
  redactPayload?: (trigger: TransitionTrigger, payload: unknown) => unknown;
  /**
   * Override how the workflow's tenant + correlation tags are resolved.
   * Default: `conventionIdentityResolver()` — tenant from the `StoreId` Search Attribute
   * (falling back to the dot-delimited workflow-ID convention), tags from every other custom
   * keyword Search Attribute.
   */
  identity?: TransitionIdentityResolver;
}

/** Tenant + correlation tags attached to every persisted transition of a workflow. */
export interface TransitionIdentity {
  /** Tenant partition key. When absent, recording is skipped — there is nothing to scope by. */
  tenantId?: string;
  /** Correlation tags persisted verbatim with each record (e.g. Domain, CorrelationId). */
  tags?: Record<string, string>;
}

/**
 * Resolves the current workflow's {@link TransitionIdentity}. Called once per workflow
 * execution, inside the workflow sandbox (deterministic APIs only). Return `undefined`
 * to skip recording for this workflow.
 */
export type TransitionIdentityResolver = () => TransitionIdentity | undefined;

/**
 * Name of the host-provided activity the transition recorder flushes batches to. Hosts register
 * an implementation under this name on every worker that runs recorded state machines (a no-op
 * is fine in tests). Also excluded from per-phase activity capture so the background flusher's
 * writes are never mis-attributed to a state.
 */
export const PERSIST_TRANSITIONS_ACTIVITY = 'persistWorkflowTransitions';

/**
 * Name of the host-provided activity that stamps ES projection docs completed at workflow
 * close. Hosts register an implementation under this name on every worker that runs state
 * machines with a `projections` config (a no-op is fine in tests). Also excluded from
 * per-phase activity capture, like {@link PERSIST_TRANSITIONS_ACTIVITY}.
 */
export const MARK_PROJECTIONS_ACTIVITY = 'markProjectionsCompleted';

/**
 * Wire shape of one persisted transition — the payload of the
 * {@link PERSIST_TRANSITIONS_ACTIVITY} activity. JSON-ish fields (`triggerPayload`,
 * `contextSnapshot`, `*Activities`) arrive pre-serialized and size-capped so the host side
 * just stores strings.
 */
export interface TransitionPersistRecord {
  tenantId: string;
  workflowId: string;
  /** Deterministic ISO workflow event-time of the transition. */
  at: string;
  runId: string;
  /** Per-run monotonic sequence number. */
  seq: number;
  workflowType: string;
  fromState: string;
  toState: string;
  triggerKind: string;
  triggerName?: string;
  triggerPayload?: string;
  contextSnapshot?: string;
  prepareActivities?: string;
  finalizeActivities?: string;
  /** The Update handler's return value, pre-serialized and size-capped. */
  updateResult?: string;
  /** Correlation tags from the workflow's {@link TransitionIdentity} (e.g. Domain, OrderId). */
  tags?: Record<string, string>;
}

/**
 * In-workflow async sink: `record` is a non-blocking O(1) enqueue; a background `runFlusher`
 * coroutine batch-persists off the hot path. `drain` awaits an empty buffer (before
 * continue-as-new / at terminal); `close` signals the flusher to finish.
 */
export interface TransitionSink<TContext> {
  record(input: TransitionRecordInput<TContext>): void;
  runFlusher(): Promise<void>;
  drain(): Promise<void>;
  close(): void;
}

export interface MappedUpdateRegistration<
  TEvent,
  TContext,
  TResponse,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TArgs extends any[] = any[],
> {
  definition: UpdateDefinition<TResponse, TArgs>;
  toEvent: (...args: TArgs) => TEvent;
  formatError?: (error: string, ctx: TContext) => TResponse;
  formatResponse?: (response: TResponse, ctx: TContext) => TResponse;
}

export type SingleUpdateRegistration<TEvent, TResponse> = UpdateDefinition<TResponse, [TEvent]>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SignalRegistration<TSignal, TArgs extends any[] = any[]> {
  definition: SignalDefinition<TArgs>;
  toSignal: (...args: TArgs) => TSignal;
}

/** Extract the terminal reason from '__terminal:reason' strings */
export type TerminalSuffix<T extends string> = T extends `__terminal:${infer R}` ? R : never;

// The shared `Decider` interface that once lived here (with `isTerminal` and a required
// `initialState`) was retired in clarity-plan Phase 4 — domains implement `MachineDecider`
// from './machine' instead: terminality belongs to route tables, and `initialState` is an
// optional test seam.
