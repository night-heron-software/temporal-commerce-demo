/**
 * Fulfillment states — the shell around the pure fulfillment Decider.
 *
 * The parent fulfillment workflow is entirely signal-driven: child supplier-order
 * workflows report status via the `childStatus` signal; OMS can `cancel`. Routing to
 * a terminal happens here from the decider-aggregated status.
 */
import type {
  FulfillmentWorkflowState,
  FulfillmentSignal,
  FulfillmentStateName,
} from './types';
import type { FulfillmentResult } from './definitions';
import { decide as fulfillmentDecide, evolve } from './fulfillment-decider';
import type { FulfillmentCommand } from './fulfillment-decider';
import { defineDomain, terminal } from '../framework';
import type { StateRegistry } from '../framework';

const fulfillment = defineDomain<
  FulfillmentStateName,
  never,
  FulfillmentWorkflowState,
  FulfillmentResult,
  FulfillmentSignal
>();

/** Shell adapter — run the pure Decider (decide → evolve) for the next state. */
function apply(
  ctx: Readonly<FulfillmentWorkflowState>,
  command: FulfillmentCommand,
): FulfillmentWorkflowState {
  const state = ctx as FulfillmentWorkflowState;
  return fulfillmentDecide(command, state).reduce(evolve, state);
}

// ==================
// State: received — transitional entry (onStart spawns children, then we wait)
// ==================

const received = fulfillment.state('received', {
  decide(ctx) {
    return { context: ctx as FulfillmentWorkflowState, next: 'in_production' as const };
  },
});

// ==================
// State: in_production — signal-driven aggregation until all children close
// ==================

const inProduction = fulfillment.transitions(
  'in_production',
  {},
  {
    onTimeout: {
      decide(ctx) {
        return { context: ctx as FulfillmentWorkflowState, next: 'in_production' as const };
      },
    },
    onSignals: {
      cancel: {
        decide(ctx, _signal, meta) {
          const context = apply(ctx, { type: 'cancel', at: meta.timestamp });
          return { context, next: terminal('cancelled') };
        },
      },
      childStatus: {
        decide(ctx, signal, meta) {
          const context = apply(ctx, {
            type: 'childStatusReported',
            update: signal.update,
            at: meta.timestamp,
          });
          if (context.status === 'delivered') return { context, next: terminal('delivered') };
          if (context.status === 'failed') return { context, next: terminal('failed') };
          if (context.status === 'cancelled') return { context, next: terminal('cancelled') };
          return { context, next: 'in_production' as const };
        },
      },
    },
  },
);

export const FULFILLMENT_STATES: StateRegistry<
  FulfillmentStateName,
  never,
  FulfillmentWorkflowState,
  FulfillmentResult,
  FulfillmentSignal
> = {
  received: { ...received, transitional: true },
  in_production: { ...inProduction, timeout: '365 days' },
};
