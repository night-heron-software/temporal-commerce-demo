// Re-export all entity types from contracts (single source of truth)
export type {
  ShippingAddress,
  FulfillerStatusUpdate,
  FulfillerOrderResult,
  FulfillmentOrderRequest,
  FulfillmentFulfillerOrderInput,
  FulfillmentItem,
  FulfillmentOrderStatus,
  FulfillmentLineItemStatus,
  FulfillmentWorkflowState,
  FulfillmentFulfillerOrderState,
  FulfillmentLineItemState,
  ShipmentInfo,
  ShipmentItemRef,
  FulfillmentStateName,
  FulfillmentCommand,
} from '../contracts/fulfillment';
