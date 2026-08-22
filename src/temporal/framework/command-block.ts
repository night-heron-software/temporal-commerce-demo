/**
 * The CommandBlock authoring surface (ADR-0024, ADR-0026).
 *
 * A domain authors one BLOCK per command: its refusal, its I/O, its decision, where the
 * events it emits take the machine, and how those events fold into context. The framework
 * consumes three different slices of that block —
 *
 *   - the shell phases (`guard` / `prepare` / `enrich` / `respond`) are a {@link CommandHandler},
 *     handed to `machine.state({ commands })`;
 *   - `decide` and `evolve` are assembled into the domain's {@link MachineDecider};
 *   - `routes` is assembled into the state's {@link EventRoute} by {@link deriveRoutes}.
 *
 * — but the AUTHOR writes them in one place, so a command's whole story is legible without
 * jumping to the bottom of the file. {@link deriveRoutes} and {@link assembleEvolve} are the
 * two assemblers that turn a state's `commands` table back into the shapes the framework
 * wants, and both enforce their invariants by throwing at MODULE LOAD, so a violation cannot
 * reach a worker.
 */
import { SELF } from './types';
import type { Self } from './types';
import type { CommandHandler, EventRoute } from './machine';

/** Where an event may take the machine: a state name, a terminal, or an explicit stay. */
export type RouteTarget<TState extends string> = TState | `__terminal:${string}` | Self;

/**
 * A block's routes — keyed by EVENT TYPE, like its evolve map (ADR-0026).
 *
 * An event's destination is a machine-global fact, so the block that emits an event declares
 * where it goes and each state's table is DERIVED from its commands. Absence means "stays"
 * (the unrouted / `'*'` behavior); an explicit `SELF` is allowed where staying put is itself
 * worth stating.
 */
export type RouteMap<TState extends string, TEvent extends { type: string }> = {
  [E in TEvent['type']]?: RouteTarget<TState>;
};

/**
 * Event type → the fold for that event. Two blocks may key the same event only by sharing
 * ONE named function; see {@link assembleEvolve}.
 */
export type EvolveMap<TEvent extends { type: string }, TContext> = {
  [E in TEvent['type']]?: (
    context: Readonly<TContext>,
    event: Extract<TEvent, { type: E }>,
  ) => TContext;
};

/**
 * One command's whole story: refusal, I/O, decision, destination, and the fold for what it
 * emits.
 *
 * `TDeciderCommand` is the ENRICHED command the decision sees (wire fields + whatever
 * `prepare` returned + `at`), which is why it is separate from `TCommandMember`, the wire
 * command the shell phases see.
 */
export interface CommandBlock<
  TContext,
  TCommandMember,
  TDeciderCommand,
  TEvent extends { type: string },
  TState extends string,
  TResponse = void,
> extends CommandHandler<TContext, TCommandMember, TEvent, TResponse> {
  /** The pure decision. Total for this command — every refusal belongs in `guard`/`prepare`. */
  decide: (command: TDeciderCommand, context: Readonly<TContext>) => TEvent[];
  /** Where the events this block emits take the machine. Absence means "stays". */
  routes?: RouteMap<TState, TEvent>;
  /** The fold for the events this block emits. */
  evolve?: EvolveMap<TEvent, TContext>;
}

/**
 * Derive a state's route table from its commands' `routes` declarations (ADR-0026).
 *
 * The state's transition surface is the union of what its blocks declare, so the knowledge
 * lives at the emission site and cannot drift from it. Two load-time laws, enforced by
 * throwing here (the {@link assembleEvolve} precedent):
 *
 *  1. Same event, two destinations, one state → throw. An event's destination is a
 *     machine-global fact; two blocks disagreeing is a contradiction.
 *  2. `extras` may only add the `'*'` wildcard or weaken an event to `SELF` — never redirect.
 *     A state may refuse to move on an event; it may not send it somewhere other than the
 *     block's declared destination.
 *
 * Also throws if a state with commands derives an empty table — the symptom of a
 * handler-override literal that forgot to carry its block's routes.
 *
 * @param domain Label for the three throws, so a violation names the machine it came from.
 */
export function deriveRoutes<TState extends string, TEvent extends { type: string }>(
  domain: string,
  commands: Record<string, { routes?: RouteMap<TState, TEvent> }>,
  extras?: RouteMap<TState, TEvent> & { '*'?: Self },
): EventRoute<TState, TEvent> {
  const merged: Record<string, RouteTarget<TState>> = {};
  for (const [commandType, block] of Object.entries(commands)) {
    for (const [eventType, target] of Object.entries(block.routes ?? {}) as [
      string,
      RouteTarget<TState>,
    ][]) {
      const existing = merged[eventType];
      if (existing !== undefined && existing !== target) {
        throw new Error(
          `${domain} route assembly: event '${eventType}' has two destinations in one state ` +
            `('${String(existing)}' vs '${String(target)}' via '${commandType}') — ` +
            'an event has ONE machine-global destination; fix the blocks',
        );
      }
      merged[eventType] = target;
    }
  }
  for (const [eventType, target] of Object.entries(extras ?? {}) as [
    string,
    RouteTarget<TState>,
  ][]) {
    if (eventType !== '*' && target !== SELF) {
      throw new Error(
        `${domain} route extras: '${eventType}' may only weaken to SELF — ` +
          'a state can refuse to move, never redirect; change the block instead',
      );
    }
    merged[eventType] = target;
  }
  if (Object.keys(merged).length === 0 && Object.keys(commands).length > 0) {
    throw new Error(
      `${domain} route assembly: a state with commands derived an empty route table — ` +
        "a handler-override literal probably dropped its block's routes",
    );
  }
  return merged as EventRoute<TState, TEvent>;
}

/**
 * Merge every block's evolve map into the machine's single event → entry table.
 *
 * Duplicate keys must be the IDENTICAL function reference (a shared, named evolve function) —
 * two blocks inlining different code for one event throws here, at module load, so shared
 * events cannot silently diverge.
 *
 * @param domain Label for the throw, so a violation names the machine it came from.
 */
export function assembleEvolve<TEvent extends { type: string }, TContext>(
  domain: string,
  blockList: ReadonlyArray<{ evolve?: EvolveMap<TEvent, TContext> }>,
): EvolveMap<TEvent, TContext> {
  const merged: EvolveMap<TEvent, TContext> = {};
  for (const block of blockList) {
    if (!block.evolve) continue;
    for (const type of Object.keys(block.evolve) as TEvent['type'][]) {
      const entry = block.evolve[type];
      if (!entry) continue;
      const existing = merged[type];
      if (existing && existing !== entry) {
        throw new Error(
          `${domain} evolve assembly: event '${type}' has two different evolve entries — ` +
            'share one named evolve function between the blocks instead',
        );
      }
      (merged as Record<string, unknown>)[type] = entry;
    }
  }
  return merged;
}
