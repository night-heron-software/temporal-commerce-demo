/**
 * The order machine, co-located in one file (ADR-0024 decider-native surface,
 * aligned with nightheron-mono's CommandBlock convention).
 *
 * Everything about the machine lives here, in reading order: the enriched command union
 * and the past-tense event union; the pure order helpers (refund math, intake math,
 * status aggregation); the shared guard and the evolve entries shared by several
 * commands; then ONE `CommandBlock` PER COMMAND — a single exported structure holding
 * the command's whole story, code inlined: its `guard` (pure rejection), its `prepare`
 * (the only I/O), its `decide` case, and the `evolve` entries for the events it emits;
 * then the central `decide`/`evolve`, ASSEMBLED from the blocks; and finally the machine
 * assembly: effects, the `m.state` declarations (whose commands tables reference the
 * SAME blocks), and the registry.
 *
 *   decide: (command, context) => Event[]     // what happened, as past-tense events
 *   evolve: (context, event)   => Context     // apply one event — returns a NEW context
 *
 * Scope: the FULL order lifecycle, intake included. The three intake states are
 * transitional: each timer tick synthesizes its command (`capturePayment`,
 * `assignFulfillers`, `requestFulfillment`), impure preparation (fulfiller resolution,
 * id minting) runs in the blocks' `prepare`, and the decided events route forward.
 * Every email, child start, and fulfillment cancel is an event-keyed effect — keyed by
 * the event that causes it, not by which state happened to be current. (Demo divergence:
 * the mono's accounting/ledger effects and Stripe refund saga are intentionally absent;
 * `capturePayment` decides a bare `PaymentCaptured` — the mono computes the
 * ORDER_CAPTURE ledger numbers here; the demo took mock payment at checkout.)
 *
 * Purity is structural, not conventional: every state-writing function takes a
 * `Readonly<...>` parameter and returns a NEW value built by structural sharing. Nothing
 * mutates a live context, so the old blanket deep-copy barrier (`copyOrderState`) is
 * gone entirely.
 *
 * Status routing: an admin `updateStatus` decides a per-target event (`OrderShipped`,
 * `OrderRefunded`, …) rather than a payload-routed `StatusChanged` — route tables key on
 * event TYPE, so every admin jump is a visible edge in the state diagram; unknown
 * statuses are guard-rejected, never a decide-throw. Fulfilment aggregation likewise
 * decides its OUTCOME (`FulfillmentShipped` / `FulfillmentDelivered` /
 * `FulfillmentPartiallyShipped`) instead of the shell re-inspecting the applied status.
 */
import {
  log,
  getExternalWorkflowHandle,
  uuid4,
  startChild,
  defineSignal,
} from '@temporalio/workflow';
import {
  buildWorkflowId,
  buildWorkflowStartOptions,
  DEMO_STORE_ID,
  FULFILLMENT_TASK_QUEUE,
} from '../contracts/constants';
import type { Fulfillment } from '../contracts';
import {
  sendOrderStatusEmail,
  sendFeedbackThankYouEmail,
  resolveFulfillerAssignments,
  indexFulfillerOrder,
} from './activities';
import type {
  OrderState,
  OrderStatus,
  OrderCommand,
  OrderAssignment,
  OrderLineItem,
  OrderStateName,
  FulfillmentStatusUpdate,
  FulfillerOrder,
  RefundLineInput,
  RefundRecord,
  ReturnRequestRecord,
} from './types';
import { buildFulfillerOrderDocument } from './document-builder';
import { defineMachine, terminal, SELF, reject, workflowCorrelationId } from '../framework';
import type { EffectsMap, MachineDecider, Rejection, StateRegistry } from '../framework';

// ==================
// Commands and events — the machine's whole vocabulary
// ==================

// (The former `OrderCartItem` shim is gone — `Cart.CartItem` itself now carries the
// optional display snapshot, populated at add-to-cart. Backlog #1 / remediation R1.)

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
  // ── fulfilment-aggregate outcomes (decided, so routing never re-reads applied status) ──
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

/** One member of the WIRE command union (pre-enrichment), by its `type` tag. */
type Wire<K extends OrderCommand['type']> = Extract<OrderCommand, { type: K }>;

/** One member of the ENRICHED command union (wire + prepared data + `at`), by its `type` tag. */
type Enriched<K extends EnrichedOrderCommand['type']> = Extract<EnrichedOrderCommand, { type: K }>;

/** One member of the event union, by its `type` tag. */
type Ev<K extends OrderEvent['type']> = Extract<OrderEvent, { type: K }>;

// ==================
// Refund math (pure)
// ==================

/** Round to cents-precision to keep pro-rated tax stable across applications. */
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
 * {@link refundSelectionProblem} in the blocks' guards before this runs; a throw here is
 * a backstop, not control flow.
 */
function computeRefundRecord(
  context: Readonly<OrderState>,
  selections: RefundLineInput[] | undefined,
  reason: string | undefined,
  at: string,
): { record: RefundRecord; fullyRefunded: boolean } {
  const alreadyRefunded = refundedQuantities(context);

  const remainingFor = (lineItemId: string): number => {
    const item = context.order.items.find((i) => i.lineItemId === lineItemId);
    if (!item) throw new Error(`Unknown line item in refund selection: ${lineItemId}`);
    return item.quantity - (alreadyRefunded[lineItemId] ?? 0);
  };

  // Omitted/empty selection = full refund of all remaining quantity.
  const lines =
    selections ??
    context.order.items
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
    const item = context.order.items.find((i) => i.lineItemId === l.lineItemId)!;
    refundAmount += item.price * l.quantity;
  }

  // Pro-rate order tax by the refunded retail share of the subtotal.
  const taxAmount =
    context.order.subtotal > 0
      ? round2(context.order.tax * (refundAmount / context.order.subtotal))
      : 0;

  const refundedAfter: Record<string, number> = { ...alreadyRefunded };
  for (const l of lines) {
    refundedAfter[l.lineItemId] = (refundedAfter[l.lineItemId] ?? 0) + l.quantity;
  }
  const fullyRefunded = context.order.items.every(
    (item) => (refundedAfter[item.lineItemId] ?? 0) >= item.quantity,
  );

  const record: RefundRecord = {
    refundId: `refund-${(context.refunds?.length ?? 0) + 1}`,
    timestamp: at,
    reason,
    lines: lines.map((l) => ({ lineItemId: l.lineItemId, quantity: l.quantity })),
    refundAmount: round2(refundAmount),
    taxAmount,
  };

  return { record, fullyRefunded };
}

/** Normalize an empty selection list to "the full remainder". */
function normalizeLines(lines: RefundLineInput[] | undefined): RefundLineInput[] | undefined {
  return lines && lines.length > 0 ? lines : undefined;
}

// ==================
// Intake math (pure)
// ==================

/**
 * Pure fulfiller-order construction: group assignments by fulfiller, build the
 * `FulfillerOrder` records and the `FulfillmentFulfillerOrderInput[]` payload. Reads
 * state only — the assignment updates (fulfillerOrderId + status) are applied by
 * `evolve` from the emitted event, and the child start + indexing are the
 * `FulfillmentRequested` effect. Ids are prepared (minted) per fulfiller.
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
      const orderItem = state.order.items.find((i) => i.lineItemId === a.lineItemId);
      return {
        sku: a.sku || a.variantId,
        productId: a.variantId,
        variantId: a.variantId,
        quantity: a.quantity,
        unitPrice: orderItem?.price ?? 0,
        title:
          orderItem?.productTitle || orderItem?.variantTitle || `Item ${a.variantId.slice(0, 8)}`,
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
// Status aggregation (pure)
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
 * typos) is rejected by the shared guard — never a throw from `decide`. (Demo
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

// ==================
// Shared guard + shared evolve entries — the pieces referenced by MORE THAN ONE command
// block. Everything used by exactly one command lives INLINE in that command's block
// below (the inlining rule: the block IS the code, not an index of named functions).
// ==================

/**
 * Reject an admin `updateStatus` targeting a status the machine cannot be forced into.
 * Shared by every state that lists `updateStatus` (the `delivered` state layers its
 * refund enrichment + refundability check on top of this same guard).
 */
function guardForceableStatus(
  _context: Readonly<OrderState>,
  command: { status: OrderStatus },
): Rejection | void {
  if (!FORCEABLE_STATUSES.includes(command.status)) {
    return reject(`Unexpected status in updateStatus: ${command.status}`);
  }
}

/**
 * `delivered`'s updateStatus guard: an admin 'refunded' is enriched into a real
 * `refundOrder` command, so its selection (the full remainder) must also be refundable —
 * this keeps the old "Nothing left to refund" rejection instead of a decide-throw.
 */
function guardDeliveredUpdateStatus(
  context: Readonly<OrderState>,
  command: { status: OrderStatus },
): Rejection | void {
  const forceable = guardForceableStatus(context, command);
  if (forceable) return forceable;
  if (command.status === 'refunded') {
    const problem = refundSelectionProblem(context, undefined);
    if (problem) return reject(problem);
  }
}

/** Emitted by cancelOrder and by updateStatus-to-cancelled. */
function evolveOrderCancelled(
  context: Readonly<OrderState>,
  _event: Ev<'OrderCancelled'>,
): OrderState {
  return { ...context, status: 'cancelled' };
}

/** Emitted by a fully-refunding refundOrder and by updateStatus-to-refunded. */
function evolveOrderRefunded(
  context: Readonly<OrderState>,
  _event: Ev<'OrderRefunded'>,
): OrderState {
  return { ...context, status: 'refunded' };
}

// ==================
// Command blocks — ONE exported structure per command, every field that defines the
// command in one value, with the code INLINED. The `m.state` declarations at the bottom
// reference these SAME blocks (the framework reads only `guard`/`prepare`; structural
// typing admits the extra fields), the central `decide`/`evolve` dispatchers are
// assembled from them, and tests exercise their fields directly.
// ==================

/**
 * A block's evolve — keyed by EVENT TYPE, because evolve's unit is the event, not the
 * command: one command may emit several event types, and some events are shared across
 * commands (those reference one shared evolve function instead of inlining twice). The
 * machine's single `evolve(context, event)` is assembled by merging every block's map.
 */
type EvolveMap = {
  [E in OrderEvent['type']]?: (context: Readonly<OrderState>, event: Ev<E>) => OrderState;
};

/** One command's whole story: refusal, I/O, decision, and the evolve for what it emits. */
export interface CommandBlock<K extends OrderCommand['type']> {
  guard?: (context: Readonly<OrderState>, command: Wire<K>) => Rejection | void;
  prepare?: (context: Readonly<OrderState>, command: Wire<K>) => Promise<object | void>;
  decide: (command: Enriched<K>, context: Readonly<OrderState>) => OrderEvent[];
  evolve?: EvolveMap;
}

// ==================
// Command: capturePayment — transitional intake 1/3. A pure hop — the mono decides the
// ORDER_CAPTURE ledger numbers here and posts them as the `PaymentCaptured` effect; the
// demo has no accounting, so the event carries nothing and has no effect.
// ==================

export const capturePaymentBlock: CommandBlock<'capturePayment'> = {
  decide: (command, _context) => [{ type: 'PaymentCaptured', at: command.at }],

  evolve: {
    // Nothing to apply — the demo has no ledger; this is the intake hop marker.
    PaymentCaptured: (context, _event) => context,
  },
};

// ==================
// Command: assignFulfillers — transitional intake 2/3. `prepare` resolves fulfillers
// (impure I/O) and mints assignment ids; `decide` records the assignments, positionally
// aligned to the order lines. No resolution at all decides the manual fallback.
// ==================

export const assignFulfillersBlock: CommandBlock<'assignFulfillers'> = {
  /**
   * I/O phase: resolve fulfiller assignments (impure) and mint assignment ids; `decide`
   * stays pure and only consumes the prepared, positionally-aligned resolutions. The
   * line-item display snapshot rides the CartItem from add-to-cart (backlog #1); the
   * 'Unknown Product' fallbacks remain only for pre-snapshot lines, and the order's own
   * creation instant is the stable snapshot marker.
   */
  prepare: async (context) => {
    const lineItems: OrderLineItem[] = context.order.items.map((item) => ({
      lineItemId: item.lineItemId,
      variantId: item.variantId,
      productId: item.productId || 'unknown',
      quantity: item.quantity,
      productTitle: item.productTitle || 'Unknown Product',
      variantTitle: item.variantTitle || 'Unknown Variant',
      unitPrice: item.price,
      currency: context.order.currency,
      optionLabels: item.optionLabels ?? [],
      productVersion: 1,
      variantVersion: 1,
      snapshotTimestamp: context.order.createdAt,
      thumbnailUrl: item.thumbnailUrl ?? '',
    }));
    const resolved = await resolveFulfillerAssignments(lineItems, { preferredFulfillers: [] });
    return {
      resolved: resolved.map((assignment) =>
        assignment ? { ...assignment, assignmentId: `asg-${uuid4().slice(0, 8)}` } : null,
      ),
    };
  },

  decide: (command, context) => {
    const at = command.at;
    const assignments: OrderAssignment[] = [];
    for (let i = 0; i < context.order.items.length; i++) {
      const item = context.order.items[i];
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
  },

  evolve: {
    // Aliasing the event's assignments into the context is not a live hazard: events are
    // transient per ADR-0003, never persisted or shared, and nothing mutates them.
    FulfillersAssigned: (context, event) => ({
      ...context,
      assignments: [...context.assignments, ...event.assignments],
    }),
    NoFulfillersResolved: (context, _event) => context,
  },
};

// ==================
// Command: requestFulfillment — transitional intake 3/3. `prepare` mints fulfiller-order
// ids; `decide` groups assignments into fulfiller orders (`buildFulfillment`); the child
// start + indexing are the `FulfillmentRequested` effect.
// ==================

export const requestFulfillmentBlock: CommandBlock<'requestFulfillment'> = {
  // Mint one fulfiller-order id per fulfiller, mirroring `buildFulfillment`'s
  // group-by-fulfiller; `decide` remains the source of truth for the grouping itself.
  prepare: async (context) => {
    const fulfillerOrderIds: Record<string, string> = {};
    for (const a of context.assignments) {
      fulfillerOrderIds[a.fulfillerId] ??= `so-${uuid4().slice(0, 8)}`;
    }
    return { fulfillerOrderIds };
  },

  decide: (command, context) => {
    const { fulfillerOrders, fulfillmentInputs } = buildFulfillment(
      context,
      command.at,
      command.fulfillerOrderIds,
    );
    return [{ type: 'FulfillmentRequested', fulfillerOrders, fulfillmentInputs, at: command.at }];
  },

  evolve: {
    // Install the fulfiller orders and link each covered assignment to its fulfiller
    // order — a pure rebuild: every touched assignment is a NEW object.
    FulfillmentRequested: (context, event) => {
      const fulfillerOrderIdByAssignment = new Map<string, string>();
      for (const so of event.fulfillerOrders) {
        for (const item of so.items) {
          fulfillerOrderIdByAssignment.set(item.assignmentId, so.fulfillerOrderId);
        }
      }
      return {
        ...context,
        fulfillerOrders: event.fulfillerOrders,
        assignments: context.assignments.map((assignment) => {
          const fulfillerOrderId = fulfillerOrderIdByAssignment.get(assignment.assignmentId);
          return fulfillerOrderId
            ? { ...assignment, fulfillerOrderId, status: 'fulfilled' as const }
            : assignment;
        }),
        status: 'processing',
      };
    },
  },
};

// ==================
// Command: cancelOrder — the whole story. Emits `OrderCancelled` — the same event
// updateStatus-to-cancelled emits, so both blocks reference the same shared evolve entry
// (and the machine-level effect fires for both).
// ==================

export const cancelOrderBlock: CommandBlock<'cancelOrder'> = {
  decide: (command, _context) => [{ type: 'OrderCancelled', at: command.at }],

  evolve: {
    OrderCancelled: evolveOrderCancelled, // shared with updateStatus
  },
};

// ==================
// Command: updateStatus — an admin forces a status. One event PER TARGET
// (`OrderShipped`, `OrderRefunded`, …), so route tables show every admin jump as an
// explicit edge; unknown statuses are guard-rejected, never a decide-throw. In
// `delivered`, the state's entry layers an `enrich` on this block that turns a forced
// 'refunded' into a real `refundOrder` command (so it records a refund and trues up tax
// exactly).
// ==================

export const updateStatusBlock: CommandBlock<'updateStatus'> = {
  guard: guardForceableStatus, // shared guard — referenced, not duplicated

  decide: (command, _context) => {
    const at = command.at;
    switch (command.status) {
      case 'processing':
        return [{ type: 'OrderProcessing', at }];
      case 'partially_shipped':
        return [{ type: 'OrderPartiallyShipped', at }];
      case 'shipped':
        return [{ type: 'OrderShipped', at }];
      case 'delivered':
        return [{ type: 'OrderDelivered', at }];
      case 'return_requested':
        return [{ type: 'OrderReturnRequested', at }];
      case 'cancelled':
        return [{ type: 'OrderCancelled', at }];
      case 'refunded':
        return [{ type: 'OrderRefunded', at }];
      case 'returned':
        return [{ type: 'OrderReturned', at }];
      case 'complete':
        return [{ type: 'OrderCompleted', at }];
      default:
        // A status the guard should have rejected — decide nothing, stay put.
        return [];
    }
  },

  evolve: {
    OrderProcessing: (context, _event) => ({ ...context, status: 'processing' }),
    OrderPartiallyShipped: (context, _event) => ({ ...context, status: 'partially_shipped' }),
    OrderShipped: (context, _event) => ({ ...context, status: 'shipped' }),
    // Deliberately does NOT set `deliveredAt` — only a real fulfilment aggregate does.
    OrderDelivered: (context, _event) => ({ ...context, status: 'delivered' }),
    OrderReturnRequested: (context, _event) => ({ ...context, status: 'return_requested' }),
    OrderReturned: (context, _event) => ({ ...context, status: 'returned' }),
    OrderCompleted: (context, _event) => ({ ...context, status: 'complete' }),
    OrderCancelled: evolveOrderCancelled, // shared with cancelOrder
    OrderRefunded: evolveOrderRefunded, // shared with refundOrder
  },
};

// ==================
// Command: submitFeedback — the whole story (the thank-you email is the event's effect)
// ==================

export const submitFeedbackBlock: CommandBlock<'submitFeedback'> = {
  decide: (command, _context) => [
    {
      type: 'FeedbackSubmitted',
      rating: command.rating,
      comment: command.comment,
      at: command.at,
    },
  ],

  evolve: {
    FeedbackSubmitted: (context, event) => ({
      ...context,
      status: 'complete',
      customerFeedback: {
        rating: event.rating,
        comment: event.comment,
        submittedAt: event.at,
      },
    }),
  },
};

// ==================
// Command: refundOrder — the whole story. The (pure) refund breakdown is computed in
// `decide`; the customer email is the `OrderRefunded` effect (the demo has no ledger to
// post to). A full refund additionally decides the terminal `OrderRefunded` move —
// routing keys on the event.
// ==================

export const refundOrderBlock: CommandBlock<'refundOrder'> = {
  // Selection mistakes (unknown line, non-positive qty, over-refund) are pure rejections,
  // so `decide`'s refund math never throws for a caller mistake.
  guard: (context, command) => {
    const problem = refundSelectionProblem(context, command.lines);
    if (problem) return reject(problem);
  },

  decide: (command, context) => {
    const at = command.at;
    const { record, fullyRefunded } = computeRefundRecord(
      context,
      normalizeLines(command.lines),
      command.reason,
      at,
    );
    const events: OrderEvent[] = [{ type: 'Refunded', record, fullyRefunded, at }];
    // A full refund also decides the terminal move — routing keys on the event.
    if (fullyRefunded) events.push({ type: 'OrderRefunded', at });
    return events;
  },

  evolve: {
    Refunded: (context, event) => ({
      ...context,
      refunds: [...(context.refunds ?? []), event.record],
      status: event.fullyRefunded ? 'refunded' : context.status,
      updatedAt: event.record.timestamp,
    }),
    OrderRefunded: evolveOrderRefunded, // shared with updateStatus
  },
};

// ==================
// Command: requestReturn — the whole story (records the in-flight request; the review
// happens in `return_requested`)
// ==================

export const requestReturnBlock: CommandBlock<'requestReturn'> = {
  decide: (command, _context) => [
    {
      type: 'ReturnRequested',
      record: {
        lines: normalizeLines(command.lines),
        reason: command.reason,
        requestedAt: command.at,
        requestedBy: command.updatedBy,
      },
      at: command.at,
    },
  ],

  evolve: {
    ReturnRequested: (context, event) => ({ ...context, returnRequest: event.record }),
  },
};

// ==================
// Command: confirmReturn — the whole story. Issues the refund for the requested lines
// (the decided `ReturnConfirmed` carries the record; the customer email is its effect)
// and finishes the order as `returned`.
// ==================

export const confirmReturnBlock: CommandBlock<'confirmReturn'> = {
  // Same pure validation as refundOrder, against the STORED request's lines.
  guard: (context) => {
    const problem = refundSelectionProblem(context, context.returnRequest?.lines);
    if (problem) return reject(problem);
  },

  decide: (command, context) => {
    const req = context.returnRequest;
    const { record } = computeRefundRecord(
      context,
      req?.lines,
      command.reason ?? req?.reason,
      command.at,
    );
    return [{ type: 'ReturnConfirmed', record, at: command.at }];
  },

  evolve: {
    ReturnConfirmed: (context, event) => ({
      ...context,
      refunds: [...(context.refunds ?? []), event.record],
      status: 'returned',
      returnRequest: undefined,
      updatedAt: event.record.timestamp,
    }),
  },
};

// ==================
// Command: denyReturn — the whole story (clears the request; routing drops back to
// `delivered`)
// ==================

export const denyReturnBlock: CommandBlock<'denyReturn'> = {
  decide: (command, _context) => [{ type: 'ReturnDenied', at: command.at }],

  evolve: {
    ReturnDenied: (context, _event) => ({ ...context, returnRequest: undefined }),
  },
};

// ==================
// Command: fulfillmentStatus — the child fulfillment workflow's status signal, mapped to
// a command at registration. `decide` emits the applied update AND the aggregate OUTCOME
// (projected onto the current set), so routing keys on decided events instead of
// re-reading the applied status.
// ==================

export const fulfillmentStatusBlock: CommandBlock<'fulfillmentStatus'> = {
  decide: (command, context) => {
    const at = command.at;
    const update = command.update;
    const known = context.fulfillerOrders.some(
      (so) => so.fulfillerOrderId === update.fulfillerOrderId,
    );
    if (!known) return []; // stay put; nothing happened to THIS order
    const events: OrderEvent[] = [{ type: 'FulfillmentApplied', update, at }];
    // Decide the aggregate OUTCOME by projecting the update onto the current set —
    // routing keys on these events instead of re-reading the applied status.
    const projected = context.fulfillerOrders.map((so) =>
      so.fulfillerOrderId === update.fulfillerOrderId ? { status: update.status } : so,
    );
    const aggregate = aggregateShippingState(projected);
    if (aggregate === 'delivered') events.push({ type: 'FulfillmentDelivered', at });
    else if (aggregate === 'shipped') events.push({ type: 'FulfillmentShipped', at });
    else if (aggregate === 'partially_shipped')
      events.push({ type: 'FulfillmentPartiallyShipped', at });
    return events;
  },

  evolve: {
    // Apply the update to the one fulfiller order (status, tracking, history entry),
    // cascade to its assignments, then aggregate — a pure rebuild of the old in-place
    // mutation: every touched fulfiller order, history entry, and assignment is a NEW
    // object; untouched ones are shared structurally.
    FulfillmentApplied: (context, event) => {
      const { update } = event;
      const at = event.at;
      const target = context.fulfillerOrders.find(
        (so) => so.fulfillerOrderId === update.fulfillerOrderId,
      );
      if (!target) return context;

      const fulfillerOrders = context.fulfillerOrders.map((so) => {
        if (so.fulfillerOrderId !== update.fulfillerOrderId) return so;
        const lastHistoryEntry = so.statusHistory[so.statusHistory.length - 1];
        const statusHistory =
          lastHistoryEntry && lastHistoryEntry.status === update.status
            ? [
                ...so.statusHistory.slice(0, -1),
                {
                  ...lastHistoryEntry,
                  timestamp: at,
                  ...(update.error ? { note: update.error } : {}),
                },
              ]
            : [
                ...so.statusHistory,
                {
                  status: update.status,
                  timestamp: at,
                  note: update.error || `Status updated from fulfillment workflow`,
                },
              ];
        return {
          ...so,
          status: update.status,
          updatedAt: at,
          ...(update.carrier ? { carrier: update.carrier } : {}),
          ...(update.trackingNumber ? { trackingNumber: update.trackingNumber } : {}),
          ...(update.trackingUrl ? { trackingUrl: update.trackingUrl } : {}),
          statusHistory,
        };
      });

      const coveredAssignmentIds = new Set(target.items.map((item) => item.assignmentId));
      const assignments = context.assignments.map((assignment) => {
        if (!coveredAssignmentIds.has(assignment.assignmentId)) return assignment;
        if (update.status === 'shipped') {
          return {
            ...assignment,
            status: 'shipped' as const,
            ...(update.carrier ? { carrier: update.carrier } : {}),
          };
        }
        if (update.status === 'delivered') return { ...assignment, status: 'delivered' as const };
        if (update.status === 'rejected') return { ...assignment, status: 'rejected' as const };
        return assignment;
      });

      const aggregate = aggregateShippingState(fulfillerOrders);
      return {
        ...context,
        fulfillerOrders,
        assignments,
        status: aggregate,
        ...(aggregate === 'delivered' ? { deliveredAt: at } : {}),
      };
    },

    // Aggregate outcomes (FulfillmentApplied already applied the status; idempotent).
    FulfillmentPartiallyShipped: (context, _event) => ({
      ...context,
      status: 'partially_shipped',
    }),
    FulfillmentShipped: (context, _event) => ({ ...context, status: 'shipped' }),
    FulfillmentDelivered: (context, _event) => ({ ...context, status: 'delivered' }),
  },
};

// ==================
// The central decide / evolve — dispatchers ASSEMBLED from the blocks above, conforming
// to the framework's `MachineDecider`.
// ==================

/**
 * Every command's block, keyed by command type — the machine's whole command surface.
 * The mapped type pins each key to ITS OWN block, so a mixed-up entry is a type error.
 */
const blocks: { [K in OrderCommand['type']]: CommandBlock<K> } = {
  capturePayment: capturePaymentBlock,
  assignFulfillers: assignFulfillersBlock,
  requestFulfillment: requestFulfillmentBlock,
  cancelOrder: cancelOrderBlock,
  updateStatus: updateStatusBlock,
  submitFeedback: submitFeedbackBlock,
  refundOrder: refundOrderBlock,
  requestReturn: requestReturnBlock,
  confirmReturn: confirmReturnBlock,
  denyReturn: denyReturnBlock,
  fulfillmentStatus: fulfillmentStatusBlock,
};

/** A block's decide, widened for dispatch (the `blocks` mapped type guarantees the match). */
type AnyDecide = (command: EnrichedOrderCommand, context: Readonly<OrderState>) => OrderEvent[];

/** An evolve entry, widened for dispatch (the assembled map keys guarantee the match). */
type AnyEvolveEntry = (context: Readonly<OrderState>, event: OrderEvent) => OrderState;

/**
 * Merge every block's evolve map into the machine's single event → entry table.
 * Duplicate keys must be the IDENTICAL function reference (the shared evolve functions
 * above) — two blocks inlining different code for one event throws here, at module
 * load, so shared events cannot silently diverge.
 */
function assembleEvolve(blockList: ReadonlyArray<{ evolve?: EvolveMap }>): EvolveMap {
  const merged: EvolveMap = {};
  for (const block of blockList) {
    if (!block.evolve) continue;
    for (const type of Object.keys(block.evolve) as OrderEvent['type'][]) {
      const entry = block.evolve[type];
      if (!entry) continue;
      const existing = merged[type];
      if (existing && existing !== entry) {
        throw new Error(
          `oms evolve assembly: event '${type}' has two different evolve entries — ` +
            'share one named evolve function between the blocks instead',
        );
      }
      (merged as Record<OrderEvent['type'], unknown>)[type] = entry;
    }
  }
  return merged;
}

const evolveByEvent: EvolveMap = assembleEvolve(Object.values(blocks));

/**
 * decide(command, context) → events.
 *
 * Pure: emits the events implied by the command in the current state, and nothing else.
 * It never mutates and never reads a clock or generates ids (those arrive on the
 * command). Rejection (unforceable status, invalid refund selection) lives in the
 * blocks' `guard`s; a fulfilment update for an unknown fulfiller order emits nothing
 * (stay put). This is a thin dispatcher: each command's decision code lives inline in
 * its block above.
 */
export function decide(command: EnrichedOrderCommand, context: Readonly<OrderState>): OrderEvent[] {
  return (blocks[command.type].decide as AnyDecide)(command, context);
}

/**
 * evolve(context, event) → context.
 *
 * Pure application of a single event — the ONLY writer of order status / feedback /
 * refunds / return request / assignment / fulfiller-order state — and it writes them by
 * returning a NEW value built by structural sharing. The dispatcher hands the context to
 * the emitting block's evolve entry; an event that changes nothing returns the context
 * as-is. No deep copy, no mutation anywhere (`copyOrderState` is retired).
 */
export function evolve(context: Readonly<OrderState>, event: OrderEvent): OrderState {
  const entry = evolveByEvent[event.type];
  return entry ? (entry as AnyEvolveEntry)(context, event) : context;
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

// ==================
// Effects (event-keyed reactions; failures are logged and swallowed — the decision
// is already committed, same contract as the old surface's finalize)
// ==================

const fulfillmentCancelSignal = defineSignal('cancel');

async function triggerFulfillmentCancel(orderId: string): Promise<void> {
  try {
    const fulfillmentWorkflowId = buildWorkflowId(DEMO_STORE_ID, 'fulfillment', orderId);
    const handle = getExternalWorkflowHandle(fulfillmentWorkflowId);
    await handle.signal(fulfillmentCancelSignal);
    log.info('[OMS] Sent cancel signal to fulfillment workflow');
  } catch (e) {
    log.warn('[OMS] Failed to signal fulfillment cancel (may have already completed)', {
      error: String(e),
    });
  }
}

/** Index the new fulfiller orders and start the fulfillment child. */
async function startFulfillmentEffect(
  event: Ev<'FulfillmentRequested'>,
  context: Readonly<OrderState>,
): Promise<void> {
  const order = context.order;
  // Index the newly-created fulfiller orders so the admin sees them immediately.
  for (const so of event.fulfillerOrders) {
    await indexFulfillerOrder(buildFulfillerOrderDocument(so, order.correlationId));
  }
  // Price validation — warn on $0 items to catch cart manipulation.
  const zeroItems = event.fulfillmentInputs
    .flatMap((fo) => fo.items)
    .filter((i) => i.unitPrice <= 0);
  if (zeroItems.length > 0) {
    log.warn('[OMS] Order contains items with zero or negative price', {
      orderId: order.orderId,
      zeroSkus: zeroItems.map((i) => i.sku),
    });
  }
  // Pass the journey's correlationId along: this workflow's own CorrelationId
  // Search Attribute first, the order record's copy as the fallback (ADR-0011).
  const fulfillmentStart = buildWorkflowStartOptions({
    storeId: DEMO_STORE_ID,
    domain: 'fulfillment',
    entityId: order.orderId,
    correlationId: workflowCorrelationId() ?? order.correlationId,
    orderId: order.orderId,
    cartId: order.cartId,
  });
  await startChild('fulfillmentWorkflow', {
    ...fulfillmentStart,
    // Without an explicit policy, Temporal defaults to TERMINATE — if OMS closes (complete,
    // fail, cancel, or workflowExecutionTimeout expiry) before fulfillment naturally
    // finishes, it would be killed mid-flight. ABANDON lets it keep running independently;
    // it tracks its own cancellation via the fulfillment cancel signal and completes on its
    // own once its fulfiller-order children do.
    parentClosePolicy: 'ABANDON',
    args: [
      {
        orderId: order.orderId,
        cartId: order.cartId,
        customerId: order.customerEmail,
        customerEmail: order.customerEmail,
        confirmationNumber: order.confirmationNumber,
        shippingAddress: {
          firstName: order.shippingAddress.firstName,
          lastName: order.shippingAddress.lastName,
          email: order.customerEmail,
          phone: order.shippingAddress.phone,
          address1: order.shippingAddress.address1,
          address2: order.shippingAddress.address2,
          city: order.shippingAddress.city,
          region: order.shippingAddress.state,
          zip: order.shippingAddress.postalCode,
          country: order.shippingAddress.country,
        },
        shippingMethod: 'standard',
        fulfillerOrders: event.fulfillmentInputs,
      } satisfies Fulfillment.FulfillmentOrderRequest,
    ],
    taskQueue: FULFILLMENT_TASK_QUEUE,
    workflowExecutionTimeout: '90 days',
  });
}

// ==================
// The machine (ADR-0024 decider-native surface) — binds the decider + shared type
// params once.
// ==================

const m = defineMachine<OrderStateName, OrderCommand, OrderEvent, OrderState, OrderState>({
  decider: omsDecider,
  // Every wire command answers with the post-evolve order state (the old `response: context`).
  respond: (context) => context,
  effects: {
    FulfillmentRequested: startFulfillmentEffect,
    // Machine-level: a cancel is a cancel wherever it was decided (command or forced
    // status). Note: the old surface skipped the email + fulfillment cancel when an admin
    // forced 'cancelled' from `delivered` — an inconsistency, not a behavior worth keeping
    // (same call as the mono's migration).
    OrderCancelled: async (_event, context) => {
      await sendOrderStatusEmail(
        context.order.customerEmail,
        context.order.orderId,
        'cancelled',
        {},
      );
      await triggerFulfillmentCancel(context.order.orderId);
    },
    FeedbackSubmitted: async (_event, context) => {
      await sendFeedbackThankYouEmail(context.order.customerEmail, context.order.orderId);
    },
    // Any path to fully-refunded notifies the customer (the demo has no ledger to post
    // to — mono records the refund with Stripe-first ordering here instead).
    OrderRefunded: async (_event, context) => {
      await sendOrderStatusEmail(
        context.order.customerEmail,
        context.order.orderId,
        'refunded',
        {},
      );
    },
    ReturnConfirmed: async (_event, context) => {
      await sendOrderStatusEmail(
        context.order.customerEmail,
        context.order.orderId,
        'returned',
        {},
      );
    },
  } satisfies EffectsMap<OrderEvent, OrderState>,
});

/**
 * Status emails for admin-forced moves, shared by the pre-delivery states. State-level
 * deliberately: the aggregate-driven versions of these moves (`Fulfillment*` events) send
 * nothing, and `delivered`'s own forced moves never emailed on the old surface either.
 */
const forcedStatusEmailEffects: EffectsMap<OrderEvent, OrderState> = {
  OrderShipped: async (_event, context) => {
    await sendOrderStatusEmail(context.order.customerEmail, context.order.orderId, 'shipped', {});
  },
  OrderDelivered: async (_event, context) => {
    await sendOrderStatusEmail(context.order.customerEmail, context.order.orderId, 'delivered', {});
  },
};

// ==================
// State Registry — the commands tables reference the SAME blocks the dispatchers are
// assembled from; the framework reads only their `guard`/`prepare`.
// ==================

export const OMS_STATES: StateRegistry<
  OrderStateName,
  OrderCommand,
  OrderState,
  OrderState,
  OrderCommand
> = {
  /**
   * Transitional intake 1/3: a pure hop — the mono decides the ORDER_CAPTURE ledger
   * numbers here and posts them as the `PaymentCaptured` effect; the demo has no
   * accounting, so the event carries nothing and has no effect (see `capturePaymentBlock`).
   */
  pending_assignment: m.state('pending_assignment', {
    commands: { capturePayment: capturePaymentBlock },
    route: { PaymentCaptured: 'assigning_fulfillers' },
    timeout: '1 minute',
    transitional: true,
    onTimeout: () => ({ type: 'capturePayment' }),
  }),

  /**
   * Transitional intake 2/3: `prepare` resolves fulfillers (impure I/O) and mints
   * assignment ids; `decide` records the assignments. No resolution at all falls back
   * to the manual `ready_to_fulfill` path.
   */
  assigning_fulfillers: m.state('assigning_fulfillers', {
    commands: { assignFulfillers: assignFulfillersBlock },
    route: {
      FulfillersAssigned: 'requesting_fulfillment',
      NoFulfillersResolved: 'ready_to_fulfill',
    },
    timeout: '1 minute',
    transitional: true,
    onTimeout: () => ({ type: 'assignFulfillers' }),
  }),

  /**
   * Transitional intake 3/3: `prepare` mints fulfiller-order ids; `decide` groups
   * assignments into fulfiller orders; the child start + indexing are the
   * `FulfillmentRequested` effect.
   */
  requesting_fulfillment: m.state('requesting_fulfillment', {
    commands: { requestFulfillment: requestFulfillmentBlock },
    route: { FulfillmentRequested: 'processing' },
    timeout: '1 minute',
    transitional: true,
    onTimeout: () => ({ type: 'requestFulfillment' }),
  }),

  /** No fulfiller resolved — the order waits for manual handling (admin status moves). */
  ready_to_fulfill: m.state('ready_to_fulfill', {
    commands: {
      cancelOrder: cancelOrderBlock,
      updateStatus: updateStatusBlock,
    },
    route: {
      OrderCancelled: terminal('cancelled'),
      OrderProcessing: 'processing',
      OrderPartiallyShipped: 'partially_shipped',
      OrderShipped: 'shipped',
      OrderDelivered: 'delivered',
      OrderReturnRequested: 'return_requested',
      OrderRefunded: terminal('refunded'),
      OrderReturned: terminal('returned'),
      OrderCompleted: terminal('complete'),
    },
    effects: forcedStatusEmailEffects,
    timeout: '365 days',
  }),

  processing: m.state('processing', {
    commands: {
      cancelOrder: cancelOrderBlock,
      updateStatus: updateStatusBlock,
      fulfillmentStatus: fulfillmentStatusBlock,
    },
    route: {
      FulfillmentPartiallyShipped: 'partially_shipped',
      FulfillmentShipped: 'shipped',
      FulfillmentDelivered: 'delivered',
      OrderCancelled: terminal('cancelled'),
      OrderProcessing: SELF,
      OrderPartiallyShipped: 'partially_shipped',
      OrderShipped: 'shipped',
      OrderDelivered: 'delivered',
      OrderReturnRequested: 'return_requested',
      OrderRefunded: terminal('refunded'),
      OrderReturned: terminal('returned'),
      OrderCompleted: terminal('complete'),
      '*': SELF,
    },
    effects: forcedStatusEmailEffects,
    timeout: '365 days',
  }),

  partially_shipped: m.state('partially_shipped', {
    commands: {
      cancelOrder: cancelOrderBlock,
      updateStatus: updateStatusBlock,
      fulfillmentStatus: fulfillmentStatusBlock,
    },
    route: {
      FulfillmentPartiallyShipped: SELF,
      FulfillmentShipped: 'shipped',
      FulfillmentDelivered: 'delivered',
      OrderCancelled: terminal('cancelled'),
      OrderProcessing: 'processing',
      OrderPartiallyShipped: SELF,
      OrderShipped: 'shipped',
      OrderDelivered: 'delivered',
      OrderReturnRequested: 'return_requested',
      OrderRefunded: terminal('refunded'),
      OrderReturned: terminal('returned'),
      OrderCompleted: terminal('complete'),
      '*': SELF,
    },
    effects: forcedStatusEmailEffects,
    timeout: '365 days',
  }),

  shipped: m.state('shipped', {
    commands: {
      cancelOrder: cancelOrderBlock,
      updateStatus: updateStatusBlock,
      fulfillmentStatus: fulfillmentStatusBlock,
    },
    route: {
      FulfillmentShipped: SELF,
      FulfillmentDelivered: 'delivered',
      OrderCancelled: terminal('cancelled'),
      OrderProcessing: 'processing',
      OrderPartiallyShipped: 'partially_shipped',
      OrderShipped: SELF,
      OrderDelivered: 'delivered',
      OrderReturnRequested: 'return_requested',
      OrderRefunded: terminal('refunded'),
      OrderReturned: terminal('returned'),
      OrderCompleted: terminal('complete'),
      '*': SELF,
    },
    effects: forcedStatusEmailEffects,
    timeout: '365 days',
  }),

  /**
   * Delivered — post-delivery lifecycle (feedback, refunds, returns). An admin
   * 'refunded' status is enriched into a real `refundOrder` command, so it records a
   * refund and trues up tax exactly (handles the case where partials came first).
   * Timeouts are ignored (no `onTimeout`): the demo has no return-window auto-close.
   */
  delivered: m.state('delivered', {
    commands: {
      submitFeedback: submitFeedbackBlock,
      // The updateStatus block with TWO phases replaced: this state's refundability guard
      // (demo divergence: `guardDeliveredUpdateStatus`) and an `enrich` that normalizes a
      // 'refunded' status into a real `refundOrder` command. Everything else — decide,
      // evolve — is the block's, which is what the spread says.
      //
      // Ported from mono #270 (`f0648dc0`). This was a bare `{ guard, enrich }` literal whose
      // own comment said it was "spelled as a literal so the diagram generator resolves the
      // guard" — a workaround for one generator limitation that created a worse one: emissions
      // derive from the handler's evolve map, the literal carried none, and the generated
      // diagram rendered this command as "(no events — idempotent no-op)" when it can force
      // many statuses. A bare literal is now reserved for its honest meaning — "deliberately
      // NOT the block", as cart's `beginCheckout: {}` uses it.
      //
      // Accepted imprecision: the render lists `OrderRefunded` under this command, which
      // `enrich` actually diverts to `refundOrder`. The outcome is right; only the mechanism
      // is indirect. Naming one edge by its effect beats silently omitting the rest.
      updateStatus: {
        ...updateStatusBlock,
        guard: guardDeliveredUpdateStatus,
        enrich: (command, _prepared, meta) =>
          command.status === 'refunded'
            ? { type: 'refundOrder' as const, reason: command.note, at: meta.timestamp }
            : { ...command, at: meta.timestamp },
      },
      refundOrder: refundOrderBlock,
      requestReturn: requestReturnBlock,
    },
    route: {
      FeedbackSubmitted: terminal('complete'),
      // Partial refunds stay; a full refund additionally decides `OrderRefunded`
      // (last routed event wins → terminal).
      Refunded: SELF,
      ReturnRequested: 'return_requested',
      OrderCancelled: terminal('cancelled'),
      OrderProcessing: 'processing',
      OrderPartiallyShipped: 'partially_shipped',
      OrderShipped: 'shipped',
      OrderDelivered: SELF,
      OrderReturnRequested: 'return_requested',
      OrderRefunded: terminal('refunded'),
      OrderReturned: terminal('returned'),
      OrderCompleted: terminal('complete'),
    },
    timeout: '30 days',
  }),

  /**
   * A return has been requested on a delivered order. `confirmReturn` issues the refund
   * (the decided `ReturnConfirmed` carries the record; the customer email is its effect)
   * and finishes the order as `returned`; `denyReturn` clears the request and drops back
   * to `delivered`. Timeouts are ignored — the demo has no review-SLA auto-close.
   */
  return_requested: m.state('return_requested', {
    commands: {
      confirmReturn: confirmReturnBlock,
      denyReturn: denyReturnBlock,
    },
    route: {
      ReturnConfirmed: terminal('returned'),
      ReturnDenied: 'delivered',
    },
    timeout: '30 days',
  }),
};
