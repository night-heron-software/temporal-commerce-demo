/**
 * The decider-native authoring surface (ADR-0024, clarity-plan Phase 1).
 *
 * A machine domain supplies a pure decider — `decide(command, state) → events`,
 * `evolve(state, event) → state` — and per-state declarations of the commands it
 * accepts, how emitted events route, and what effects events cause. The framework
 * owns everything else: the fold (`applyCommand`), rejection (`guard`/`reject`),
 * enrichment of commands with prepared data, routing, responses, and effects.
 *
 * Vocabulary (fixing the inversion the old surface baked in):
 *  - **command** — intent arriving from outside (a Temporal update or signal payload,
 *    or synthesized by `onTimeout`). May require side-effecting preparation. Once
 *    decided, it GENERATES events.
 *  - **event**   — a report that something happened. It is *reacted to*: folded into
 *    state by `evolve`, routed on by the state's `route` table, and answered by
 *    `effects`. Events are transient — in-memory, per-call, never persisted; Temporal
 *    history remains the sole durable log (ADR-0003, reaffirmed by ADR-0024).
 *
 * The pipeline per accepted command:
 *
 *   guard (pure, may reject) → prepare (activities, may throw = reject)
 *     → enrich (command + prepared + meta → decider command)
 *     → decide → events → evolve fold          [applyCommand — framework-owned]
 *     → route (events → next state) → respond → effects (event-keyed reactions)
 *
 * Rejections — a guard refusal, a prepare throw, or a command the state does not
 * list — release the caller with a typed error and NEITHER transition NOR project:
 * the driver skips `onContextUpdate`/`onTransition`/recording for outputs marked
 * `rejected` (see `StateOutput.rejected`).
 *
 * As of clarity-plan Phase 4 this is the ONLY authoring surface — the first-generation
 * `defineDomain`/`defineTransitions`/`definePureState` path is deleted, and the mono's
 * lint invariants ban the retired names from returning.
 */

import { log } from '@temporalio/workflow';
import { beginActivityCapture, endActivityCapture } from './activity-capture';
import { terminal } from './authoring';
import type { InputMeta } from './authoring';
import { SELF } from './types';
import type {
  ActivityCall,
  Self,
  StateConfig,
  StateFunction,
  StateInput,
  StateOutput,
} from './types';
import type { Duration } from '@temporalio/common';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ── The decider ────────────────────────────────────────────────────────

/**
 * The pure core a machine domain supplies — Chassaing's decider, slimmed to the two
 * members the machine actually runs. `decide` and `evolve` MUST be pure: no I/O, no
 * clock reads (time arrives on the enriched command), no throwing for control flow
 * (rejection belongs in `guard`; see ADR-0024).
 *
 * `isTerminal` is deliberately absent: terminality is the route table's job — the
 * old interface's member was dead code in every adopting domain.
 */
export interface MachineDecider<TDeciderCommand, TEvent, TContext> {
  /** Turn a command + current state into the events that happened. Pure. */
  decide: (command: TDeciderCommand, state: TContext) => TEvent[];
  /** Fold one event into state — the ONLY writer of state. Pure. */
  evolve: (state: TContext, event: TEvent) => TContext;
  /**
   * Optional test seam: the canonical empty shape, for decider unit tests. Never
   * consulted at runtime — the workflow builds its real initial context from input.
   */
  initialState?: TContext;
}

/**
 * The fold, implemented once (ADR-0024 decision 1): run the decider's `decide`,
 * fold the emitted events with `evolve`, and return both the new state and the
 * events — so callers can route on what happened instead of re-deriving it.
 */
export function applyCommand<TDeciderCommand, TEvent, TContext>(
  decider: MachineDecider<TDeciderCommand, TEvent, TContext>,
  state: TContext,
  command: TDeciderCommand,
): { context: TContext; events: TEvent[] } {
  const events = decider.decide(command, state);
  return { context: events.reduce(decider.evolve, state), events };
}

// ── Rejection ──────────────────────────────────────────────────────────

/** A guard's refusal of a command. Construct with {@link reject}. */
export interface Rejection {
  readonly rejected: true;
  readonly reason: string;
}

/**
 * Refuse a command. The single constructor both error channels consume: the update
 * caller receives `reason` (via `formatError` or a non-retryable failure), and the
 * machine records nothing — a rejection is not a transition.
 */
export function reject(reason: string): Rejection {
  return { rejected: true, reason };
}

export function isRejection(value: unknown): value is Rejection {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Rejection).rejected === true &&
    typeof (value as Rejection).reason === 'string'
  );
}

// ── Per-state declarations ─────────────────────────────────────────────

/**
 * How one accepted command is handled. Every member is optional — `{}` accepts the
 * command with defaults (no guard, no prepare, default enrichment, default respond).
 */
export interface CommandHandler<TContext, TCommandMember, TEvent, TResponse> {
  /**
   * Pure rejection, before any I/O. Owns EVERY refusal derivable from
   * `(ctx, command)`; return {@link reject} to refuse, anything else to accept.
   * With all rejection here, the decider's `decide` is total for this command.
   */
  guard?: (ctx: Readonly<TContext>, command: TCommandMember) => Rejection | void;
  /**
   * Activities before the decision. A throw is a REJECTION (typed error to the
   * caller, no transition, no projection) — so a prepare mutation must be
   * guarded-unreachable on every reject path, or idempotent (the TOCTOU rule:
   * atomic check-and-reserve stays a single activity here).
   */
  prepare?: (ctx: Readonly<TContext>, command: TCommandMember) => Promise<Any>;
  /**
   * Map the wire command + prepared data into the decider's command. Default:
   * `{ ...command, at: meta.timestamp, ...prepared }` (prepared must then be an
   * object or void). Override for reshaping — e.g. normalizing one wire command
   * into a different decider command.
   */
  enrich?: (command: TCommandMember, prepared: Any, meta: InputMeta) => Any;
  /** This command's response. Overrides the machine-level `respond`. */
  respond?: (ctx: Readonly<TContext>, events: TEvent[], command: TCommandMember) => TResponse;
}

/**
 * Event-type → reaction. Effects run AFTER the fold, in event-emission order,
 * inside the finalize activity-capture bucket. An effect that throws is logged and
 * swallowed — the decision is already committed (same contract as the old
 * surface's `finalize`). Cross-domain notifications (signals, child starts) belong
 * here, keyed by the event that causes them.
 */
export type EffectsMap<TEvent extends { type: string }, TContext> = {
  [K in TEvent['type']]?: (
    event: Extract<TEvent, { type: K }>,
    ctx: Readonly<TContext>,
  ) => Promise<void>;
};

/**
 * Where emitted events take the machine — evaluated by the framework, so the shell
 * never re-derives what the decider already said. Events are considered in emission
 * order; the LAST event with a route entry (its own type, else `'*'`) determines
 * `next`. No routed event → stay ({@link SELF}).
 */
export type EventRoute<TState extends string, TEvent extends { type: string }> = {
  [K in TEvent['type']]?: TState | `__terminal:${string}` | Self;
} & { '*'?: TState | `__terminal:${string}` | Self };

/** One state of a decider-native machine. */
export interface MachineState<
  TState extends string,
  TCommand extends { type: string },
  TEvent extends { type: string },
  TContext,
  TResponse,
> {
  /**
   * The commands this state accepts — the state's contract, readable at a glance.
   * A command with no entry is REJECTED (`rejected: true`, typed error, no
   * transition). `{}` accepts a command with defaults.
   */
  commands?: {
    [K in TCommand['type']]?: CommandHandler<
      TContext,
      Extract<TCommand, { type: K }>,
      TEvent,
      TResponse
    >;
  };
  /** Where emitted events take the machine. */
  route: EventRoute<TState, TEvent>;
  /** State-level reactions, run before the machine-level {@link MachineConfig.effects}. */
  effects?: EffectsMap<TEvent, TContext>;
  /**
   * Synthesize a command when this state's timer elapses (or on every automatic
   * tick of a `transitional` state). The command then runs the FULL pipeline —
   * including its own `commands` entry, if any. Return `null` to ignore the tick
   * and stay put. Absent: timeouts are ignored.
   */
  onTimeout?: (ctx: Readonly<TContext>) => TCommand | null;
  /**
   * Passed through to the driver's `StateConfig` — no registry spreading needed.
   * The function form resolves per loop iteration from the live context
   * (per-execution timeouts, e.g. strategy-descriptor poll cadences).
   */
  timeout?: Duration | ((ctx: Readonly<TContext>) => Duration);
  transitional?: boolean;
}

// ── The machine ────────────────────────────────────────────────────────

export interface MachineConfig<
  TDeciderCommand,
  TEvent extends { type: string },
  TContext,
  TResponse,
> {
  /** The domain's pure core. */
  decider: MachineDecider<TDeciderCommand, TEvent, TContext>;
  /** Machine-level reactions, run after any state-level effects for each event. */
  effects?: EffectsMap<TEvent, TContext>;
  /** Default responder when a command handler declares none. */
  respond?: (ctx: Readonly<TContext>, events: TEvent[]) => TResponse;
}

/**
 * Bind a machine's decider + shared type parameters once; author each state with
 * `machine.state(name, { commands, route, effects, … })`.
 *
 * The returned `StateConfig` uses `TCommand` in BOTH the driver's event and signal
 * slots: updates deliver commands directly, and signal registrations map their args
 * to commands (`toSignal: (...) => command`), so the state function sees one input
 * vocabulary regardless of transport.
 */
export function defineMachine<
  TState extends string,
  TCommand extends { type: string },
  TEvent extends { type: string },
  TContext,
  TResponse = void,
>(machine: MachineConfig<Any, TEvent, TContext, TResponse>) {
  return {
    state: (
      self: TState,
      def: MachineState<TState, TCommand, TEvent, TContext, TResponse>,
    ): StateConfig<TState, TCommand, TContext, TResponse, TCommand> => ({
      fn: compileMachineState<TState, TCommand, TEvent, TContext, TResponse>(machine, self, def),
      timeout: def.timeout,
      transitional: def.transitional,
    }),
    /** Typed terminal, re-exported for route tables. */
    terminal,
  };
}

// ── Compilation ────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function compileMachineState<
  TState extends string,
  TCommand extends { type: string },
  TEvent extends { type: string },
  TContext,
  TResponse,
>(
  machine: MachineConfig<Any, TEvent, TContext, TResponse>,
  self: TState,
  def: MachineState<TState, TCommand, TEvent, TContext, TResponse>,
): StateFunction<TState, TCommand, TContext, TResponse, TCommand> {
  const commandTable = (def.commands ?? {}) as Record<
    string,
    CommandHandler<TContext, Any, TEvent, TResponse> | undefined
  >;
  const routeTable = def.route as Record<
    string,
    TState | `__terminal:${string}` | Self | undefined
  >;

  const resolveNext = (events: TEvent[]): TState | `__terminal:${string}` => {
    let target: TState | `__terminal:${string}` | Self | undefined;
    for (const ev of events) {
      const hit = routeTable[ev.type] ?? routeTable['*'];
      if (hit !== undefined) target = hit; // last routed event wins
    }
    const next = target ?? SELF;
    return next === SELF ? self : next;
  };

  const rejected = (
    ctx: Readonly<TContext>,
    reason: string,
    prepareActivities: ActivityCall[] = [],
  ): StateOutput<TState, TContext, TResponse> => ({
    context: ctx as TContext,
    next: self,
    error: reason,
    rejected: true,
    activities: { prepare: prepareActivities, finalize: [] },
  });

  return async (
    ctx: Readonly<TContext>,
    input: StateInput<TCommand, TCommand>,
  ): Promise<StateOutput<TState, TContext, TResponse>> => {
    const meta: InputMeta = { timestamp: input.timestamp };

    // Resolve the inbound command from any transport arm — updates and signals both
    // carry commands on this surface; a timeout synthesizes one (or is ignored).
    let command: TCommand;
    if (input.kind === 'timeout') {
      const synthesized = def.onTimeout ? def.onTimeout(ctx) : null;
      if (synthesized === null || synthesized === undefined) {
        // Idle tick: nothing to do. Flagged so the driver skips BOTH recording and the
        // onTransition hook — a no-op that fires effects is how a parked manual-mode order
        // came to re-signal its unchanged status every 15 s (backlog #18).
        return { context: ctx as TContext, next: self, idle: true };
      }
      command = synthesized;
    } else {
      command = input.kind === 'event' ? input.event : input.result;
    }

    const handler = commandTable[command.type];
    if (handler === undefined) {
      return rejected(ctx, `State '${self}' does not accept command '${command.type}'`);
    }

    // ── guard: pure rejection before any I/O ──
    if (handler.guard) {
      const verdict = handler.guard(ctx, command);
      if (isRejection(verdict)) return rejected(ctx, verdict.reason);
    }

    // ── prepare: activities; a throw is a rejection ──
    const prepareActivities = beginActivityCapture();
    let prepared: Any;
    try {
      prepared = handler.prepare ? await handler.prepare(ctx, command) : undefined;
    } catch (err) {
      endActivityCapture();
      return rejected(ctx, errorMessage(err), prepareActivities);
    }
    endActivityCapture();

    // ── enrich: command + prepared + meta → the decider's command ──
    const deciderCommand = handler.enrich
      ? handler.enrich(command, prepared, meta)
      : {
          ...command,
          at: meta.timestamp,
          ...(prepared !== null && typeof prepared === 'object' ? prepared : {}),
        };

    // ── decide + fold (framework-owned) → route → respond ──
    const { context, events } = applyCommand(machine.decider, ctx as TContext, deciderCommand);
    const next = resolveNext(events);
    const response = handler.respond
      ? handler.respond(context, events, command)
      : machine.respond
        ? machine.respond(context, events)
        : undefined;

    // ── effects: state-level then machine-level, in event-emission order ──
    const finalizeActivities = beginActivityCapture();
    for (const ev of events) {
      const reactions = [
        (
          def.effects as
            | Record<string, ((e: TEvent, c: Readonly<TContext>) => Promise<void>) | undefined>
            | undefined
        )?.[ev.type],
        (
          machine.effects as
            | Record<string, ((e: TEvent, c: Readonly<TContext>) => Promise<void>) | undefined>
            | undefined
        )?.[ev.type],
      ];
      for (const fx of reactions) {
        if (!fx) continue;
        try {
          await fx(ev, context);
        } catch (err) {
          // Decision is committed — the transition proceeds despite an effect failure
          // (same contract as the old surface's finalize).
          log.error('machine effect failed', {
            state: self,
            event: ev.type,
            error: String(err),
          });
        }
      }
    }
    endActivityCapture();

    return {
      context,
      next,
      response,
      activities: { prepare: prepareActivities, finalize: finalizeActivities },
    };
  };
}
