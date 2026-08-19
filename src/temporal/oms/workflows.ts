import { log, setHandler, getExternalWorkflowHandle } from '@temporalio/workflow';
import { buildWorkflowId, DEMO_STORE_ID } from '../contracts/constants';
import { ES_INDICES } from '../contracts/elasticsearch';

import {
  saveOrderToDatabase,
  updateOrderInDatabase,
  insertStatusHistoryEntry,
  indexOrder,
  indexFulfillerOrder,
} from './activities';

import {
  OrderState,
  OrderWorkflowInput,
  StatusHistoryEntry,
  OrderStateName,
  OrderCommand,
  OrderStatus,
  FulfillmentStatusUpdate,
} from './types';

import { buildOrderDocument, buildFulfillerOrderDocument } from './document-builder';

import {
  updateStatusUpdate,
  cancelOrderUpdate,
  submitFeedbackUpdate,
  refundOrderUpdate,
  requestReturnUpdate,
  confirmReturnUpdate,
  denyReturnUpdate,
  getOrderStateQuery,
  fulfillmentStatusSignal,
} from './definitions';

import {
  runStateMachine,
  StateMachineConfig,
  MappedUpdateRegistration,
  SignalRegistration,
  deriveDisplayStatus,
} from '../framework';

import { OMS_STATES } from './states';

// Re-export definitions for backward compatibility with workers
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
};

export async function orderWorkflow(input: OrderWorkflowInput): Promise<OrderState> {
  log.info('[OMS] orderWorkflow started', {
    orderId: input.order.orderId,
    cartId: input.order.cartId,
  });

  const state: OrderState = input.restoredState || {
    order: input.order,
    status: 'pending_assignment',
    statusHistory: [
      {
        status: 'pending_assignment',
        timestamp: new Date().toISOString(),
        updatedBy: 'system',
      },
    ],
    assignments: [],
    fulfillerOrders: [],
  };

  const getOrderDocument = () => buildOrderDocument(input.order, state, input.customerEmail);

  // Wire Query
  setHandler(getOrderStateQuery, () => state);

  // Wire State Machine Config
  const config: StateMachineConfig<
    OrderStateName,
    OrderCommand,
    OrderState,
    OrderState,
    OrderCommand
  > = {
    states: OMS_STATES,
    initialState: input.restoredState
      ? (input.restoredState.status as OrderStateName)
      : 'pending_assignment',
    onContextUpdate: (newCtx, currentState) => {
      Object.assign(state, newCtx);
      // Sync status from driver state — the driver is the single source of truth
      state.status = deriveDisplayStatus<OrderStateName>(currentState);
    },
    onStart: async (startCtx) => {
      const isResumed = !!input.restoredState;
      if (isResumed) return { context: startCtx };

      // Idempotent bootstrap only. All order-intake orchestration — fulfiller
      // assignment (assigning_fulfillers), fulfiller-order creation + starting the
      // fulfillment child (requesting_fulfillment) — lives in the state machine as
      // decided events + effects.
      await saveOrderToDatabase(input.order);
      await insertStatusHistoryEntry(
        input.order.orderId,
        startCtx.statusHistory[0],
        input.order.correlationId,
      );
      await indexOrder(buildOrderDocument(input.order, startCtx, input.customerEmail));

      return { context: startCtx, nextState: 'pending_assignment' };
    },
    onTransition: async (from, to, eventDesc, _ctx, at) => {
      state.updatedAt = at;

      const cleanToStatus = deriveDisplayStatus<OrderStatus>(to);

      if (cleanToStatus !== from) {
        let note = 'State transition';
        let updatedBy: 'system' | 'admin' | 'customer' = 'system';

        // Excludes every string marker ('timeout' | 'signal' | 'automatic') rather than
        // listing them (demo PR #45): a literal exclusion list would silently treat a
        // newly-added marker as a command object and dereference `.type` on a string.
        if (typeof eventDesc !== 'string') {
          if (eventDesc.type === 'updateStatus') {
            note = eventDesc.note || 'Status updated';
            updatedBy = eventDesc.updatedBy;
          } else if (eventDesc.type === 'cancelOrder') {
            note = eventDesc.reason || 'Order cancelled';
            updatedBy = 'admin';
          } else if (eventDesc.type === 'submitFeedback') {
            note = 'Customer submitted feedback';
            updatedBy = 'customer';
          }
        } else if (eventDesc === 'signal') {
          note = 'Status updated from fulfillment';
        }

        const entry: StatusHistoryEntry = {
          status: cleanToStatus,
          timestamp: at,
          note,
          updatedBy,
        };
        state.statusHistory.push(entry);
        await insertStatusHistoryEntry(input.order.orderId, entry, input.order.correlationId);
      }

      await updateOrderInDatabase(input.order.orderId, {
        status: state.status,
        statusHistory: state.statusHistory,
        assignments: state.assignments,
        fulfillerOrders: state.fulfillerOrders,
        customerFeedback: state.customerFeedback,
        deliveredAt: state.deliveredAt,
      });

      await indexOrder(getOrderDocument());

      for (const so of state.fulfillerOrders) {
        await indexFulfillerOrder(buildFulfillerOrderDocument(so, input.order.correlationId));
      }
    },
    continueAsNewThreshold: 200,
    serializeForContinueAsNew: (currentCtx) => {
      return {
        ...input,
        restoredState: currentCtx,
        signalCount: 0,
      };
    },
    onCancellation: async (cancelCtx) => {
      log.info('[OMS] Order workflow cancelled, signaling fulfillment to cancel', {
        orderId: input.order.orderId,
      });
      cancelCtx.status = 'cancelled';
      const cancelEntry: StatusHistoryEntry = {
        status: 'cancelled',
        timestamp: new Date().toISOString(),
        note: 'Order workflow cancelled',
        updatedBy: 'system',
      };
      cancelCtx.statusHistory.push(cancelEntry);

      // Cancel the child fulfillment workflow if it exists
      try {
        const fulfillmentWorkflowId = buildWorkflowId(
          DEMO_STORE_ID,
          'fulfillment',
          input.order.orderId,
        );
        const handle = getExternalWorkflowHandle(fulfillmentWorkflowId);
        await handle.cancel();
      } catch (e) {
        log.warn('[OMS] Failed to cancel fulfillment workflow (may have already completed)', {
          error: String(e),
        });
      }

      await updateOrderInDatabase(input.order.orderId, {
        status: cancelCtx.status,
        statusHistory: cancelCtx.statusHistory,
      });
      await insertStatusHistoryEntry(input.order.orderId, cancelEntry, input.order.correlationId);
      await indexOrder(getOrderDocument());
    },
    onTerminal: async (finalCtx, terminalState) => {
      log.info('[OMS] Order reached terminal state', {
        orderId: input.order.orderId,
        terminalState,
      });
      // Final projection sync to ensure ES is consistent
      await indexOrder(getOrderDocument());
      for (const so of finalCtx.fulfillerOrders) {
        await indexFulfillerOrder(buildFulfillerOrderDocument(so, input.order.correlationId));
      }
    },
    // OMS is the sole writer of both indices. Terminal fulfiller_orders docs are already
    // lifecycle-stamped at write time by buildFulfillerOrderDocument (the child closes
    // long before OMS does); this close-mark is the orders doc plus a backstop for any
    // SO that never reached a terminal status.
    projections: {
      refs: (finalCtx) => [
        { index: ES_INDICES.orders, id: input.order.orderId },
        ...finalCtx.fulfillerOrders.map((so) => ({
          index: ES_INDICES.fulfillerOrders,
          id: so.fulfillerOrderId,
        })),
      ],
    },
  };

  const updateHandlers: MappedUpdateRegistration<OrderCommand, OrderState, OrderState>[] = [
    {
      definition: updateStatusUpdate,
      toEvent: (args) => ({
        type: 'updateStatus',
        status: args.status,
        note: args.note,
        updatedBy: args.updatedBy,
      }),
      formatError: (err) => ({ ...state, error: err }),
    },
    {
      definition: cancelOrderUpdate,
      toEvent: (args) => ({ type: 'cancelOrder', reason: args.reason }),
      formatError: (err) => ({ ...state, error: err }),
    },
    {
      definition: submitFeedbackUpdate,
      toEvent: (args) => ({ type: 'submitFeedback', rating: args.rating, comment: args.comment }),
      formatError: (err) => ({ ...state, error: err }),
    },
    {
      definition: refundOrderUpdate,
      toEvent: (args) => ({
        type: 'refundOrder',
        lines: args.lines,
        reason: args.reason,
        updatedBy: args.updatedBy,
      }),
      // No formatError: invalid refund selections (over-refund, unknown line)
      // should reject the update so the caller sees the failure.
    },
    {
      definition: requestReturnUpdate,
      toEvent: (args) => ({
        type: 'requestReturn',
        lines: args.lines,
        reason: args.reason,
        updatedBy: args.updatedBy,
      }),
      formatError: (err) => ({ ...state, error: err }),
    },
    {
      definition: confirmReturnUpdate,
      toEvent: (args) => ({ type: 'confirmReturn', reason: args.reason }),
      // No formatError: an invalid return refund selection should reject the update.
    },
    {
      definition: denyReturnUpdate,
      toEvent: (args) => ({ type: 'denyReturn', reason: args.reason }),
      formatError: (err) => ({ ...state, error: err }),
    },
  ];

  // ADR-0024: the child-workflow status signal is transport — mapped to the
  // `fulfillmentStatus` command at registration.
  const signals: SignalRegistration<OrderCommand>[] = [
    {
      definition: fulfillmentStatusSignal,
      toSignal: (update: FulfillmentStatusUpdate): OrderCommand => ({
        type: 'fulfillmentStatus',
        update,
      }),
    },
  ];

  await runStateMachine<OrderStateName, OrderCommand, OrderState, OrderState, OrderCommand>(
    config,
    state,
    updateHandlers,
    signals,
  );

  return state;
}
