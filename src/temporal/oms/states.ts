/**
 * OMS states — the shell around the pure OMS Decider (ADR-0024 decider-native surface,
 * aligned with nightheron-mono).
 *
 * The full order lifecycle — intake included — is decided as events. The three intake
 * states are transitional: each timer tick synthesizes its command (`capturePayment`,
 * `assignFulfillers`, `requestFulfillment`), impure preparation (fulfiller resolution,
 * id minting) runs in `prepare`, and the decided events route forward. Every email,
 * child start, and fulfillment cancel is an event-keyed effect — keyed by the event
 * that causes it, not by which state happened to be current. (Demo divergence: the
 * mono's accounting/ledger effects and Stripe refund saga are intentionally absent.)
 *
 * Admin `updateStatus` decides one event PER TARGET (`OrderShipped`, `OrderRefunded`, …),
 * so the route tables below show every admin jump as an explicit edge; unknown statuses
 * are guard-rejected, replacing the old `nextForStatus` decide-throw.
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
import type { OrderState, OrderStatus, OrderCommand, OrderLineItem, OrderStateName } from './types';
import { buildFulfillerOrderDocument } from './document-builder';
import { omsDecider, refundSelectionProblem, FORCEABLE_STATUSES } from './oms-decider';
import type { OrderCartItem, OrderEvent, ResolvedAssignment } from './oms-decider';
import { defineMachine, terminal, SELF, reject, workflowCorrelationId } from '../framework';
import type { EffectsMap, StateRegistry } from '../framework';

const fulfillmentCancelSignal = defineSignal('cancel');

// ==================
// Guards (pure rejection — the decider's `decide` is total for these commands)
// ==================

function guardForceableStatus(
  _ctx: Readonly<OrderState>,
  command: { status: OrderStatus },
): ReturnType<typeof reject> | void {
  if (!FORCEABLE_STATUSES.includes(command.status)) {
    return reject(`Unexpected status in updateStatus: ${command.status}`);
  }
}

function guardRefundSelections(
  ctx: Readonly<OrderState>,
  command: { lines?: { lineItemId: string; quantity: number }[] },
): ReturnType<typeof reject> | void {
  const problem = refundSelectionProblem(ctx, command.lines);
  if (problem) return reject(problem);
}

function guardConfirmReturnSelections(ctx: Readonly<OrderState>): ReturnType<typeof reject> | void {
  const problem = refundSelectionProblem(ctx, ctx.returnRequest?.lines);
  if (problem) return reject(problem);
}

/**
 * `delivered`'s updateStatus guard: an admin 'refunded' is enriched into a real
 * `refundOrder` command, so its selection (the full remainder) must also be refundable —
 * this keeps the old "Nothing left to refund" rejection instead of a decide-throw.
 */
function guardDeliveredUpdateStatus(
  ctx: Readonly<OrderState>,
  command: { status: OrderStatus },
): ReturnType<typeof reject> | void {
  const forceable = guardForceableStatus(ctx, command);
  if (forceable) return forceable;
  if (command.status === 'refunded') {
    const problem = refundSelectionProblem(ctx, undefined);
    if (problem) return reject(problem);
  }
}

// ==================
// Effects (event-keyed reactions; failures are logged and swallowed — the decision
// is already committed, same contract as the old surface's finalize)
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

/** Index the new fulfiller orders and start the fulfillment child. */
async function startFulfillmentEffect(
  event: Extract<OrderEvent, { type: 'FulfillmentRequested' }>,
  ctx: Readonly<OrderState>,
): Promise<void> {
  const order = ctx.order;
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
// Domain factory — binds the decider + shared type params once
// ==================

const m = defineMachine<OrderStateName, OrderCommand, OrderEvent, OrderState, OrderState>({
  decider: omsDecider,
  // Every wire command answers with the post-fold order state (the old `response: context`).
  respond: (ctx) => ctx,
  effects: {
    FulfillmentRequested: startFulfillmentEffect,
    // Machine-level: a cancel is a cancel wherever it was decided (command or forced
    // status). Note: the old surface skipped the email + fulfillment cancel when an admin
    // forced 'cancelled' from `delivered` — an inconsistency, not a behavior worth keeping
    // (same call as the mono's migration).
    OrderCancelled: async (_event, ctx) => {
      await sendOrderStatusEmail(ctx.order.customerEmail, ctx.order.orderId, 'cancelled', {});
      await triggerFulfillmentCancel(ctx.order.orderId);
    },
    FeedbackSubmitted: async (_event, ctx) => {
      await sendFeedbackThankYouEmail(ctx.order.customerEmail, ctx.order.orderId);
    },
    // Any path to fully-refunded notifies the customer (the demo has no ledger to post
    // to — mono records the refund with Stripe-first ordering here instead).
    OrderRefunded: async (_event, ctx) => {
      await sendOrderStatusEmail(ctx.order.customerEmail, ctx.order.orderId, 'refunded', {});
    },
    ReturnConfirmed: async (_event, ctx) => {
      await sendOrderStatusEmail(ctx.order.customerEmail, ctx.order.orderId, 'returned', {});
    },
  } satisfies EffectsMap<OrderEvent, OrderState>,
});

/**
 * Status emails for admin-forced moves, shared by the pre-delivery states. State-level
 * deliberately: the aggregate-driven versions of these moves (`Fulfillment*` events) send
 * nothing, and `delivered`'s own forced moves never emailed on the old surface either.
 */
const forcedStatusEmailEffects: EffectsMap<OrderEvent, OrderState> = {
  OrderShipped: async (_event, ctx) => {
    await sendOrderStatusEmail(ctx.order.customerEmail, ctx.order.orderId, 'shipped', {});
  },
  OrderDelivered: async (_event, ctx) => {
    await sendOrderStatusEmail(ctx.order.customerEmail, ctx.order.orderId, 'delivered', {});
  },
};

// ==================
// Intake prepares (the impure phase — activity calls and id minting)
// ==================

/**
 * Resolve fulfiller assignments (impure I/O) and mint assignment ids; `decide` stays pure
 * and only consumes the prepared, positionally-aligned resolutions. The line-item
 * snapshot uses display-field fallbacks (order items are bare CartItems in the demo) and
 * the order's own creation instant as its stable snapshot marker.
 */
async function prepareAssignFulfillers(
  ctx: Readonly<OrderState>,
): Promise<{ resolved: ResolvedAssignment[] }> {
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
    snapshotTimestamp: ctx.order.createdAt,
    thumbnailUrl: '',
  }));
  const resolved = await resolveFulfillerAssignments(lineItems, { preferredFulfillers: [] });
  return {
    resolved: resolved.map((assignment) =>
      assignment ? { ...assignment, assignmentId: `asg-${uuid4().slice(0, 8)}` } : null,
    ),
  };
}

/**
 * Mint one fulfiller-order id per fulfiller, mirroring `buildFulfillment`'s
 * group-by-fulfiller; `decide` remains the source of truth for the grouping itself.
 */
async function prepareFulfillerOrderIds(
  ctx: Readonly<OrderState>,
): Promise<{ fulfillerOrderIds: Record<string, string> }> {
  const fulfillerOrderIds: Record<string, string> = {};
  for (const a of ctx.assignments) {
    fulfillerOrderIds[a.fulfillerId] ??= `so-${uuid4().slice(0, 8)}`;
  }
  return { fulfillerOrderIds };
}

// ==================
// State Registry
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
   * accounting, so the event carries nothing and has no effect.
   */
  pending_assignment: m.state('pending_assignment', {
    commands: { capturePayment: {} },
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
    commands: { assignFulfillers: { prepare: prepareAssignFulfillers } },
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
    commands: { requestFulfillment: { prepare: prepareFulfillerOrderIds } },
    route: { FulfillmentRequested: 'processing' },
    timeout: '1 minute',
    transitional: true,
    onTimeout: () => ({ type: 'requestFulfillment' }),
  }),

  /** No fulfiller resolved — the order waits for manual handling (admin status moves). */
  ready_to_fulfill: m.state('ready_to_fulfill', {
    commands: {
      cancelOrder: {},
      updateStatus: { guard: guardForceableStatus },
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
      cancelOrder: {},
      updateStatus: { guard: guardForceableStatus },
      fulfillmentStatus: {},
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
      cancelOrder: {},
      updateStatus: { guard: guardForceableStatus },
      fulfillmentStatus: {},
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
      cancelOrder: {},
      updateStatus: { guard: guardForceableStatus },
      fulfillmentStatus: {},
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
      submitFeedback: {},
      updateStatus: {
        guard: guardDeliveredUpdateStatus,
        enrich: (command, _prepared, meta) =>
          command.status === 'refunded'
            ? { type: 'refundOrder' as const, reason: command.note, at: meta.timestamp }
            : { ...command, at: meta.timestamp },
      },
      refundOrder: { guard: guardRefundSelections },
      requestReturn: {},
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
      confirmReturn: { guard: guardConfirmReturnSelections },
      denyReturn: {},
    },
    route: {
      ReturnConfirmed: terminal('returned'),
      ReturnDenied: 'delivered',
    },
    timeout: '30 days',
  }),
};
