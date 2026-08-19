/**
 * The fulfillment (parent) machine, co-located in one file (ADR-0024 decider-native
 * surface, aligned with nightheron-mono's CommandBlock convention).
 *
 * Everything about the machine lives here, in reading order: the timestamped command union
 * and the past-tense event union; the pure aggregation helpers; then ONE `CommandBlock`
 * PER COMMAND — a single exported structure holding the command's whole story, code
 * inlined: its `decide` case and the `evolve` entries for the events it emits; then the
 * central `decide`/`evolve`, ASSEMBLED from the blocks; and finally the machine assembly:
 * the `m.state` declarations (whose commands tables reference the SAME blocks) and the
 * registry.
 *
 *   decide: (command, context) => Event[]     // what happened, as past-tense events
 *   evolve: (context, event)   => Context     // apply one event — returns a NEW context
 *
 * Both functions are pure and infrastructure-free — no I/O, no clock; the framework
 * injects the deterministic timestamp (`at`) on each command. Purity is structural, not
 * conventional: every state-writing function takes a `Readonly<...>` parameter and
 * returns a NEW value built by structural sharing — the old blanket deep-copy barrier
 * (`copyState`) is gone entirely.
 *
 * The parent aggregates child fulfiller-order statuses, and the aggregate OUTCOME is
 * decided as events — a child status update that completes or dooms the whole order
 * emits `FulfillmentDelivered` / `FulfillmentFailed`, and routing reads it; the shell
 * never re-inspects the evolved status. Cross-domain reactions (OMS status signals,
 * projections, child lifecycle) stay in the workflow's hooks — they are per-transition
 * semantics, not per-event.
 */

import type {
  FulfillmentWorkflowState,
  FulfillmentCommand,
  FulfillmentStateName,
  FulfillmentFulfillerOrderState,
} from './types';
import type { FulfillmentResult } from './definitions';
import { defineMachine, terminal, SELF } from '../framework';
import type { MachineDecider, Rejection, StateRegistry } from '../framework';

// ==================
// Commands and events — the machine's whole vocabulary
// ==================

/** The command as the decider sees it: the wire command + the framework-injected timestamp. */
export type TimestampedFulfillmentCommand = FulfillmentCommand & { at: string };

/** Past-tense domain events. Each carries the timestamp at which it happened. */
export type FulfillmentEvent =
  | { type: 'ProductionStarted'; at: string }
  | { type: 'OrderCancelled'; at: string }
  | { type: 'ChildStatusApplied'; update: FulfillmentFulfillerOrderState; at: string }
  | { type: 'FulfillmentDelivered'; at: string }
  | { type: 'FulfillmentFailed'; at: string };

/** One member of the WIRE command union (pre-timestamp), by its `type` tag. */
type Wire<K extends FulfillmentCommand['type']> = Extract<FulfillmentCommand, { type: K }>;

/** One member of the TIMESTAMPED command union (wire + `at`), by its `type` tag. */
type Timestamped<K extends FulfillmentCommand['type']> = Extract<
  TimestampedFulfillmentCommand,
  { type: K }
>;

/** One member of the event union, by its `type` tag. */
type Ev<K extends FulfillmentEvent['type']> = Extract<FulfillmentEvent, { type: K }>;

// ==================
// Pure aggregation helpers — no I/O, no side effects. `aggregateStatus` is exported for
// direct unit testing (`fulfillment-decider.test.ts`).
// ==================

/** The order status implied by a set of fulfiller-order statuses. */
function aggregateOf(
  statuses: readonly FulfillmentFulfillerOrderState['status'][],
): FulfillmentWorkflowState['status'] {
  if (statuses.every((s) => s === 'delivered')) return 'delivered';
  if (statuses.every((s) => s === 'cancelled' || s === 'failed')) return 'failed';
  if (statuses.every((s) => s === 'shipped' || s === 'delivered')) return 'shipped';
  if (statuses.some((s) => s === 'shipped' || s === 'delivered')) return 'partially_shipped';
  return 'in_production';
}

/** The order status implied by the aggregate of all fulfiller-order statuses. */
export function aggregateStatus(
  state: Readonly<FulfillmentWorkflowState>,
): FulfillmentWorkflowState['status'] {
  return aggregateOf(state.fulfillerOrders.map((so) => so.status));
}

// ==================
// Command blocks — ONE exported structure per command, every field that defines the
// command in one value, with the code INLINED. The `m.state` declarations at the bottom
// reference these SAME blocks (the framework reads only `guard`/`prepare`; structural
// typing admits the extra fields), the central `decide`/`evolve` dispatchers are
// assembled from them, and tests exercise their fields directly.
// ==================

/**
 * A block's evolve — keyed by EVENT TYPE, because evolve's unit is the event, not the
 * command: one command may emit several event types. The machine's single
 * `evolve(context, event)` is assembled by merging every block's map.
 */
type EvolveMap = {
  [E in FulfillmentEvent['type']]?: (
    context: Readonly<FulfillmentWorkflowState>,
    event: Ev<E>,
  ) => FulfillmentWorkflowState;
};

/** One command's whole story: refusal, I/O, decision, and the evolve for what it emits. */
export interface CommandBlock<K extends FulfillmentCommand['type']> {
  guard?: (context: Readonly<FulfillmentWorkflowState>, command: Wire<K>) => Rejection | void;
  prepare?: (
    context: Readonly<FulfillmentWorkflowState>,
    command: Wire<K>,
  ) => Promise<object | void>;
  decide: (
    command: Timestamped<K>,
    context: Readonly<FulfillmentWorkflowState>,
  ) => FulfillmentEvent[];
  evolve?: EvolveMap;
}

// ==================
// Command: beginProduction — the whole story (synthesized by the transitional
// `received` state; idempotent — only a freshly-received order starts production)
// ==================

export const beginProductionBlock: CommandBlock<'beginProduction'> = {
  decide: (command, context) =>
    context.status === 'received' ? [{ type: 'ProductionStarted', at: command.at }] : [],

  evolve: {
    ProductionStarted: (context, _event) => ({ ...context, status: 'in_production' }),
  },
};

// ==================
// Command: cancel — the whole story (cancels the order and every fulfiller order + line;
// signalling/awaiting the children is the shell's per-transition job)
// ==================

export const cancelBlock: CommandBlock<'cancel'> = {
  decide: (command, _context) => [{ type: 'OrderCancelled', at: command.at }],

  evolve: {
    OrderCancelled: (context, _event) => ({
      ...context,
      status: 'cancelled',
      fulfillerOrders: context.fulfillerOrders.map((so) => ({
        ...so,
        status: 'cancelled' as const,
        items: so.items.map((item) => ({ ...item, status: 'cancelled' as const })),
      })),
    }),
  },
};

// ==================
// Command: childStatus — the whole story. A child's status update is applied, and when
// the projected aggregate completes or dooms the order the OUTCOME is decided here as an
// event — routing keys on `FulfillmentDelivered` / `FulfillmentFailed` instead of
// re-reading the evolved status.
// ==================

export const childStatusBlock: CommandBlock<'childStatus'> = {
  decide: (command, context) => {
    const at = command.at;
    const events: FulfillmentEvent[] = [{ type: 'ChildStatusApplied', update: command.update, at }];
    // Decide the aggregate OUTCOME by projecting the update onto the current set —
    // routing keys on these events instead of re-reading the evolved status.
    const projected = context.fulfillerOrders.map((so) =>
      so.fulfillerOrderId === command.update.fulfillerOrderId ? command.update : so,
    );
    const aggregate = aggregateOf(projected.map((so) => so.status));
    if (aggregate === 'delivered') events.push({ type: 'FulfillmentDelivered', at });
    else if (aggregate === 'failed') events.push({ type: 'FulfillmentFailed', at });
    return events;
  },

  evolve: {
    // Aliasing the event's update into fulfillerOrders is not a live hazard: events are
    // transient per ADR-0003, never persisted or shared.
    ChildStatusApplied: (context, event) => {
      const fulfillerOrders = context.fulfillerOrders.map((so) =>
        so.fulfillerOrderId === event.update.fulfillerOrderId ? event.update : so,
      );
      return {
        ...context,
        fulfillerOrders,
        status: aggregateOf(fulfillerOrders.map((so) => so.status)),
      };
    },

    FulfillmentDelivered: (context, _event) => ({ ...context, status: 'delivered' }),

    FulfillmentFailed: (context, _event) => ({ ...context, status: 'failed' }),
  },
};

// ==================
// The central decide / evolve — dispatchers ASSEMBLED from the blocks above, conforming
// to the framework's `MachineDecider`.
// ==================

/**
 * Every command's block, keyed by command type — the machine's whole command surface.
 * The mapped type pins each key to ITS OWN block, so a mixed-up entry is a type error.
 */
const blocks: { [K in FulfillmentCommand['type']]: CommandBlock<K> } = {
  beginProduction: beginProductionBlock,
  cancel: cancelBlock,
  childStatus: childStatusBlock,
};

/** A block's decide, widened for dispatch (the `blocks` mapped type guarantees the match). */
type AnyDecide = (
  command: TimestampedFulfillmentCommand,
  context: Readonly<FulfillmentWorkflowState>,
) => FulfillmentEvent[];

/** An evolve entry, widened for dispatch (the assembled map keys guarantee the match). */
type AnyEvolveEntry = (
  context: Readonly<FulfillmentWorkflowState>,
  event: FulfillmentEvent,
) => FulfillmentWorkflowState;

/**
 * Merge every block's evolve map into the machine's single event → entry table.
 * Duplicate keys must be the IDENTICAL function reference — two blocks inlining
 * different code for one event throws here, at module load, so shared events cannot
 * silently diverge.
 */
function assembleEvolve(blockList: ReadonlyArray<{ evolve?: EvolveMap }>): EvolveMap {
  const merged: EvolveMap = {};
  for (const block of blockList) {
    if (!block.evolve) continue;
    for (const type of Object.keys(block.evolve) as FulfillmentEvent['type'][]) {
      const entry = block.evolve[type];
      if (!entry) continue;
      const existing = merged[type];
      if (existing && existing !== entry) {
        throw new Error(
          `fulfillment evolve assembly: event '${type}' has two different evolve entries — ` +
            'share one named evolve function between the blocks instead',
        );
      }
      (merged as Record<FulfillmentEvent['type'], unknown>)[type] = entry;
    }
  }
  return merged;
}

const evolveByEvent: EvolveMap = assembleEvolve(Object.values(blocks));

/**
 * decide(command, context) → events. Pure: emits the events implied by the command in the
 * current state, and nothing else. This is a thin dispatcher: each command's decision
 * code lives inline in its block above.
 */
export function decide(
  command: TimestampedFulfillmentCommand,
  context: Readonly<FulfillmentWorkflowState>,
): FulfillmentEvent[] {
  return (blocks[command.type].decide as AnyDecide)(command, context);
}

/**
 * evolve(context, event) → context. Pure application of a single event — the ONLY writer
 * of `status` / `fulfillerOrders` / `updatedAt` — and it writes them by returning a NEW
 * context. The dispatcher stamps `updatedAt` from the event's `at`, then hands the
 * stamped context to the emitting block's evolve entry, which builds its result by
 * structural sharing. No deep copy, no mutation anywhere.
 */
export function evolve(
  context: Readonly<FulfillmentWorkflowState>,
  event: FulfillmentEvent,
): FulfillmentWorkflowState {
  const stamped: FulfillmentWorkflowState = { ...context, updatedAt: event.at };
  const entry = evolveByEvent[event.type];
  return entry ? (entry as AnyEvolveEntry)(stamped, event) : stamped;
}

/**
 * The assembled decider, conforming to the framework's `MachineDecider` shape (ADR-0024:
 * `isTerminal` is gone — terminality is the route tables' job; `initialState` remains as
 * the canonical empty shape for decider unit tests, never consulted at runtime).
 */
export const fulfillmentDecider: MachineDecider<
  TimestampedFulfillmentCommand,
  FulfillmentEvent,
  FulfillmentWorkflowState
> = {
  decide,
  evolve,
  initialState: {
    orderId: '',
    cartId: '',
    customerId: '',
    status: 'in_production',
    fulfillerOrders: [],
    createdAt: '',
    updatedAt: '',
  },
};

// ==================
// The machine (ADR-0024 decider-native surface) — the commands tables reference the
// SAME blocks the dispatchers are assembled from; the framework reads only their
// `guard`/`prepare`.
// ==================

const m = defineMachine<
  FulfillmentStateName,
  FulfillmentCommand,
  FulfillmentEvent,
  FulfillmentWorkflowState,
  FulfillmentResult
>({ decider: fulfillmentDecider });

export const FULFILLMENT_STATES: StateRegistry<
  FulfillmentStateName,
  FulfillmentCommand,
  FulfillmentWorkflowState,
  FulfillmentResult,
  FulfillmentCommand
> = {
  received: m.state('received', {
    commands: { beginProduction: beginProductionBlock },
    route: { ProductionStarted: 'in_production' },
    transitional: true,
    onTimeout: () => ({ type: 'beginProduction' }),
  }),
  in_production: m.state('in_production', {
    commands: { cancel: cancelBlock, childStatus: childStatusBlock },
    route: {
      OrderCancelled: terminal('cancelled'),
      FulfillmentDelivered: terminal('delivered'),
      FulfillmentFailed: terminal('failed'),
      '*': SELF,
    },
    timeout: '365 days',
  }),
};
