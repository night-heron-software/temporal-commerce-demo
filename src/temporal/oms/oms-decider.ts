/**
 * OMS Decider — the pure Functional Core for the order workflow (ported pattern from
 * nightheron-mono, ADR-0009).
 *
 *   decide: (command, state) => Event[]      // what happened, as past-tense facts
 *   evolve: (state, event)   => State        // fold one fact into state (the ONLY writer)
 *
 * Pure and infrastructure-free: timestamps arrive on the command (the shell passes the
 * driver's deterministic `meta.timestamp`), never from the clock. The fulfillment-signal
 * decision also emits the aggregated order-level status change (all-shipped /
 * all-delivered) as its own fact, computed against the post-mirror fulfiller statuses.
 */
import type {
  OrderState,
  OrderStatus,
  StatusHistoryEntry,
  FulfillmentStatusUpdate,
  CustomerFeedback,
} from './types';

export type OmsCommand =
  | {
      type: 'statusUpdated';
      status: OrderStatus;
      note?: string;
      updatedBy: StatusHistoryEntry['updatedBy'];
      at: string;
    }
  | { type: 'orderCancelled'; reason?: string; at: string }
  | { type: 'feedbackSubmitted'; rating: CustomerFeedback['rating']; comment?: string; at: string }
  | { type: 'fulfillmentStatusReported'; update: FulfillmentStatusUpdate; at: string };

export type OmsFact =
  | {
      type: 'StatusChanged';
      status: OrderStatus;
      note?: string;
      updatedBy: StatusHistoryEntry['updatedBy'];
      at: string;
    }
  | { type: 'FeedbackRecorded'; rating: CustomerFeedback['rating']; comment?: string; at: string }
  | { type: 'FulfillerOrderStatusMirrored'; update: FulfillmentStatusUpdate; at: string };

function copyState(state: Readonly<OrderState>): OrderState {
  return {
    ...state,
    statusHistory: [...state.statusHistory],
    assignments: state.assignments.map((a) => ({ ...a })),
    fulfillerOrders: state.fulfillerOrders.map((so) => ({
      ...so,
      items: so.items.map((i) => ({ ...i })),
      statusHistory: [...so.statusHistory],
    })),
  };
}

export function decide(command: OmsCommand, state: OrderState): OmsFact[] {
  switch (command.type) {
    case 'statusUpdated':
      return [
        {
          type: 'StatusChanged',
          status: command.status,
          note: command.note,
          updatedBy: command.updatedBy,
          at: command.at,
        },
      ];

    case 'orderCancelled':
      return [
        {
          type: 'StatusChanged',
          status: 'cancelled',
          note: command.reason || 'Order cancelled',
          updatedBy: 'admin',
          at: command.at,
        },
      ];

    case 'feedbackSubmitted':
      return [
        { type: 'FeedbackRecorded', rating: command.rating, comment: command.comment, at: command.at },
        {
          type: 'StatusChanged',
          status: 'complete',
          note: 'Customer submitted feedback',
          updatedBy: 'customer',
          at: command.at,
        },
      ];

    case 'fulfillmentStatusReported': {
      const { update, at } = command;
      const fulfillerOrder = state.fulfillerOrders.find(
        (so) => so.fulfillerOrderId === update.fulfillerOrderId,
      );
      // Unknown fulfiller order — no facts (the shell logs and stays put).
      if (!fulfillerOrder) return [];

      const facts: OmsFact[] = [{ type: 'FulfillerOrderStatusMirrored', update, at }];

      // Aggregate the order-level status against the post-mirror fulfiller statuses.
      const postStatuses = state.fulfillerOrders.map((so) =>
        so.fulfillerOrderId === update.fulfillerOrderId ? update.status : so.status,
      );
      if (update.status === 'shipped' && state.status === 'processing') {
        const allShipped = postStatuses.every(
          (s) => s === 'shipped' || s === 'delivered' || s === 'rejected',
        );
        if (allShipped) {
          facts.push({
            type: 'StatusChanged',
            status: 'shipped',
            note: 'All fulfiller orders shipped',
            updatedBy: 'system',
            at,
          });
        }
      } else if (
        update.status === 'delivered' &&
        (state.status === 'shipped' || state.status === 'processing')
      ) {
        const allDelivered = postStatuses.every((s) => s === 'delivered' || s === 'rejected');
        if (allDelivered) {
          facts.push({
            type: 'StatusChanged',
            status: 'delivered',
            note: 'All fulfiller orders delivered',
            updatedBy: 'system',
            at,
          });
        }
      }
      return facts;
    }

    default:
      return [];
  }
}

export function evolve(state: OrderState, fact: OmsFact): OrderState {
  const next = copyState(state);
  switch (fact.type) {
    case 'StatusChanged':
      next.status = fact.status;
      next.updatedAt = fact.at;
      next.statusHistory.push({
        status: fact.status,
        timestamp: fact.at,
        note: fact.note,
        updatedBy: fact.updatedBy,
      });
      if (fact.status === 'delivered') {
        next.deliveredAt = fact.at;
      }
      return next;

    case 'FeedbackRecorded':
      next.customerFeedback = {
        rating: fact.rating,
        comment: fact.comment,
        submittedAt: fact.at,
      };
      return next;

    case 'FulfillerOrderStatusMirrored': {
      const { update, at } = fact;
      const fulfillerOrder = next.fulfillerOrders.find(
        (so) => so.fulfillerOrderId === update.fulfillerOrderId,
      );
      if (!fulfillerOrder) return next;

      fulfillerOrder.status = update.status;
      fulfillerOrder.updatedAt = at;
      if (update.carrier) fulfillerOrder.carrier = update.carrier;
      if (update.trackingNumber) fulfillerOrder.trackingNumber = update.trackingNumber;
      if (update.trackingUrl) fulfillerOrder.trackingUrl = update.trackingUrl;
      fulfillerOrder.statusHistory.push({
        status: update.status,
        timestamp: at,
        note: update.error || 'Status updated from fulfillment workflow',
      });

      // Mirror onto the corresponding assignments.
      for (const item of fulfillerOrder.items) {
        const assignment = next.assignments.find((a) => a.assignmentId === item.assignmentId);
        if (assignment) {
          if (update.status === 'shipped') {
            assignment.status = 'shipped';
            if (update.carrier) assignment.carrier = update.carrier;
          } else if (update.status === 'delivered') {
            assignment.status = 'delivered';
          } else if (update.status === 'rejected') {
            assignment.status = 'rejected';
          }
        }
      }
      return next;
    }

    default:
      return next;
  }
}
