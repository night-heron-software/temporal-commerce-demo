// Re-export all definitions from contracts (single source of truth).
// Safe to import from Next.js server actions — no workflow implementations
// or activities are pulled in.
export {
  updateStatusUpdate,
  cancelOrderUpdate,
  submitFeedbackUpdate,
  refundOrderUpdate,
  requestReturnUpdate,
  confirmReturnUpdate,
  denyReturnUpdate,
  getOrderStateQuery,
  fulfillmentStatusSignal,
} from '../contracts/oms';

// Re-export types for convenience
export type {
  OrderState,
  OrderCommand,
  UpdateStatusSignal,
  SubmitFeedbackSignal,
  CancelOrderSignal,
  RefundOrderSignal,
  RequestReturnSignal,
  ConfirmReturnSignal,
  DenyReturnSignal,
  FulfillmentStatusUpdate,
} from '../contracts/oms';
