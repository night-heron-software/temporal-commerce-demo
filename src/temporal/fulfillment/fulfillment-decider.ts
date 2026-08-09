/**
 * Fulfillment (parent) Decider — pure Functional Core, on the ADR-0024 decider-native
 * surface: the framework owns the fold, this module supplies only
 *
 *   decide: (command, state) => Event[]     // what happened, as past-tense events
 *   evolve: (state, event)   => State       // fold one event into state (the ONLY writer)
 *
 * Pure — no I/O, no clock; the framework injects the deterministic timestamp (`at`).
 * The parent aggregates child fulfiller-order statuses, and the aggregate's OUTCOME is
 * decided here as events (`FulfillmentDelivered` / `FulfillmentFailed`) — the shell no
 * longer re-inspects the folded status to route to terminals.
 */

import type { MachineDecider } from '../framework';
import type {
  FulfillmentWorkflowState,
  FulfillmentCommand,
  FulfillmentFulfillerOrderState,
} from './types';

/** The command as the decider sees it: the wire command + the framework-injected timestamp. */
export type TimestampedFulfillmentCommand = FulfillmentCommand & { at: string };

/** Past-tense domain events. */
export type FulfillmentEvent =
  | { type: 'ProductionStarted'; at: string }
  | { type: 'OrderCancelled'; at: string }
  | { type: 'ChildStatusApplied'; update: FulfillmentFulfillerOrderState; at: string }
  | { type: 'FulfillmentDelivered'; at: string }
  | { type: 'FulfillmentFailed'; at: string };

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
  state: FulfillmentWorkflowState,
): FulfillmentWorkflowState['status'] {
  return aggregateOf(state.fulfillerOrders.map((so) => so.status));
}

/** Deep-copy the fulfillment state for immutable folds. */
function copyState(ctx: Readonly<FulfillmentWorkflowState>): FulfillmentWorkflowState {
  return {
    ...ctx,
    fulfillerOrders: ctx.fulfillerOrders.map((so) => ({
      ...so,
      items: so.items.map((i) => ({ ...i })),
      shipments: so.shipments ? so.shipments.map((s) => ({ ...s })) : undefined,
    })),
  };
}

/** decide(command, state) → events. Pure. */
export function decide(
  command: TimestampedFulfillmentCommand,
  state: FulfillmentWorkflowState,
): FulfillmentEvent[] {
  const at = command.at;
  switch (command.type) {
    case 'beginProduction':
      return state.status === 'received' ? [{ type: 'ProductionStarted', at }] : [];
    case 'cancel':
      return [{ type: 'OrderCancelled', at }];
    case 'childStatus': {
      const events: FulfillmentEvent[] = [
        { type: 'ChildStatusApplied', update: command.update, at },
      ];
      // Decide the aggregate OUTCOME by projecting the update onto the current set —
      // routing keys on these events instead of re-reading the folded status.
      const projected = state.fulfillerOrders.map((so) =>
        so.fulfillerOrderId === command.update.fulfillerOrderId ? command.update : so,
      );
      const aggregate = aggregateOf(projected.map((so) => so.status));
      if (aggregate === 'delivered') events.push({ type: 'FulfillmentDelivered', at });
      else if (aggregate === 'failed') events.push({ type: 'FulfillmentFailed', at });
      return events;
    }
    default:
      return [];
  }
}

/** evolve(state, event) → state. Pure fold; the ONLY writer of status / fulfillerOrders / updatedAt. */
export function evolve(
  state: FulfillmentWorkflowState,
  event: FulfillmentEvent,
): FulfillmentWorkflowState {
  const draft = copyState(state);
  draft.updatedAt = event.at;
  switch (event.type) {
    case 'ProductionStarted':
      draft.status = 'in_production';
      return draft;
    case 'OrderCancelled':
      draft.status = 'cancelled';
      for (const so of draft.fulfillerOrders) {
        so.status = 'cancelled';
        so.items.forEach((i) => (i.status = 'cancelled'));
      }
      return draft;
    case 'ChildStatusApplied': {
      draft.fulfillerOrders = draft.fulfillerOrders.map((so) =>
        so.fulfillerOrderId === event.update.fulfillerOrderId ? event.update : so,
      );
      draft.status = aggregateStatus(draft);
      return draft;
    }
    case 'FulfillmentDelivered':
      draft.status = 'delivered';
      return draft;
    case 'FulfillmentFailed':
      draft.status = 'failed';
      return draft;
    default:
      return draft;
  }
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
