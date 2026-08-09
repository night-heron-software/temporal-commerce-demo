/**
 * OMS Decider — pure Functional Core, on the ADR-0024 decider-native surface
 * (aligned with nightheron-mono): the framework owns the fold, this module supplies only
 *
 *   decide: (command, state) => Event[]     // what happened, as past-tense events
 *   evolve: (state, event)   => State       // fold one event into state (the ONLY writer)
 *
 * Pure — no I/O, no clock, no `uuid4`, no Temporal. The deterministic timestamp and any
 * prepared data (resolved fulfiller assignments, minted fulfiller-order ids) arrive ON the
 * enriched command; ids are minted in the states' `prepare` phases.
 *
 * Scope: the FULL order lifecycle, intake included. The old split — "the I/O saga intake
 * states stay imperative in the shell" — is gone: fulfiller assignment and fulfiller-order
 * construction are decided here as events (`FulfillersAssigned`, `FulfillmentRequested`),
 * and the shell's reactions (emails, the fulfillment child start) are event-keyed effects
 * in `states.ts`. (Demo divergence: `capturePayment` decides a bare `PaymentCaptured` —
 * the mono computes the ORDER_CAPTURE ledger numbers here; the demo has no accounting.)
 *
 * Status routing: an admin `updateStatus` decides a per-target event (`OrderShipped`,
 * `OrderRefunded`, …) rather than a payload-routed `StatusChanged` — route tables key on
 * event TYPE, so every admin jump is a visible edge in the state diagram. Fulfilment
 * aggregation likewise decides its OUTCOME (`FulfillmentShipped` / `FulfillmentDelivered`
 * / `FulfillmentPartiallyShipped`) instead of the shell re-inspecting the folded status.
 */

import type { MachineDecider } from '../framework';
import type { Cart, Fulfillment } from '../contracts';
import type {
  OrderState,
  OrderStatus,
  OrderCommand,
  OrderAssignment,
  FulfillmentStatusUpdate,
  FulfillerOrder,
  RefundLineInput,
  RefundRecord,
  ReturnRequestRecord,
} from './types';

// ==================
// Commands (enriched) and events
// ==================

/** Order line item shape with the optional display fields the intake logic reads. */
export interface OrderCartItem extends Cart.CartItem {
  productId?: string;
  title?: string;
  variantTitle?: string;
}

/** A fulfiller resolution for one order line (positional), with its prepared assignment id. */
export type ResolvedAssignment = {
  assignmentId: string;
  fulfillerId: string;
  fulfillerName?: string;
  fulfillerType?: string;
  sku?: string;
} | null;

/**
 * The command as the decider sees it: the wire/timer command + the framework-injected
 * timestamp, plus the prepared data two intake commands need (id minting and fulfiller
 * resolution are impure — they run in `prepare` and ride in on the enriched command).
 */
export type EnrichedOrderCommand = (
  | Exclude<OrderCommand, { type: 'assignFulfillers' } | { type: 'requestFulfillment' }>
  | (Extract<OrderCommand, { type: 'assignFulfillers' }> & { resolved: ResolvedAssignment[] })
  | (Extract<OrderCommand, { type: 'requestFulfillment' }> & {
      fulfillerOrderIds: Record<string, string>;
    })
) & { at: string };

/** Past-tense domain events. */
export type OrderEvent =
  // ── intake ──
  // Demo divergence: no capture payload — the mono decides the ORDER_CAPTURE ledger
  // numbers here; the demo took mock payment at checkout and has no accounting domain.
  | { type: 'PaymentCaptured'; at: string }
  | { type: 'FulfillersAssigned'; assignments: OrderAssignment[]; at: string }
  | { type: 'NoFulfillersResolved'; at: string }
  | {
      type: 'FulfillmentRequested';
      fulfillerOrders: FulfillerOrder[];
      fulfillmentInputs: Fulfillment.FulfillmentFulfillerOrderInput[];
      at: string;
    }
  // ── lifecycle ──
  | { type: 'OrderCancelled'; at: string }
  | { type: 'FeedbackSubmitted'; rating: 1 | 2 | 3 | 4 | 5; comment?: string; at: string }
  | { type: 'Refunded'; record: RefundRecord; fullyRefunded: boolean; at: string }
  | { type: 'ReturnRequested'; record: ReturnRequestRecord; at: string }
  | { type: 'ReturnConfirmed'; record: RefundRecord; at: string }
  | { type: 'ReturnDenied'; at: string }
  | { type: 'FulfillmentApplied'; update: FulfillmentStatusUpdate; at: string }
  // ── fulfilment-aggregate outcomes (decided, so routing never re-reads folded status) ──
  | { type: 'FulfillmentPartiallyShipped'; at: string }
  | { type: 'FulfillmentShipped'; at: string }
  | { type: 'FulfillmentDelivered'; at: string }
  // ── forced status moves (admin `updateStatus`) — one event per target, so every
  //    admin jump is a route-table edge ──
  | { type: 'OrderProcessing'; at: string }
  | { type: 'OrderPartiallyShipped'; at: string }
  | { type: 'OrderShipped'; at: string }
  | { type: 'OrderDelivered'; at: string }
  | { type: 'OrderReturnRequested'; at: string }
  | { type: 'OrderRefunded'; at: string }
  | { type: 'OrderReturned'; at: string }
  | { type: 'OrderCompleted'; at: string };

// ==================
// State copy
// ==================

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

// ==================
// Refund math (pure)
// ==================

/** Round to cents-precision to keep pro-rated tax stable across folds. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Per-line quantities already refunded on this order. */
function refundedQuantities(state: Readonly<OrderState>): Record<string, number> {
  const alreadyRefunded: Record<string, number> = {};
  for (const r of state.refunds ?? []) {
    for (const l of r.lines) {
      alreadyRefunded[l.lineItemId] = (alreadyRefunded[l.lineItemId] ?? 0) + l.quantity;
    }
  }
  return alreadyRefunded;
}

/**
 * Pure refund-selection validation, for `guard`s: the reason a selection is invalid
 * (unknown line / non-positive qty / exceeds remaining / nothing left), or undefined when
 * acceptable. With this in the guard, `decide`'s refund math never throws for a caller
 * mistake.
 */
export function refundSelectionProblem(
  state: Readonly<OrderState>,
  lines: RefundLineInput[] | undefined,
): string | undefined {
  const alreadyRefunded = refundedQuantities(state);
  if (!lines || lines.length === 0) {
    // Full refund of the remainder — invalid only when nothing remains.
    const anyRemaining = state.order.items.some(
      (item) => item.quantity - (alreadyRefunded[item.lineItemId] ?? 0) > 0,
    );
    return anyRemaining ? undefined : 'Nothing left to refund';
  }
  for (const l of lines) {
    const item = state.order.items.find((i) => i.lineItemId === l.lineItemId);
    if (!item) return `Unknown line item in refund selection: ${l.lineItemId}`;
    if (l.quantity <= 0) return `Non-positive refund quantity for ${l.lineItemId}`;
    const remaining = item.quantity - (alreadyRefunded[l.lineItemId] ?? 0);
    if (l.quantity > remaining) {
      return `Refund quantity ${l.quantity} exceeds remaining ${remaining} for ${l.lineItemId}`;
    }
  }
  return undefined;
}

/**
 * Pure refund computation (simplified from the mono's accounting-package breakdown):
 * pro-rates order tax by the refunded retail share, guards against over-refunding, and
 * reports whether every unit is now refunded. Caller mistakes are rejected by
 * {@link refundSelectionProblem} in the states' guards before this runs; a throw here is
 * a backstop, not control flow.
 */
function computeRefundRecord(
  ctx: Readonly<OrderState>,
  selections: RefundLineInput[] | undefined,
  reason: string | undefined,
  at: string,
): { record: RefundRecord; fullyRefunded: boolean } {
  const alreadyRefunded = refundedQuantities(ctx);

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

// ==================
// Intake math (pure)
// ==================

/**
 * Pure fulfiller-order construction: group assignments by fulfiller, build the
 * `FulfillerOrder` records and the `FulfillmentFulfillerOrderInput[]` payload. Reads
 * state only — the assignment updates (fulfillerOrderId + status) are folded by `evolve`
 * from the emitted event, and the child start + indexing are the `FulfillmentRequested`
 * effect. Ids are prepared (minted) per fulfiller.
 */
export function buildFulfillment(
  state: Readonly<OrderState>,
  at: string,
  fulfillerOrderIds: Record<string, string>,
): {
  fulfillerOrders: FulfillerOrder[];
  fulfillmentInputs: Fulfillment.FulfillmentFulfillerOrderInput[];
} {
  const byFulfiller: Record<string, OrderAssignment[]> = {};
  for (const a of state.assignments) {
    (byFulfiller[a.fulfillerId] ??= []).push(a);
  }

  const fulfillerOrders: FulfillerOrder[] = [];
  const fulfillmentInputs: Fulfillment.FulfillmentFulfillerOrderInput[] = [];

  for (const [fulfillerId, assignments] of Object.entries(byFulfiller)) {
    const fulfillerOrderId = fulfillerOrderIds[fulfillerId];

    fulfillerOrders.push({
      fulfillerOrderId,
      orderId: state.order.orderId,
      fulfillerId,
      fulfillerName: assignments[0].fulfillerName || fulfillerId,
      status: 'pending',
      items: assignments.map((a) => ({
        assignmentId: a.assignmentId,
        variantId: a.variantId,
        quantity: a.quantity,
      })),
      createdAt: at,
      updatedAt: at,
      statusHistory: [{ status: 'pending', timestamp: at, note: 'Fulfiller order created' }],
    });

    const items: Fulfillment.FulfillmentItem[] = assignments.map((a) => {
      // Match by the assignment's own line item — assignments are line-scoped, and
      // matching on variantId would price duplicate-variant lines from the first line.
      const orderItem = (state.order.items as OrderCartItem[]).find(
        (i) => i.lineItemId === a.lineItemId,
      );
      return {
        sku: a.sku || a.variantId,
        productId: a.variantId,
        variantId: a.variantId,
        quantity: a.quantity,
        unitPrice: orderItem?.price ?? 0,
        title: orderItem?.title || orderItem?.variantTitle || `Item ${a.variantId.slice(0, 8)}`,
      };
    });

    fulfillmentInputs.push({
      fulfillerOrderId,
      fulfillerId,
      fulfillerType: 'simulated',
      items,
    });
  }

  return { fulfillerOrders, fulfillmentInputs };
}

// ==================
// Status aggregation + forced-status mapping (pure)
// ==================

/** The machine state implied by the aggregate status of all fulfiller orders (forward-only). */
export function aggregateShippingState(
  fulfillerOrders: ReadonlyArray<Pick<FulfillerOrder, 'status'>>,
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
 * The statuses an admin `updateStatus` may force. Anything else (intake statuses,
 * typos) is rejected by the states' guard — never a throw from `decide`. (Demo
 * divergence: no `closed` — the demo has no return-window auto-close.)
 */
export const FORCEABLE_STATUSES: readonly OrderStatus[] = [
  'processing',
  'partially_shipped',
  'shipped',
  'delivered',
  'return_requested',
  'cancelled',
  'refunded',
  'returned',
  'complete',
];

/** The event a forced status move decides — null for a status the guard should have rejected. */
function forcedStatusEvent(status: OrderStatus, at: string): OrderEvent | null {
  switch (status) {
    case 'processing':
      return { type: 'OrderProcessing', at };
    case 'partially_shipped':
      return { type: 'OrderPartiallyShipped', at };
    case 'shipped':
      return { type: 'OrderShipped', at };
    case 'delivered':
      return { type: 'OrderDelivered', at };
    case 'return_requested':
      return { type: 'OrderReturnRequested', at };
    case 'cancelled':
      return { type: 'OrderCancelled', at };
    case 'refunded':
      return { type: 'OrderRefunded', at };
    case 'returned':
      return { type: 'OrderReturned', at };
    case 'complete':
      return { type: 'OrderCompleted', at };
    default:
      return null;
  }
}

// ==================
// decide
// ==================

/** Normalize an empty selection list to "the full remainder". */
function normalizeLines(lines: RefundLineInput[] | undefined): RefundLineInput[] | undefined {
  return lines && lines.length > 0 ? lines : undefined;
}

/**
 * decide(command, state) → events. Pure: emits the events implied by the command. Refund and
 * return-confirm compute the (pure) refund breakdown here; a fulfilment update for an unknown
 * fulfiller order emits nothing (stay put).
 */
export function decide(command: EnrichedOrderCommand, state: OrderState): OrderEvent[] {
  const at = command.at;
  switch (command.type) {
    // ── intake ──
    case 'capturePayment':
      // Demo: a bare hop event — payment was mock-captured at checkout; no ledger here.
      return [{ type: 'PaymentCaptured', at }];

    case 'assignFulfillers': {
      const assignments: OrderAssignment[] = [];
      for (let i = 0; i < state.order.items.length; i++) {
        const item = state.order.items[i];
        const assignment = command.resolved[i];
        if (!assignment) continue; // unresolved line — falls back to the manual path
        assignments.push({
          assignmentId: assignment.assignmentId,
          lineItemId: item.lineItemId,
          variantId: item.variantId,
          fulfillerId: assignment.fulfillerId,
          fulfillerName: assignment.fulfillerName,
          fulfillerType: assignment.fulfillerType,
          quantity: item.quantity,
          status: 'assigned',
          sku: assignment.sku,
        });
      }
      return assignments.length > 0
        ? [{ type: 'FulfillersAssigned', assignments, at }]
        : [{ type: 'NoFulfillersResolved', at }];
    }

    case 'requestFulfillment': {
      const { fulfillerOrders, fulfillmentInputs } = buildFulfillment(
        state,
        at,
        command.fulfillerOrderIds,
      );
      return [{ type: 'FulfillmentRequested', fulfillerOrders, fulfillmentInputs, at }];
    }

    // ── lifecycle ──
    case 'cancelOrder':
      return [{ type: 'OrderCancelled', at }];

    case 'updateStatus': {
      const event = forcedStatusEvent(command.status, at);
      return event ? [event] : [];
    }

    case 'submitFeedback':
      return [{ type: 'FeedbackSubmitted', rating: command.rating, comment: command.comment, at }];

    case 'refundOrder': {
      const { record, fullyRefunded } = computeRefundRecord(
        state,
        normalizeLines(command.lines),
        command.reason,
        at,
      );
      const events: OrderEvent[] = [{ type: 'Refunded', record, fullyRefunded, at }];
      // A full refund also decides the terminal move — routing keys on the event.
      if (fullyRefunded) events.push({ type: 'OrderRefunded', at });
      return events;
    }

    case 'requestReturn':
      return [
        {
          type: 'ReturnRequested',
          record: {
            lines: normalizeLines(command.lines),
            reason: command.reason,
            requestedAt: at,
            requestedBy: command.updatedBy,
          },
          at,
        },
      ];

    case 'confirmReturn': {
      const req = state.returnRequest;
      const { record } = computeRefundRecord(state, req?.lines, command.reason ?? req?.reason, at);
      return [{ type: 'ReturnConfirmed', record, at }];
    }

    case 'denyReturn':
      return [{ type: 'ReturnDenied', at }];

    case 'fulfillmentStatus': {
      const update = command.update;
      const known = state.fulfillerOrders.some(
        (so) => so.fulfillerOrderId === update.fulfillerOrderId,
      );
      if (!known) return []; // stay put; nothing happened to THIS order
      const events: OrderEvent[] = [{ type: 'FulfillmentApplied', update, at }];
      // Decide the aggregate OUTCOME by projecting the update onto the current set —
      // routing keys on these events instead of re-reading the folded status.
      const projected = state.fulfillerOrders.map((so) =>
        so.fulfillerOrderId === update.fulfillerOrderId ? { status: update.status } : so,
      );
      const aggregate = aggregateShippingState(projected);
      if (aggregate === 'delivered') events.push({ type: 'FulfillmentDelivered', at });
      else if (aggregate === 'shipped') events.push({ type: 'FulfillmentShipped', at });
      else if (aggregate === 'partially_shipped')
        events.push({ type: 'FulfillmentPartiallyShipped', at });
      return events;
    }

    default:
      return [];
  }
}

// ==================
// evolve
// ==================

/** Fold a single fulfilment-status event: apply to the fulfiller order, then aggregate. */
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
 * evolve(state, event) → state. Pure fold; the ONLY writer of order status / feedback / refunds /
 * return request / assignment / fulfiller-order state.
 */
export function evolve(state: OrderState, event: OrderEvent): OrderState {
  const draft = copyOrderState(state);
  switch (event.type) {
    // ── intake ──
    case 'PaymentCaptured':
      // Nothing folds — the demo has no ledger; this is the intake hop marker.
      return draft;

    case 'FulfillersAssigned':
      draft.assignments.push(...event.assignments.map((a) => ({ ...a })));
      return draft;

    case 'NoFulfillersResolved':
      return draft;

    case 'FulfillmentRequested': {
      draft.fulfillerOrders = event.fulfillerOrders.map((so) => ({
        ...so,
        items: so.items.map((i) => ({ ...i })),
        statusHistory: so.statusHistory.map((h) => ({ ...h })),
      }));
      for (const so of event.fulfillerOrders) {
        for (const item of so.items) {
          const assignment = draft.assignments.find((a) => a.assignmentId === item.assignmentId);
          if (assignment) {
            assignment.fulfillerOrderId = so.fulfillerOrderId;
            assignment.status = 'fulfilled';
          }
        }
      }
      draft.status = 'processing';
      return draft;
    }

    // ── lifecycle ──
    case 'OrderCancelled':
      draft.status = 'cancelled';
      return draft;

    case 'FeedbackSubmitted':
      draft.status = 'complete';
      draft.customerFeedback = {
        rating: event.rating,
        comment: event.comment,
        submittedAt: event.at,
      };
      return draft;

    case 'Refunded':
      draft.refunds = [...(draft.refunds ?? []), event.record];
      if (event.fullyRefunded) draft.status = 'refunded';
      draft.updatedAt = event.record.timestamp;
      return draft;

    case 'ReturnRequested':
      draft.returnRequest = event.record;
      return draft;

    case 'ReturnConfirmed':
      draft.refunds = [...(draft.refunds ?? []), event.record];
      draft.status = 'returned';
      draft.returnRequest = undefined;
      draft.updatedAt = event.record.timestamp;
      return draft;

    case 'ReturnDenied':
      draft.returnRequest = undefined;
      return draft;

    case 'FulfillmentApplied':
      return applyFulfillment(draft, event.update, event.at);

    // ── aggregate outcomes (FulfillmentApplied already folded the status; idempotent) ──
    case 'FulfillmentPartiallyShipped':
      draft.status = 'partially_shipped';
      return draft;
    case 'FulfillmentShipped':
      draft.status = 'shipped';
      return draft;
    case 'FulfillmentDelivered':
      draft.status = 'delivered';
      return draft;

    // ── forced status moves ──
    case 'OrderProcessing':
      draft.status = 'processing';
      return draft;
    case 'OrderPartiallyShipped':
      draft.status = 'partially_shipped';
      return draft;
    case 'OrderShipped':
      draft.status = 'shipped';
      return draft;
    case 'OrderDelivered':
      // Deliberately does NOT set `deliveredAt` — only a real fulfilment aggregate does.
      draft.status = 'delivered';
      return draft;
    case 'OrderReturnRequested':
      draft.status = 'return_requested';
      return draft;
    case 'OrderRefunded':
      draft.status = 'refunded';
      return draft;
    case 'OrderReturned':
      draft.status = 'returned';
      return draft;
    case 'OrderCompleted':
      draft.status = 'complete';
      return draft;

    default:
      return draft;
  }
}

/**
 * The assembled decider, conforming to the framework's `MachineDecider` shape (ADR-0024:
 * `isTerminal` is gone — terminality is the route tables' job; `initialState` remains as
 * the canonical empty shape for decider unit tests, never consulted at runtime).
 */
export const omsDecider: MachineDecider<EnrichedOrderCommand, OrderEvent, OrderState> = {
  decide,
  evolve,
  initialState: {
    order: undefined as unknown as OrderState['order'],
    status: 'pending_assignment',
    statusHistory: [],
    assignments: [],
    fulfillerOrders: [],
  },
};
