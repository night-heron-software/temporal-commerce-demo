/**
 * OMS states — the shell around the pure OMS Decider (aligned with nightheron-mono).
 *
 * The full order lifecycle runs through the machine: three transitional intake states
 * (pending_assignment → assigning_fulfillers → requesting_fulfillment), the shipment-
 * tracking states (processing / partially_shipped / shipped) driven by the aggregated
 * fulfillment signal, the manual ready_to_fulfill fallback, and the post-delivery
 * lifecycle (delivered → return_requested, feedback, refunds). Side effects run through
 * the `OmsFinalize` discriminated union in `omsFinalize` — the accounting (Twisp) actions
 * from the mono are intentionally absent in this demo.
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
import type { Cart, Fulfillment } from '../contracts';
import {
  sendOrderStatusEmail,
  sendFeedbackThankYouEmail,
  resolveFulfillerAssignments,
  indexFulfillerOrder,
} from './activities';
import type {
  Order,
  OrderState,
  OrderEvent,
  OrderStatus,
  OrderAssignment,
  OrderLineItem,
  FulfillerOrder,
  FulfillmentStatusUpdate,
  OrderStateName,
} from './types';
import { buildFulfillerOrderDocument } from './document-builder';
import { decide as omsDecide, evolve, copyOrderState, aggregateShippingState } from './oms-decider';
import type { OrderCommand } from './oms-decider';
import { defineDomain, terminal, SELF } from '../framework';
import type { StateRegistry, StateInput, DecisionResult, InputMeta } from '../framework';

/** Order line item shape with the optional display fields the intake logic reads. */
interface OrderCartItem extends Cart.CartItem {
  productId?: string;
  title?: string;
  variantTitle?: string;
}

const fulfillmentCancelSignal = defineSignal('cancel');

// ==================
// Domain factory — binds shared type params once
// ==================

const oms = defineDomain<
  OrderStateName,
  OrderEvent,
  OrderState,
  OrderState,
  FulfillmentStatusUpdate
>();

// ==================
// Helpers
// ==================

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

// ==================
// Finalize Types & Function
// ==================

type OmsFinalize =
  | { action: 'sendStatusEmail'; orderId: string; status: OrderStatus; email: string }
  | { action: 'cancelFulfillment'; orderId: string }
  | { action: 'cancelAndNotify'; orderId: string; email: string }
  | { action: 'sendFeedback'; orderId: string; email: string }
  | {
      action: 'startFulfillment';
      order: Order;
      customerEmail: string;
      fulfillmentInputs: Fulfillment.FulfillmentFulfillerOrderInput[];
      fulfillerOrders: FulfillerOrder[];
    }
  | { action: 'none' };

type OmsDecision = DecisionResult<OrderStateName, OrderState, OrderState, OmsFinalize>;

async function omsFinalize(_ctx: Readonly<OrderState>, decision: OmsDecision): Promise<void> {
  const fin = decision.finalize;
  if (!fin || fin.action === 'none') return;

  switch (fin.action) {
    case 'sendStatusEmail':
      await sendOrderStatusEmail(fin.email, fin.orderId, fin.status, {});
      break;
    case 'cancelFulfillment':
      await triggerFulfillmentCancel(fin.orderId);
      break;
    case 'cancelAndNotify':
      await sendOrderStatusEmail(fin.email, fin.orderId, 'cancelled', {});
      await triggerFulfillmentCancel(fin.orderId);
      break;
    case 'sendFeedback':
      await sendFeedbackThankYouEmail(fin.email, fin.orderId);
      break;
    case 'startFulfillment': {
      const order = fin.order;
      // Index the newly-created fulfiller orders so the admin sees them immediately.
      for (const so of fin.fulfillerOrders) {
        await indexFulfillerOrder(buildFulfillerOrderDocument(so));
      }
      // Price validation — warn on $0 items to catch cart manipulation.
      const zeroItems = fin.fulfillmentInputs
        .flatMap((fo) => fo.items)
        .filter((i) => i.unitPrice <= 0);
      if (zeroItems.length > 0) {
        log.warn('[OMS] Order contains items with zero or negative price', {
          orderId: order.orderId,
          zeroSkus: zeroItems.map((i) => i.sku),
        });
      }
      const fulfillmentStart = buildWorkflowStartOptions({
        storeId: DEMO_STORE_ID,
        domain: 'fulfillment',
        entityId: order.orderId,
        orderId: order.orderId,
        cartId: order.cartId,
      });
      await startChild('fulfillmentWorkflow', {
        ...fulfillmentStart,
        // Without an explicit policy, Temporal defaults to TERMINATE — if OMS closes (complete,
        // fail, cancel, or workflowExecutionTimeout expiry) before fulfillment naturally
        // finishes, it would be killed mid-flight. ABANDON lets it keep running independently;
        // it tracks its own cancellation via the fulfillment cancel signal and completes on its
        // own once its (now-fixed) fulfiller-order children do.
        parentClosePolicy: 'ABANDON',
        args: [
          {
            orderId: order.orderId,
            cartId: order.cartId,
            customerId: fin.customerEmail,
            customerEmail: fin.customerEmail,
            confirmationNumber: order.confirmationNumber,
            shippingAddress: {
              firstName: order.shippingAddress.firstName,
              lastName: order.shippingAddress.lastName,
              email: fin.customerEmail,
              phone: order.shippingAddress.phone,
              address1: order.shippingAddress.address1,
              address2: order.shippingAddress.address2,
              city: order.shippingAddress.city,
              region: order.shippingAddress.state,
              zip: order.shippingAddress.postalCode,
              country: order.shippingAddress.country,
            },
            shippingMethod: 'standard',
            fulfillerOrders: fin.fulfillmentInputs,
          } satisfies Fulfillment.FulfillmentOrderRequest,
        ],
        taskQueue: FULFILLMENT_TASK_QUEUE,
        workflowExecutionTimeout: '90 days',
      });
      break;
    }
  }
}

// ==================
// Pure Mappers
// ==================

/**
 * Maps an OrderStatus to the next machine state or terminal.
 */
function nextForStatus(status: OrderStatus): OrderStateName | `__terminal:${string}` {
  switch (status) {
    case 'processing':
      return 'processing';
    case 'partially_shipped':
      return 'partially_shipped';
    case 'shipped':
      return 'shipped';
    case 'delivered':
      return 'delivered';
    case 'return_requested':
      return 'return_requested';
    case 'cancelled':
      return terminal('cancelled');
    case 'refunded':
      return terminal('refunded');
    case 'returned':
      return terminal('returned');
    case 'complete':
      return terminal('complete');
    default:
      throw new Error(`Unexpected status in nextForStatus: ${status}`);
  }
}

/**
 * Determines the OmsFinalize action for an updateStatus event.
 * Preserves the "send status email unless already handled by cancelAndNotify" rule.
 */
function finalizeForUpdateStatus(ctx: Readonly<OrderState>, status: OrderStatus): OmsFinalize {
  if (status === 'cancelled') {
    return {
      action: 'cancelAndNotify',
      orderId: ctx.order.orderId,
      email: ctx.order.customerEmail,
    };
  }
  if (['shipped', 'delivered', 'refunded'].includes(status)) {
    return {
      action: 'sendStatusEmail',
      orderId: ctx.order.orderId,
      status,
      email: ctx.order.customerEmail,
    };
  }
  return { action: 'none' };
}

/**
 * Shell adapter — run the pure Decider (decide → evolve) to compute the next order state.
 */
function apply(ctx: Readonly<OrderState>, command: OrderCommand): OrderState {
  const state = ctx as OrderState;
  return omsDecide(command, state).reduce(evolve, state);
}

/**
 * Refund finalize: the mono posts the refund to the Twisp ledger here; the demo has no
 * accounting, so a full refund just notifies the customer.
 */
function refundFinalize(ctx: Readonly<OrderState>): OmsFinalize {
  if (ctx.status === 'refunded') {
    return {
      action: 'sendStatusEmail',
      orderId: ctx.order.orderId,
      status: 'refunded',
      email: ctx.order.customerEmail,
    };
  }
  return { action: 'none' };
}

// ==================
// Shared transition entries (reused across state maps)
// ==================

/**
 * cancelOrder transition — shared by ready_to_fulfill, processing, partially_shipped, shipped.
 */
const cancelOrderEntry = {
  decide(ctx: Readonly<OrderState>) {
    const context = apply(ctx, { type: 'cancelOrder' });
    return {
      context,
      next: terminal('cancelled'),
      response: context,
      finalize: {
        action: 'cancelAndNotify' as const,
        orderId: ctx.order.orderId,
        email: ctx.order.customerEmail,
      },
    };
  },
  finalize: omsFinalize,
};

/**
 * updateStatus transition — shared by ready_to_fulfill, processing, partially_shipped, shipped.
 */
const updateStatusEntry = {
  decide(ctx: Readonly<OrderState>, event: Extract<OrderEvent, { type: 'updateStatus' }>) {
    const context = apply(ctx, { type: 'updateStatus', status: event.status });
    return {
      context,
      next: nextForStatus(event.status),
      response: context,
      finalize: finalizeForUpdateStatus(ctx, event.status),
    };
  },
  finalize: omsFinalize,
};

// ==================
// State: pending_assignment (escape hatch — transitional, no event input)
// ==================

/**
 * Transitional initial state. (The mono posts the ORDER_CAPTURE accounting transaction
 * here; the demo has no ledger, so this is a pure hop to `assigning_fulfillers`.)
 */
const pendingAssignment = oms.state('pending_assignment', {
  decide(ctx) {
    return {
      context: ctx,
      next: 'assigning_fulfillers' as const,
      finalize: { action: 'none' as const },
    };
  },
  finalize: omsFinalize,
});

// ==================
// State: assigning_fulfillers (transitional — resolves fulfiller assignments)
// ==================

/**
 * Transitional state. `prepare` calls the fulfiller-resolution activity (impure I/O);
 * `decide` records the resulting assignments on the order. Advances to
 * `requesting_fulfillment` when at least one assignment resolved, otherwise falls back
 * to the manual `ready_to_fulfill` path.
 */
const assigningFulfillers = oms.state('assigning_fulfillers', {
  async prepare(ctx, input: StateInput<OrderEvent, FulfillmentStatusUpdate>) {
    const lineItems: OrderLineItem[] = (ctx.order.items as OrderCartItem[]).map((item) => ({
      lineItemId: item.lineItemId,
      variantId: item.variantId,
      productId: item.productId || 'unknown',
      quantity: item.quantity,
      productTitle: item.title || 'Unknown Product',
      variantTitle: item.variantTitle || 'Unknown Variant',
      unitPrice: item.price,
      currency: ctx.order.currency,
      optionLabels: [],
      productVersion: 1,
      variantVersion: 1,
      snapshotTimestamp: input.timestamp,
      thumbnailUrl: '',
    }));
    return resolveFulfillerAssignments(lineItems, { preferredFulfillers: [] });
  },
  decide(
    ctx,
    _input,
    prepared: Array<{
      fulfillerId: string;
      fulfillerName?: string;
      fulfillerType?: string;
      sku?: string;
    }>,
  ) {
    const draft = copyOrderState(ctx);
    for (let i = 0; i < ctx.order.items.length; i++) {
      const item = ctx.order.items[i];
      const assignment = prepared[i];
      if (!assignment) continue; // unresolved line — falls back to the manual path
      draft.assignments.push({
        assignmentId: `asg-${uuid4().slice(0, 8)}`,
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
    return {
      context: draft,
      next:
        draft.assignments.length > 0
          ? ('requesting_fulfillment' as const)
          : ('ready_to_fulfill' as const),
      finalize: { action: 'none' as const },
    };
  },
  finalize: omsFinalize,
});

// ==================
// State: requesting_fulfillment (transitional — starts the fulfillment child)
// ==================

/**
 * Pure half of the old imperative `triggerFulfillment`: group assignments by fulfiller,
 * build the `FulfillerOrder` records and the `FulfillmentFulfillerOrderInput[]` payload.
 * Mutates `draft.assignments` in place (fulfillerOrderId + status). The impure half —
 * `startChild('fulfillmentWorkflow')` + indexing — runs in the `startFulfillment`
 * finalize action.
 */
function buildFulfillment(
  draft: OrderState,
  timestamp: string,
): {
  fulfillerOrders: FulfillerOrder[];
  fulfillmentInputs: Fulfillment.FulfillmentFulfillerOrderInput[];
} {
  const byFulfiller: Record<string, OrderAssignment[]> = {};
  for (const a of draft.assignments) {
    (byFulfiller[a.fulfillerId] ??= []).push(a);
  }

  const fulfillerOrders: FulfillerOrder[] = [];
  const fulfillmentInputs: Fulfillment.FulfillmentFulfillerOrderInput[] = [];

  for (const [fulfillerId, assignments] of Object.entries(byFulfiller)) {
    const fulfillerOrderId = `so-${uuid4().slice(0, 8)}`;

    fulfillerOrders.push({
      fulfillerOrderId,
      orderId: draft.order.orderId,
      fulfillerId,
      fulfillerName: assignments[0].fulfillerName || fulfillerId,
      status: 'pending',
      items: assignments.map((a) => ({
        assignmentId: a.assignmentId,
        variantId: a.variantId,
        quantity: a.quantity,
      })),
      createdAt: timestamp,
      updatedAt: timestamp,
      statusHistory: [{ status: 'pending', timestamp, note: 'Fulfiller order created' }],
    });

    for (const a of assignments) {
      a.fulfillerOrderId = fulfillerOrderId;
      a.status = 'fulfilled';
    }

    const items: Fulfillment.FulfillmentItem[] = assignments.map((a) => {
      const orderItem = (draft.order.items as OrderCartItem[]).find(
        (i) => i.variantId === a.variantId,
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

const requestingFulfillment = oms.state('requesting_fulfillment', {
  decide(ctx, input: StateInput<OrderEvent, FulfillmentStatusUpdate>) {
    const draft = copyOrderState(ctx);
    const { fulfillerOrders, fulfillmentInputs } = buildFulfillment(draft, input.timestamp);
    draft.fulfillerOrders = fulfillerOrders;
    draft.status = 'processing';
    return {
      context: draft,
      next: 'processing' as const,
      finalize: {
        action: 'startFulfillment' as const,
        order: ctx.order,
        customerEmail: ctx.order.customerEmail,
        fulfillmentInputs,
        fulfillerOrders,
      },
    };
  },
  finalize: omsFinalize,
});

// ==================
// State: ready_to_fulfill (manual fallback when no assignments resolved)
// ==================

const readyToFulfill = oms.transitions(
  'ready_to_fulfill',
  {
    cancelOrder: cancelOrderEntry,
    updateStatus: updateStatusEntry,
  },
  {
    onTimeout: {
      decide(ctx) {
        return { context: ctx, next: 'ready_to_fulfill' as const, finalize: { action: 'none' } };
      },
      finalize: omsFinalize,
    },
    onSignal: {
      // Signals at ready_to_fulfill (e.g. stale fulfillment callbacks) are safe to ignore.
      decide(ctx) {
        return { context: ctx, next: 'ready_to_fulfill' as const, finalize: { action: 'none' } };
      },
      finalize: omsFinalize,
    },
  },
);

// ==================
// Unified fulfillment-status signal handler
//
// Shared by processing / partially_shipped / shipped. Applies a fulfiller-order-level
// FulfillmentStatusUpdate, then advances to the state implied by the AGGREGATE status of
// all fulfiller orders (forward-only, since fulfiller orders move pending→shipped→delivered).
// ==================

/**
 * Apply a fulfillment status update (via the pure decider) and advance to the state implied by
 * the AGGREGATE status of all fulfiller orders. An update for an unknown fulfiller order emits
 * no fact — log + stay put. Branches on the aggregate with literal `next` targets so the diagram
 * generator resolves the edges.
 */
function applyFulfillmentStatus(
  ctx: Readonly<OrderState>,
  update: FulfillmentStatusUpdate,
  meta: InputMeta,
): OmsDecision {
  const facts = omsDecide(
    { type: 'fulfillmentStatus', update, at: meta.timestamp },
    ctx as OrderState,
  );
  if (facts.length === 0) {
    log.warn('[OMS] Received fulfillment status for unknown fulfiller order', {
      fulfillerOrderId: update.fulfillerOrderId,
    });
    return { context: ctx as OrderState, next: SELF, finalize: { action: 'none' } };
  }
  const context = facts.reduce(evolve, ctx as OrderState);
  const agg = aggregateShippingState(context.fulfillerOrders);
  if (agg === 'delivered')
    return { context, next: 'delivered' as const, finalize: { action: 'none' } };
  if (agg === 'shipped') return { context, next: 'shipped' as const, finalize: { action: 'none' } };
  if (agg === 'partially_shipped')
    return { context, next: 'partially_shipped' as const, finalize: { action: 'none' } };
  return { context, next: 'processing' as const, finalize: { action: 'none' } };
}

/** Shared onSignal entry for the shipment-tracking states. */
const fulfillmentSignalEntry = {
  decide: applyFulfillmentStatus,
  finalize: omsFinalize,
};

/** Shared onTimeout no-op (stay put) for the shipment-tracking states. */
const stayPutOnTimeout = {
  decide(ctx: Readonly<OrderState>) {
    return { context: ctx, next: SELF, finalize: { action: 'none' as const } };
  },
  finalize: omsFinalize,
};

const processing = oms.transitions(
  'processing',
  {
    cancelOrder: cancelOrderEntry,
    updateStatus: updateStatusEntry,
  },
  {
    onTimeout: stayPutOnTimeout,
    onSignal: fulfillmentSignalEntry,
  },
);

const partiallyShipped = oms.transitions(
  'partially_shipped',
  {
    cancelOrder: cancelOrderEntry,
    updateStatus: updateStatusEntry,
  },
  {
    onTimeout: stayPutOnTimeout,
    onSignal: fulfillmentSignalEntry,
  },
);

const shipped = oms.transitions(
  'shipped',
  {
    cancelOrder: cancelOrderEntry,
    updateStatus: updateStatusEntry,
  },
  {
    onTimeout: stayPutOnTimeout,
    onSignal: fulfillmentSignalEntry,
  },
);

// ==================
// State: delivered — post-delivery lifecycle (feedback, refunds, returns)
// ==================

const delivered = oms.transitions(
  'delivered',
  {
    submitFeedback: {
      decide(ctx, event: Extract<OrderEvent, { type: 'submitFeedback' }>, meta) {
        const context = apply(ctx, {
          type: 'submitFeedback',
          rating: event.rating,
          comment: event.comment,
          at: meta.timestamp,
        });
        return {
          context,
          next: terminal('complete'),
          response: context,
          finalize: {
            action: 'sendFeedback' as const,
            orderId: ctx.order.orderId,
            email: ctx.order.customerEmail,
          },
        };
      },
      finalize: omsFinalize,
    },
    updateStatus: {
      decide(ctx, event: Extract<OrderEvent, { type: 'updateStatus' }>, meta) {
        // 'refunded' via the generic status update = full refund of all remaining
        // quantity. Route through the refund command so it records a refund exactly
        // (handles the case where partials came first).
        if (event.status === 'refunded') {
          const context = apply(ctx, {
            type: 'refundOrder',
            lines: undefined,
            reason: event.note,
            at: meta.timestamp,
          });
          const next =
            context.status === 'refunded' ? terminal('refunded') : ('delivered' as const);
          return { context, next, response: context, finalize: refundFinalize(context) };
        }
        const context = apply(ctx, { type: 'updateStatus', status: event.status });
        return { context, next: nextForStatus(event.status), response: context };
      },
      finalize: omsFinalize,
    },
    refundOrder: {
      decide(ctx, event: Extract<OrderEvent, { type: 'refundOrder' }>, meta) {
        // Empty/omitted selection = full refund of all remaining quantity.
        const selections = event.lines && event.lines.length > 0 ? event.lines : undefined;
        const context = apply(ctx, {
          type: 'refundOrder',
          lines: selections,
          reason: event.reason,
          at: meta.timestamp,
        });
        const next = context.status === 'refunded' ? terminal('refunded') : ('delivered' as const);
        return { context, next, response: context, finalize: refundFinalize(context) };
      },
      finalize: omsFinalize,
    },
    requestReturn: {
      decide(ctx, event: Extract<OrderEvent, { type: 'requestReturn' }>, meta) {
        const lines = event.lines && event.lines.length > 0 ? event.lines : undefined;
        const context = apply(ctx, {
          type: 'requestReturn',
          lines,
          reason: event.reason,
          updatedBy: event.updatedBy,
          at: meta.timestamp,
        });
        return { context, next: 'return_requested' as const, response: context };
      },
      finalize: omsFinalize,
    },
  },
  {
    onTimeout: {
      decide(ctx) {
        return { context: ctx, next: 'delivered' as const, finalize: { action: 'none' } };
      },
      finalize: omsFinalize,
    },
    onSignal: {
      decide(ctx) {
        return { context: ctx, next: 'delivered' as const, finalize: { action: 'none' } };
      },
      finalize: omsFinalize,
    },
  },
);

// ==================
// State: return_requested — new returns lifecycle off `delivered`
// ==================

/**
 * A return has been requested on a delivered order. `confirmReturn` issues the refund
 * (via the decider's ReturnConfirmed fact) and finishes the order as `returned`; `denyReturn`
 * clears the request and drops back to `delivered`.
 */
const returnRequested = oms.transitions(
  'return_requested',
  {
    confirmReturn: {
      decide(ctx, event: Extract<OrderEvent, { type: 'confirmReturn' }>, meta) {
        const context = apply(ctx, {
          type: 'confirmReturn',
          reason: event.reason,
          at: meta.timestamp,
        });
        return {
          context,
          next: terminal('returned'),
          response: context,
          finalize: {
            action: 'sendStatusEmail' as const,
            orderId: ctx.order.orderId,
            status: 'returned' as const,
            email: ctx.order.customerEmail,
          },
        };
      },
      finalize: omsFinalize,
    },
    denyReturn: {
      decide(ctx) {
        const context = apply(ctx, { type: 'denyReturn' });
        return { context, next: 'delivered' as const, response: context };
      },
      finalize: omsFinalize,
    },
  },
  {
    onTimeout: {
      decide(ctx) {
        return { context: ctx, next: 'return_requested' as const, finalize: { action: 'none' } };
      },
      finalize: omsFinalize,
    },
    onSignal: {
      decide(ctx) {
        return { context: ctx, next: 'return_requested' as const, finalize: { action: 'none' } };
      },
      finalize: omsFinalize,
    },
  },
);

// ==================
// State Registry
// ==================

export const OMS_STATES: StateRegistry<
  OrderStateName,
  OrderEvent,
  OrderState,
  OrderState,
  FulfillmentStatusUpdate
> = {
  pending_assignment: { ...pendingAssignment, timeout: '1 minute', transitional: true },
  assigning_fulfillers: { ...assigningFulfillers, timeout: '1 minute', transitional: true },
  requesting_fulfillment: { ...requestingFulfillment, timeout: '1 minute', transitional: true },
  ready_to_fulfill: { ...readyToFulfill, timeout: '365 days' },
  processing: { ...processing, timeout: '365 days' },
  partially_shipped: { ...partiallyShipped, timeout: '365 days' },
  shipped: { ...shipped, timeout: '365 days' },
  delivered: { ...delivered, timeout: '30 days' },
  return_requested: { ...returnRequested, timeout: '30 days' },
};
