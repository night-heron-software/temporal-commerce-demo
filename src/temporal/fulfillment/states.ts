import { log } from '@temporalio/workflow';
import type {
  FulfillmentWorkflowState,
  FulfillmentSignal,
  FulfillmentStateName,
} from './types';
import type { FulfillmentResult } from './definitions';
import { StateInput, StateOutput, StateRegistry } from '../framework';

// ==================
// Status Aggregation
// ==================

function aggregateStatus(state: FulfillmentWorkflowState): FulfillmentWorkflowState['status'] {
  const statuses = state.supplierOrders.map((so) => so.status);

  if (statuses.every((s) => s === 'delivered')) return 'delivered';
  if (statuses.every((s) => s === 'cancelled' || s === 'failed')) return 'failed';
  if (statuses.every((s) => s === 'shipped' || s === 'delivered')) return 'shipped';
  if (statuses.some((s) => s === 'shipped' || s === 'delivered')) return 'partially_shipped';
  return 'in_production';
}

// ==================
// State Functions
// ==================

export async function inProductionState(
  ctx: Readonly<FulfillmentWorkflowState>,
  input: StateInput<never, FulfillmentSignal>,
): Promise<StateOutput<FulfillmentStateName, FulfillmentWorkflowState, FulfillmentResult>> {
  const draft: FulfillmentWorkflowState = {
    ...ctx,
    supplierOrders: ctx.supplierOrders.map((so) => ({
      ...so,
      items: so.items.map((i) => ({ ...i })),
      shipments: so.shipments ? so.shipments.map((s) => ({ ...s })) : undefined,
    })),
  };

  if (input.kind === 'timeout') {
    return { context: ctx, next: 'in_production' };
  }

  if (input.kind === 'signal') {
    const signal = input.result;

    if (signal.kind === 'cancel') {
      draft.status = 'cancelled';
      draft.updatedAt = new Date().toISOString();
      for (const so of draft.supplierOrders) {
        so.status = 'cancelled';
        so.items.forEach((i) => (i.status = 'cancelled'));
      }
      return { context: draft, next: '__terminal:cancelled' };
    }

    if (signal.kind === 'childStatus') {
      const childOrderState = signal.update;
      draft.supplierOrders = draft.supplierOrders.map((so) =>
        so.supplierOrderId === childOrderState.supplierOrderId ? childOrderState : so
      );

      draft.status = aggregateStatus(draft);
      draft.updatedAt = new Date().toISOString();

      if (draft.status === 'delivered') {
        return { context: draft, next: '__terminal:delivered' };
      }
      if (draft.status === 'failed') {
        return { context: draft, next: '__terminal:failed' };
      }
      if (draft.status === 'cancelled') {
        return { context: draft, next: '__terminal:cancelled' };
      }
    }
  }

  return { context: draft, next: 'in_production' };
}

export const FULFILLMENT_STATES: StateRegistry<
  FulfillmentStateName,
  never,
  FulfillmentWorkflowState,
  FulfillmentResult,
  FulfillmentSignal
> = {
  received: {
    fn: async (ctx: Readonly<FulfillmentWorkflowState>) => ({ context: ctx, next: 'in_production' as const }),
    transitional: true,
  },
  in_production: { fn: inProductionState, timeout: '365 days' },
};
