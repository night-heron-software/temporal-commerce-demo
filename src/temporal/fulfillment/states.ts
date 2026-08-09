import type { FulfillmentWorkflowState, FulfillmentCommand, FulfillmentStateName } from './types';
import type { FulfillmentResult } from './definitions';
import { fulfillmentDecider } from './fulfillment-decider';
import type { FulfillmentEvent } from './fulfillment-decider';
import { defineMachine, terminal, SELF } from '../framework';
import type { StateRegistry } from '../framework';

// ==================
// The parent machine (ADR-0024 decider-native surface, aligned with nightheron-mono).
//
// The aggregate OUTCOME is decided as events — a child status update that completes or
// dooms the whole order emits `FulfillmentDelivered` / `FulfillmentFailed`, and routing
// reads it; the shell no longer re-inspects the folded status. Cross-domain reactions
// (OMS status signals, projections, child lifecycle) stay in the workflow's hooks — they
// are per-transition semantics, not per-event.
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
    commands: { beginProduction: {} },
    route: { ProductionStarted: 'in_production' },
    transitional: true,
    onTimeout: () => ({ type: 'beginProduction' }),
  }),
  in_production: m.state('in_production', {
    commands: { cancel: {}, childStatus: {} },
    route: {
      OrderCancelled: terminal('cancelled'),
      FulfillmentDelivered: terminal('delivered'),
      FulfillmentFailed: terminal('failed'),
      '*': SELF,
    },
    timeout: '365 days',
  }),
};
