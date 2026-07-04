/**
 * Fulfillment Decider — pure Functional Core for the parent fulfillment workflow.
 *
 *   decide: (command, state) => Event[]
 *   evolve: (state, event)   => State   // the ONLY writer of fulfillment state
 *
 * Pure and infrastructure-free: timestamps arrive on the command (the shell passes the
 * driver's deterministic `meta.timestamp`), never from the clock.
 */
import type { FulfillmentWorkflowState, FulfillmentSupplierOrderState } from './types';

export type FulfillmentCommand =
  | { type: 'cancel'; at: string }
  | { type: 'childStatusReported'; update: FulfillmentSupplierOrderState; at: string };

export type FulfillmentFact =
  | { type: 'FulfillmentCancelled'; at: string }
  | { type: 'SupplierOrderReported'; update: FulfillmentSupplierOrderState; at: string };

/** Aggregate the parent status from the supplier orders' statuses. */
export function aggregateStatus(
  state: FulfillmentWorkflowState,
): FulfillmentWorkflowState['status'] {
  const statuses = state.supplierOrders.map((so) => so.status);

  if (statuses.every((s) => s === 'delivered')) return 'delivered';
  if (statuses.every((s) => s === 'cancelled' || s === 'failed')) return 'failed';
  if (statuses.every((s) => s === 'shipped' || s === 'delivered')) return 'shipped';
  if (statuses.some((s) => s === 'shipped' || s === 'delivered')) return 'partially_shipped';
  return 'in_production';
}

function copyState(state: Readonly<FulfillmentWorkflowState>): FulfillmentWorkflowState {
  return {
    ...state,
    supplierOrders: state.supplierOrders.map((so) => ({
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
      return [{ type: 'SupplierOrderReported', update: command.update, at: command.at }];
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
      for (const so of draft.supplierOrders) {
        so.status = 'cancelled';
        so.items.forEach((i) => (i.status = 'cancelled'));
      }
      return draft;

    case 'SupplierOrderReported':
      draft.supplierOrders = draft.supplierOrders.map((so) =>
        so.supplierOrderId === fact.update.supplierOrderId ? fact.update : so,
      );
      draft.status = aggregateStatus(draft);
      draft.updatedAt = fact.at;
      return draft;

    default:
      return draft;
  }
}
