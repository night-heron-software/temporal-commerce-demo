/**
 * OMS Decider — the pure Functional Core (aligned with nightheron-mono, ADR-0009).
 *
 *   decide: (command, state) => Event[]     // what happened, as past-tense facts
 *   evolve: (state, event)   => State        // fold one fact into state (the ONLY writer)
 *
 * Both functions are pure — no I/O, no clock, no `uuid4`, no Temporal. The deterministic
 * timestamp a decision needs is injected into the *command* by the shell (`states.ts`).
 * `evolve` is the sole writer of order status / feedback / refunds / return request /
 * fulfiller-order state.
 *
 * Scope (mirrors the mono rollout decision): this covers the post-intake *lifecycle* —
 * cancel, status updates, feedback, refunds, returns, and fulfilment-status aggregation.
 * The I/O saga *intake* states (pending_assignment → assigning_fulfillers →
 * requesting_fulfillment) and the `finalize` effect union stay imperative in the shell.
 */

import type { Decider } from '../framework';
import type {
  OrderState,
  OrderStatus,
  FulfillmentStatusUpdate,
  FulfillerOrder,
  RefundLineInput,
  RefundRecord,
  ReturnRequestRecord,
} from './types';

/** The Chassaing "command": a lifecycle intent, enriched with the deterministic timestamp. */
export type OrderCommand =
  | { type: 'cancelOrder' }
  | { type: 'updateStatus'; status: OrderStatus }
  | { type: 'submitFeedback'; rating: 1 | 2 | 3 | 4 | 5; comment?: string; at: string }
  | { type: 'refundOrder'; lines?: RefundLineInput[]; reason?: string; at: string }
  | {
      type: 'requestReturn';
      lines?: RefundLineInput[];
      reason?: string;
      updatedBy?: 'system' | 'admin' | 'customer';
      at: string;
    }
  | { type: 'confirmReturn'; reason?: string; at: string }
  | { type: 'denyReturn' }
  | { type: 'fulfillmentStatus'; update: FulfillmentStatusUpdate; at: string };

/** Past-tense domain facts. */
export type OrderFact =
  | { type: 'OrderCancelled' }
  | { type: 'StatusChanged'; status: OrderStatus }
  | { type: 'FeedbackSubmitted'; rating: 1 | 2 | 3 | 4 | 5; comment?: string; at: string }
  | { type: 'Refunded'; record: RefundRecord; fullyRefunded: boolean }
  | { type: 'ReturnRequested'; record: ReturnRequestRecord }
  | { type: 'ReturnConfirmed'; record: RefundRecord }
  | { type: 'ReturnDenied' }
  | { type: 'FulfillmentApplied'; update: FulfillmentStatusUpdate; at: string };

/** Deep-copy order state for immutable folds (history entries copied too, so evolve is pure). */
export function copyOrderState(ctx: Readonly<OrderState>): OrderState {
  return {
    ...ctx,
    statusHistory: ctx.statusHistory.map((h) => ({ ...h })),
    assignments: ctx.assignments.map((a) => ({ ...a })),
    fulfillerOrders: ctx.fulfillerOrders.map((so) => ({
      ...so,
      items: so.items.map((i) => ({ ...i })),
      statusHistory: so.statusHistory.map((h) => ({ ...h })),
    })),
    refunds: ctx.refunds ? [...ctx.refunds] : undefined,
  };
}

/** Round to cents-precision to keep pro-rated tax stable across folds. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure refund computation (simplified from the mono's accounting-package breakdown):
 * validates the selection, pro-rates order tax by the refunded retail share, guards
 * against over-refunding, and reports whether every unit is now refunded. Throws on an
 * invalid selection (unknown line / non-positive qty / exceeds remaining) — the framework
 * converts the throw into an update rejection.
 */
function computeRefundRecord(
  ctx: Readonly<OrderState>,
  selections: RefundLineInput[] | undefined,
  reason: string | undefined,
  at: string,
): { record: RefundRecord; fullyRefunded: boolean } {
  const alreadyRefunded: Record<string, number> = {};
  for (const r of ctx.refunds ?? []) {
    for (const l of r.lines) {
      alreadyRefunded[l.lineItemId] = (alreadyRefunded[l.lineItemId] ?? 0) + l.quantity;
    }
  }

  const remainingFor = (lineItemId: string): number => {
    const item = ctx.order.items.find((i) => i.lineItemId === lineItemId);
    if (!item) throw new Error(`Unknown line item in refund selection: ${lineItemId}`);
    return item.quantity - (alreadyRefunded[lineItemId] ?? 0);
  };

  // Omitted/empty selection = full refund of all remaining quantity.
  const lines =
    selections ??
    ctx.order.items
      .map((item) => ({ lineItemId: item.lineItemId, quantity: remainingFor(item.lineItemId) }))
      .filter((l) => l.quantity > 0);

  if (lines.length === 0) throw new Error('Nothing left to refund');

  let refundAmount = 0;
  for (const l of lines) {
    if (l.quantity <= 0) throw new Error(`Non-positive refund quantity for ${l.lineItemId}`);
    const remaining = remainingFor(l.lineItemId);
    if (l.quantity > remaining) {
      throw new Error(
        `Refund quantity ${l.quantity} exceeds remaining ${remaining} for ${l.lineItemId}`,
      );
    }
    const item = ctx.order.items.find((i) => i.lineItemId === l.lineItemId)!;
    refundAmount += item.price * l.quantity;
  }

  // Pro-rate order tax by the refunded retail share of the subtotal.
  const taxAmount =
    ctx.order.subtotal > 0 ? round2(ctx.order.tax * (refundAmount / ctx.order.subtotal)) : 0;

  const refundedAfter: Record<string, number> = { ...alreadyRefunded };
  for (const l of lines) {
    refundedAfter[l.lineItemId] = (refundedAfter[l.lineItemId] ?? 0) + l.quantity;
  }
  const fullyRefunded = ctx.order.items.every(
    (item) => (refundedAfter[item.lineItemId] ?? 0) >= item.quantity,
  );

  const record: RefundRecord = {
    refundId: `refund-${(ctx.refunds?.length ?? 0) + 1}`,
    timestamp: at,
    reason,
    lines: lines.map((l) => ({ lineItemId: l.lineItemId, quantity: l.quantity })),
    refundAmount: round2(refundAmount),
    taxAmount,
  };

  return { record, fullyRefunded };
}

/** The machine state implied by the aggregate status of all fulfiller orders (forward-only). */
export function aggregateShippingState(
  fulfillerOrders: ReadonlyArray<FulfillerOrder>,
): 'processing' | 'partially_shipped' | 'shipped' | 'delivered' {
  const isDelivered = (s: FulfillerOrder['status']) => s === 'delivered' || s === 'rejected';
  const isShipped = (s: FulfillerOrder['status']) =>
    s === 'shipped' || s === 'delivered' || s === 'rejected';
  if (fulfillerOrders.every((so) => isDelivered(so.status))) return 'delivered';
  if (fulfillerOrders.every((so) => isShipped(so.status))) return 'shipped';
  if (fulfillerOrders.some((so) => so.status === 'shipped' || so.status === 'delivered'))
    return 'partially_shipped';
  return 'processing';
}

/**
 * decide(command, state) → facts. Pure: emits the facts implied by the command. Refund and
 * return-confirm compute the (pure) refund breakdown here; a fulfilment update for an unknown
 * fulfiller order emits nothing (the shell logs + stays put).
 */
export function decide(command: OrderCommand, state: OrderState): OrderFact[] {
  switch (command.type) {
    case 'cancelOrder':
      return [{ type: 'OrderCancelled' }];

    case 'updateStatus':
      return [{ type: 'StatusChanged', status: command.status }];

    case 'submitFeedback':
      return [
        {
          type: 'FeedbackSubmitted',
          rating: command.rating,
          comment: command.comment,
          at: command.at,
        },
      ];

    case 'refundOrder': {
      const { record, fullyRefunded } = computeRefundRecord(
        state,
        command.lines,
        command.reason,
        command.at,
      );
      return [{ type: 'Refunded', record, fullyRefunded }];
    }

    case 'requestReturn':
      return [
        {
          type: 'ReturnRequested',
          record: {
            lines: command.lines,
            reason: command.reason,
            requestedAt: command.at,
            requestedBy: command.updatedBy,
          },
        },
      ];

    case 'confirmReturn': {
      const req = state.returnRequest;
      const { record } = computeRefundRecord(
        state,
        req?.lines,
        command.reason ?? req?.reason,
        command.at,
      );
      return [{ type: 'ReturnConfirmed', record }];
    }

    case 'denyReturn':
      return [{ type: 'ReturnDenied' }];

    case 'fulfillmentStatus':
      return state.fulfillerOrders.some(
        (so) => so.fulfillerOrderId === command.update.fulfillerOrderId,
      )
        ? [{ type: 'FulfillmentApplied', update: command.update, at: command.at }]
        : [];

    default:
      return [];
  }
}

/** Fold a single fulfilment-status fact: apply to the fulfiller order, then aggregate. */
function applyFulfillment(
  draft: OrderState,
  update: FulfillmentStatusUpdate,
  at: string,
): OrderState {
  const fulfillerOrder = draft.fulfillerOrders.find(
    (so) => so.fulfillerOrderId === update.fulfillerOrderId,
  );
  if (!fulfillerOrder) return draft;

  fulfillerOrder.status = update.status;
  fulfillerOrder.updatedAt = at;
  if (update.carrier) fulfillerOrder.carrier = update.carrier;
  if (update.trackingNumber) fulfillerOrder.trackingNumber = update.trackingNumber;
  if (update.trackingUrl) fulfillerOrder.trackingUrl = update.trackingUrl;

  const lastHistoryEntry = fulfillerOrder.statusHistory[fulfillerOrder.statusHistory.length - 1];
  if (lastHistoryEntry && lastHistoryEntry.status === update.status) {
    lastHistoryEntry.timestamp = at;
    if (update.error) lastHistoryEntry.note = update.error;
  } else {
    fulfillerOrder.statusHistory.push({
      status: update.status,
      timestamp: at,
      note: update.error || `Status updated from fulfillment workflow`,
    });
  }

  for (const item of fulfillerOrder.items) {
    const assignment = draft.assignments.find((a) => a.assignmentId === item.assignmentId);
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

  const agg = aggregateShippingState(draft.fulfillerOrders);
  draft.status = agg;
  if (agg === 'delivered') draft.deliveredAt = at;
  return draft;
}

/**
 * evolve(state, fact) → state. Pure fold; the ONLY writer of order status / feedback / refunds /
 * return request / fulfiller-order state.
 */
export function evolve(state: OrderState, fact: OrderFact): OrderState {
  const draft = copyOrderState(state);
  switch (fact.type) {
    case 'OrderCancelled':
      draft.status = 'cancelled';
      return draft;

    case 'StatusChanged':
      draft.status = fact.status;
      return draft;

    case 'FeedbackSubmitted':
      draft.status = 'complete';
      draft.customerFeedback = { rating: fact.rating, comment: fact.comment, submittedAt: fact.at };
      return draft;

    case 'Refunded':
      draft.refunds = [...(draft.refunds ?? []), fact.record];
      if (fact.fullyRefunded) draft.status = 'refunded';
      draft.updatedAt = fact.record.timestamp;
      return draft;

    case 'ReturnRequested':
      draft.returnRequest = fact.record;
      return draft;

    case 'ReturnConfirmed':
      draft.refunds = [...(draft.refunds ?? []), fact.record];
      draft.status = 'returned';
      draft.returnRequest = undefined;
      draft.updatedAt = fact.record.timestamp;
      return draft;

    case 'ReturnDenied':
      draft.returnRequest = undefined;
      return draft;

    case 'FulfillmentApplied':
      return applyFulfillment(draft, fact.update, fact.at);

    default:
      return draft;
  }
}

/** Terminal statuses — the order lifecycle's defined ends. */
function isTerminalStatus(state: OrderState): boolean {
  return (
    state.status === 'cancelled' ||
    state.status === 'refunded' ||
    state.status === 'returned' ||
    state.status === 'complete'
  );
}

/**
 * The assembled Decider, conforming to the shared `Decider<Command, Event, State>` shape.
 * `initialState` documents the birth shape for the Decider; at runtime the real initial context
 * is built from workflow input (`orderWorkflow`).
 */
export const omsDecider: Decider<OrderCommand, OrderFact, OrderState> = {
  decide,
  evolve,
  isTerminal: isTerminalStatus,
  initialState: {
    order: undefined as unknown as OrderState['order'],
    status: 'pending_assignment',
    statusHistory: [],
    assignments: [],
    fulfillerOrders: [],
  },
};
