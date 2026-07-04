/**
 * OMS states — the shell around the pure OMS Decider (prepare → decide → finalize).
 *
 * The order workflow has a single waiting state, `processing`: the startup pipeline
 * (persist, index, auto-assign, trigger fulfillment) runs in the workflow's onStart hook,
 * and terminal routing (delivered / complete / cancelled / refunded) happens here from the
 * decider's facts. All persistence and email side effects run in per-event `finalize`
 * handlers against the post-decision state.
 */
import { log, getExternalWorkflowHandle, defineSignal } from '@temporalio/workflow';
import {
  updateOrderInDatabase,
  sendOrderStatusEmail,
  sendFeedbackThankYouEmail,
  insertStatusHistoryEntry,
} from './activities';
import type {
  OrderEvent,
  OrderState,
  OrderStatus,
  OmsStateName,
  OmsWorkflowContext,
  FulfillmentStatusUpdate,
  StatusHistoryEntry,
} from './types';
import { decide as omsDecide, evolve } from './oms-decider';
import type { OmsCommand, OmsFact } from './oms-decider';
import { defineDomain, terminal, SELF } from '../framework';
import type { StateRegistry } from '../framework';
import { buildWorkflowId, DEMO_STORE_ID } from '../contracts/constants';

const fulfillmentCancelSignal = defineSignal('cancel');

const oms = defineDomain<
  OmsStateName,
  OrderEvent,
  OmsWorkflowContext,
  OrderState,
  FulfillmentStatusUpdate
>();

/** Shell adapter — run the pure Decider and keep the emitted facts for finalize. */
function applyWithFacts(
  ctx: Readonly<OmsWorkflowContext>,
  command: OmsCommand,
): { context: OmsWorkflowContext; facts: OmsFact[] } {
  const facts = omsDecide(command, ctx.state);
  const state = facts.reduce(evolve, ctx.state);
  return { context: { ...ctx, state }, facts };
}

/** History entries produced by a decision's StatusChanged facts (for the audit table). */
function historyEntries(facts: OmsFact[]): StatusHistoryEntry[] {
  return facts
    .filter((f): f is Extract<OmsFact, { type: 'StatusChanged' }> => f.type === 'StatusChanged')
    .map((f) => ({ status: f.status, timestamp: f.at, note: f.note, updatedBy: f.updatedBy }));
}

/** Signal the standalone fulfillment workflow to cancel (it releases inventory). */
async function signalFulfillmentCancel(orderId: string): Promise<void> {
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

interface StatusFinalize {
  entries: StatusHistoryEntry[];
  sendEmailStatus?: OrderStatus;
  cancelFulfillment?: boolean;
}

/** Route an admin/customer status change to its terminal (or stay processing). */
function routeForStatus(status: string): OmsStateName | `__terminal:${string}` | typeof SELF {
  if (status === 'delivered') return terminal('delivered');
  if (status === 'complete') return terminal('complete');
  if (status === 'cancelled') return terminal('cancelled');
  if (status === 'refunded') return terminal('refunded');
  return SELF;
}

const SIGNIFICANT_EMAIL_STATUSES: OrderStatus[] = ['shipped', 'delivered', 'cancelled', 'refunded'];

const processing = oms.transitions(
  'processing',
  {
    updateStatus: {
      decide(ctx, event, meta) {
        log.info('[OMS] updateStatusUpdate received', {
          newStatus: event.status,
          note: event.note,
          updatedBy: event.updatedBy,
        });
        const { context, facts } = applyWithFacts(ctx, {
          type: 'statusUpdated',
          status: event.status,
          note: event.note,
          updatedBy: event.updatedBy,
          at: meta.timestamp,
        });
        const finalize: StatusFinalize = {
          entries: historyEntries(facts),
          sendEmailStatus: SIGNIFICANT_EMAIL_STATUSES.includes(event.status)
            ? event.status
            : undefined,
          cancelFulfillment: event.status === 'cancelled' || event.status === 'refunded',
        };
        return { context, next: routeForStatus(event.status), response: context.state, finalize };
      },
      async finalize(ctx, decision: { context: OmsWorkflowContext; finalize?: StatusFinalize }) {
        const f = decision.finalize;
        if (!f) return;
        const { state, customerEmail } = decision.context;
        for (const entry of f.entries) {
          await insertStatusHistoryEntry(state.order.orderId, entry);
        }
        await updateOrderInDatabase(state.order.orderId, {
          status: state.status,
          statusHistory: state.statusHistory,
        });
        if (f.sendEmailStatus) {
          await sendOrderStatusEmail(customerEmail, state.order.orderId, f.sendEmailStatus, {});
        }
        if (f.cancelFulfillment) {
          await signalFulfillmentCancel(state.order.orderId);
        }
      },
    },

    cancelOrder: {
      decide(ctx, event, meta) {
        log.info('[OMS] cancelOrderUpdate received', { reason: event.reason });
        const { context, facts } = applyWithFacts(ctx, {
          type: 'orderCancelled',
          reason: event.reason,
          at: meta.timestamp,
        });
        const finalize: StatusFinalize = {
          entries: historyEntries(facts),
          sendEmailStatus: 'cancelled',
          cancelFulfillment: true,
        };
        return { context, next: terminal('cancelled'), response: context.state, finalize };
      },
      async finalize(ctx, decision: { context: OmsWorkflowContext; finalize?: StatusFinalize }) {
        const f = decision.finalize;
        if (!f) return;
        const { state, customerEmail } = decision.context;
        for (const entry of f.entries) {
          await insertStatusHistoryEntry(state.order.orderId, entry);
        }
        await updateOrderInDatabase(state.order.orderId, {
          status: state.status,
          statusHistory: state.statusHistory,
        });
        await sendOrderStatusEmail(customerEmail, state.order.orderId, 'cancelled', {});
        await signalFulfillmentCancel(state.order.orderId);
      },
    },

    submitFeedback: {
      decide(ctx, event, meta) {
        const { context, facts } = applyWithFacts(ctx, {
          type: 'feedbackSubmitted',
          rating: event.rating,
          comment: event.comment,
          at: meta.timestamp,
        });
        const finalize: StatusFinalize = { entries: historyEntries(facts) };
        return { context, next: terminal('complete'), response: context.state, finalize };
      },
      async finalize(ctx, decision: { context: OmsWorkflowContext; finalize?: StatusFinalize }) {
        const f = decision.finalize;
        if (!f) return;
        const { state, customerEmail } = decision.context;
        await updateOrderInDatabase(state.order.orderId, {
          customerFeedback: state.customerFeedback,
        });
        await sendFeedbackThankYouEmail(customerEmail, state.order.orderId);
        for (const entry of f.entries) {
          await insertStatusHistoryEntry(state.order.orderId, entry);
        }
      },
    },
  },
  {
    onTimeout: {
      decide(ctx) {
        return { context: ctx as OmsWorkflowContext, next: 'processing' as const };
      },
    },
    onSignal: {
      decide(ctx, update, meta) {
        log.info('[OMS] Received fulfillment status signal', {
          fulfillerOrderId: update.fulfillerOrderId,
          status: update.status,
          carrier: update.carrier,
          trackingNumber: update.trackingNumber,
        });
        const { context, facts } = applyWithFacts(ctx, {
          type: 'fulfillmentStatusReported',
          update,
          at: meta.timestamp,
        });
        if (facts.length === 0) {
          log.warn('[OMS] Received fulfillment status for unknown fulfiller order', {
            fulfillerOrderId: update.fulfillerOrderId,
          });
          return { context, next: 'processing' as const };
        }
        const delivered = facts.some(
          (f) => f.type === 'StatusChanged' && f.status === 'delivered',
        );
        const finalize: StatusFinalize = { entries: historyEntries(facts) };
        return {
          context,
          next: delivered ? terminal('delivered') : ('processing' as const),
          finalize,
        };
      },
      async finalize(ctx, decision: { context: OmsWorkflowContext; finalize?: StatusFinalize }) {
        const f = decision.finalize;
        if (!f) return;
        const { state } = decision.context;
        for (const entry of f.entries) {
          await insertStatusHistoryEntry(state.order.orderId, entry);
        }
        await updateOrderInDatabase(state.order.orderId, {
          status: state.status,
          statusHistory: state.statusHistory,
          assignments: state.assignments,
          fulfillerOrders: state.fulfillerOrders,
        });
      },
    },
  },
);

export const OMS_STATES: StateRegistry<
  OmsStateName,
  OrderEvent,
  OmsWorkflowContext,
  OrderState,
  FulfillmentStatusUpdate
> = {
  processing: { ...processing, timeout: '365 days' },
};
