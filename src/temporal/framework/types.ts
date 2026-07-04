import { UpdateDefinition, Duration, SignalDefinition } from '@temporalio/common';

export type StateInput<TEvent, TSignal = never> =
  | { kind: 'event'; event: TEvent; timestamp: string }
  | { kind: 'signal'; result: TSignal; timestamp: string }
  | { kind: 'timeout'; timestamp: string };

/**
 * "Stay in the current state" sentinel for a decision's `next`.
 *
 * A `decide` that means "remain where I am" returns `next: SELF` instead of naming
 * its own state. The driver (`definePureState`) substitutes the enclosing `selfState`
 * before the decision leaves the state function, so downstream code and history never
 * see the sentinel. This lets handlers that are SHARED across states (e.g. a guard that
 * rejects an edit and stays put) avoid hardcoding one state's name — which both reads as
 * the actual intent and lets the diagram generator resolve the edge to the right state
 * instead of leaking a phantom transition.
 */
export const SELF = '__self' as const;
export type Self = typeof SELF;

/**
 * The result of the pure decide phase — the transition decision
 * and any instructions for the finalize phase.
 */
export interface DecisionResult<TState extends string, TContext, TResponse, TFinalize = void> {
  context: TContext;
  next: TState | `__terminal:${string}` | Self;
  response?: TResponse;
  error?: string;
  /** Data to pass to the finalize phase. Omit or set to undefined to skip finalization. */
  finalize?: TFinalize;
}

/**
 * A state handler structured as prepare → decide → finalize.
 *
 * - prepare:  Gather data from activities. MAY throw. MAY be omitted.
 * - decide:   Pure function. MUST NOT call activities. MUST NOT throw. MUST be synchronous.
 * - finalize: Execute side effects based on the decision. MAY throw. MAY be omitted.
 */
export interface PureStateHandler<
  TState extends string,
  TEvent,
  TContext,
  TResponse,
  TSignal = never,
  TPrepared = void,
  TFinalize = void,
> {
  /** Gather data from activities before the decision. */
  prepare?: (ctx: Readonly<TContext>, input: StateInput<TEvent, TSignal>) => Promise<TPrepared>;

  /** Pure decision function. MUST be synchronous. MUST NOT call activities or throw. */
  decide: (
    ctx: Readonly<TContext>,
    input: StateInput<TEvent, TSignal>,
    prepared: TPrepared,
  ) => DecisionResult<TState, TContext, TResponse, TFinalize>;

  /** Execute side effects after the decision. */
  finalize?: (
    ctx: Readonly<TContext>,
    decision: DecisionResult<TState, TContext, TResponse, TFinalize>,
  ) => Promise<void>;
}

/** A captured activity call — its name, arguments, and result (or error). Values are size-capped. */
export interface ActivityCall {
  name: string;
  args?: unknown;
  result?: unknown;
  error?: string;
}

export interface StateOutput<TState extends string, TContext, TResponse> {
  context: TContext;
  next: TState | `__terminal:${string}`;
  response?: TResponse;
  error?: string;
  /**
   * Activities called during this state's `prepare` and `finalize` phases (ADR-0010), with their
   * args + results. Populated by `definePureState` via the activity-capture interceptor; absent for
   * raw states.
   */
  activities?: { prepare: ActivityCall[]; finalize: ActivityCall[] };
}

export type StateFunction<TState extends string, TEvent, TContext, TResponse, TSignal = never> = (
  ctx: Readonly<TContext>,
  input: StateInput<TEvent, TSignal>,
) => Promise<StateOutput<TState, TContext, TResponse>>;

export interface StateConfig<TState extends string, TEvent, TContext, TResponse, TSignal = never> {
  fn: StateFunction<TState, TEvent, TContext, TResponse, TSignal>;
  timeout?: Duration;
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
    event: TEvent | 'timeout' | 'signal',
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
}

/** What drove a transition. */
export interface TransitionTrigger {
  kind: 'start' | 'signal' | 'update' | 'timeout';
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

/**
 * Jérémie Chassaing's Functional Event Sourcing Decider, in TypeScript
 * (see docs/research/functional-event-sourcing-decider.md).
 *
 * A pure, infrastructure-free bundle: `decide` turns a command + current state into the
 * facts (`Event[]`) that happened; `evolve` folds one fact into state and is the only writer.
 * `initialState` and `isTerminal` give the aggregate a defined birth and death.
 *
 * This type is ADDITIVE and consumed by nothing in the driver — it exists so a domain that
 * chooses to express its core in Chassaing's shape (currently the inventory `transfer` pilot,
 * Theme 1 P3 / Option B) references one shared definition instead of re-inventing it. The
 * framework driver still runs the `prepare → decide → finalize` handlers unchanged; a domain
 * using this type wires it in behind those handlers.
 */
export interface Decider<Command, Event, State> {
  decide: (command: Command, state: State) => Event[];
  evolve: (state: State, event: Event) => State;
  initialState: State;
  isTerminal: (state: State) => boolean;
}
