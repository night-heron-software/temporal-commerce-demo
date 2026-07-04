/**
 * Fulfillment Decider — pure Functional Core for the parent fulfillment workflow.
 *
 *   decide: (command, state) => Event[]
 *   evolve: (state, event)   => State   // the ONLY writer of fulfillment state
 *
 * Pure and infrastructure-free: timestamps arrive on the command (the shell passes the
 * driver's deterministic `meta.timestamp`), never from the clock.
 */
import type { FulfillmentWorkflowState, FulfillmentFulfillerOrderState } from './types';

export type FulfillmentCommand =
  | { type: 'cancel'; at: string }
  | { type: 'childStatusReported'; update: FulfillmentFulfillerOrderState; at: string };

export type FulfillmentFact =
  | { type: 'FulfillmentCancelled'; at: string }
  | { type: 'FulfillerOrderReported'; update: FulfillmentFulfillerOrderState; at: string };

/** Aggregate the parent status from the fulfiller orders' statuses. */
export function aggregateStatus(
  state: FulfillmentWorkflowState,
): FulfillmentWorkflowState['status'] {
  const statuses = state.fulfillerOrders.map((so) => so.status);

  if (statuses.every((s) => s === 'delivered')) return 'delivered';
  if (statuses.every((s) => s === 'cancelled' || s === 'failed')) return 'failed';
  if (statuses.every((s) => s === 'shipped' || s === 'delivered')) return 'shipped';
  if (statuses.some((s) => s === 'shipped' || s === 'delivered')) return 'partially_shipped';
  return 'in_production';
}

function copyState(state: Readonly<FulfillmentWorkflowState>): FulfillmentWorkflowState {
  return {
    ...state,
    fulfillerOrders: state.fulfillerOrders.map((so) => ({
      ...so,
      items: so.items.map((i) => ({ ...i })),
      shipments: so.shipments ? so.shipments.map((s) => ({ ...s })) : undefined,
    })),
  };
}

export function decide(
  command: FulfillmentCommand,
  _state: FulfillmentWorkflowState,
): FulfillmentFact[] {
  switch (command.type) {
    case 'cancel':
      return [{ type: 'FulfillmentCancelled', at: command.at }];
    case 'childStatusReported':
      return [{ type: 'FulfillerOrderReported', update: command.update, at: command.at }];
    default:
      return [];
  }
}

export function evolve(
  state: FulfillmentWorkflowState,
  fact: FulfillmentFact,
): FulfillmentWorkflowState {
  const draft = copyState(state);
  switch (fact.type) {
    case 'FulfillmentCancelled':
      draft.status = 'cancelled';
      draft.updatedAt = fact.at;
      for (const so of draft.fulfillerOrders) {
        so.status = 'cancelled';
        so.items.forEach((i) => (i.status = 'cancelled'));
      }
      return draft;

    case 'FulfillerOrderReported':
      draft.fulfillerOrders = draft.fulfillerOrders.map((so) =>
        so.fulfillerOrderId === fact.update.fulfillerOrderId ? fact.update : so,
      );
      draft.status = aggregateStatus(draft);
      draft.updatedAt = fact.at;
      return draft;

    default:
      return draft;
  }
}
