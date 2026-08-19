// Re-export all definitions from contracts (single source of truth)
export {
  getStatusQuery,
  fulfillerStatusSignal,
  childStatusSignal,
  cancelSignal,
} from '../contracts/fulfillment';

// Re-export types for convenience
export type {
  FulfillmentCommand,
  FulfillmentResult,
  FulfillmentFulfillerOrderResult,
  FulfillmentWorkflowState,
} from '../contracts/fulfillment';
