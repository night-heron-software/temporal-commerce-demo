import * as wf from '@temporalio/workflow';
import { Fulfillment, Fulfillers } from '../contracts';
import { buildWorkflowId, DEMO_STORE_ID } from '../contracts/constants';
import { ES_INDICES } from '../contracts/elasticsearch';
import type { FulfillmentFulfillerOrderState, FulfillmentLineItemState } from './types';
import { childStatusSignal } from './definitions';
import {
  fulfillInventoryReservations,
  releaseInventoryReservations,
  getFeatureFlag,
} from './activities';

import { runStateMachine, StateMachineConfig, SignalRegistration } from '../framework';
import { buildFulfillerOrderStates } from './fulfiller-states';
import type { FulfillerOrderStateName, FulfillerOrderCommand } from './fulfiller-states';
import type { FulfillerOrderWorkflowContext } from './fulfiller-decider';

export type { FulfillerOrderWorkflowContext } from './fulfiller-decider';
export { FULFILLER_ORDER_STATES } from './fulfiller-states';
export type { FulfillerOrderStateName, FulfillerOrderCommand } from './fulfiller-states';

export interface FulfillerOrderWorkflowInput {
  orderId: string;
  cartId: string;
  customerId: string;
  customerEmail?: string;
  confirmationNumber?: string;
  shippingAddress: Fulfillment.ShippingAddress;
  shippingMethod?: 'standard' | 'express' | 'economy';
  fulfillerOrder: FulfillmentFulfillerOrderState;
}

// Signals and Queries defined locally for the child workflow
export const childFulfillerStatusSignal =
  wf.defineSignal<[Fulfillers.FulfillerStatusUpdate]>('fulfillerStatusUpdate');
export const childCancelSignal = wf.defineSignal('cancel');
export const getFulfillerOrderStateQuery =
  wf.defineQuery<FulfillmentFulfillerOrderState>('getFulfillerOrderState');

/**
 * True when a signal to the parent failed because the parent workflow no longer exists
 * (not found / already completed). This is the expected terminal race: the parent
 * fulfillment workflow completes as soon as its aggregate status reaches `delivered`,
 * which happens while this child is still delivering its FINAL status update — so the
 * child's last signal has nowhere to land on every successful delivery.
 *
 * Matched defensively on the message (the SDK surfaces it as an ApplicationFailure whose
 * message reads "Unable to signal external workflow because it was not found"; exact
 * wording may drift across SDK versions).
 */
function isParentGoneSignalError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not found|already completed/i.test(message);
}

async function notifyParent(so: FulfillmentFulfillerOrderState, orderId: string) {
  try {
    const parentWorkflowId = buildWorkflowId(DEMO_STORE_ID, 'fulfillment', orderId);
    const parentHandle = wf.getExternalWorkflowHandle(parentWorkflowId);
    await parentHandle.signal(childStatusSignal, so);
  } catch (err) {
    if (isParentGoneSignalError(err)) {
      // Expected terminal race (see isParentGoneSignalError) — info, not error.
      wf.log.info('Parent fulfillment workflow already completed — skipping child status update', {
        error: String(err),
      });
      return;
    }
    wf.log.error('Failed to notify parent workflow of child status update', { error: String(err) });
  }
}

// Fulfiller Order Workflow Implementation
export async function fulfillerOrderWorkflow(
  input: FulfillerOrderWorkflowInput,
): Promise<FulfillmentFulfillerOrderState> {
  const manualMode = await getFeatureFlag('MANUAL_FULFILLMENT');

  const context: FulfillerOrderWorkflowContext = {
    orderId: input.orderId,
    cartId: input.cartId,
    customerId: input.customerId,
    customerEmail: input.customerEmail,
    confirmationNumber: input.confirmationNumber,
    shippingAddress: input.shippingAddress,
    shippingMethod: input.shippingMethod,
    so: {
      ...input.fulfillerOrder,
      items: input.fulfillerOrder.items.map((i) => ({ ...i })),
    },
    manualMode,
  };

  wf.setHandler(getFulfillerOrderStateQuery, () => context.so);

  // ADR-0024: signals are transport — mapped to `type`-keyed COMMANDS at registration.
  const signals: SignalRegistration<FulfillerOrderCommand>[] = [
    {
      definition: childFulfillerStatusSignal,
      toSignal: (update) => ({ type: 'fulfillerStatus' as const, update }),
    },
    {
      definition: childCancelSignal,
      toSignal: () => ({ type: 'cancel' as const }),
    },
  ];

  const processingDelayMs = parseInt(
    (wf.workflowInfo().memo?.processingDelayMs as string) || '15000',
    10,
  );
  const shippingDelayMs = parseInt(
    (wf.workflowInfo().memo?.shippingDelayMs as string) || '15000',
    10,
  );
  const deliveryDelayMs = parseInt(
    (wf.workflowInfo().memo?.deliveryDelayMs as string) || '15000',
    10,
  );

  const config: StateMachineConfig<
    FulfillerOrderStateName,
    FulfillerOrderCommand,
    FulfillerOrderWorkflowContext,
    void,
    FulfillerOrderCommand
  > = {
    states: buildFulfillerOrderStates({ processingDelayMs, shippingDelayMs, deliveryDelayMs }),
    initialState: 'received',
    onContextUpdate: (newCtx) => {
      Object.assign(context, newCtx);
    },
    // Shipment indexing + customer emails are event-keyed effects in fulfiller-states.ts.
    // Notifying the parent is genuinely per-transition (it aggregates whatever changed),
    // so it stays here.
    onTransition: async (_from, _to, _event, currentCtx) => {
      await notifyParent(currentCtx.so, currentCtx.orderId);
    },
    onCancellation: async (cancelCtx) => {
      cancelCtx.so.status = 'cancelled';
      cancelCtx.so.items.forEach((i: FulfillmentLineItemState) => (i.status = 'cancelled'));
      try {
        await releaseInventoryReservations(
          cancelCtx.cartId,
          cancelCtx.so.items.map((i: FulfillmentLineItemState) => ({ variantId: i.variantId })),
        );
      } catch (e) {
        wf.log.error('Failed to release inventory on cancel', { error: String(e) });
      }
      await notifyParent(cancelCtx.so, cancelCtx.orderId);
    },
    onTerminal: async (finalCtx) => {
      if (finalCtx.so.status === 'delivered') {
        try {
          await fulfillInventoryReservations(
            finalCtx.cartId,
            finalCtx.so.items.map((i: FulfillmentLineItemState) => ({ variantId: i.variantId })),
          );
        } catch (e) {
          wf.log.error('Failed to fulfill inventory on delivery', { error: String(e) });
        }
      } else if (finalCtx.so.status === 'failed' || finalCtx.so.status === 'cancelled') {
        try {
          await releaseInventoryReservations(
            finalCtx.cartId,
            finalCtx.so.items.map((i: FulfillmentLineItemState) => ({ variantId: i.variantId })),
          );
        } catch (e) {
          wf.log.error('Failed to release inventory on terminal', { error: String(e) });
        }
      }
      await notifyParent(finalCtx.so, finalCtx.orderId);
    },
    // Shipments only: the fulfiller_orders doc is owned (and re-indexed after this child
    // closes) by the OMS workflow. Its lifecycle is stamped by buildFulfillerOrderDocument
    // the moment the SO status is terminal (OMS runs ~30 days — its close-mark is only
    // the backstop for SOs that never reached a terminal status).
    projections: {
      refs: (finalCtx) =>
        (finalCtx.so.shipments ?? []).map((s) => ({
          index: ES_INDICES.shipments,
          id: s.shipmentId,
        })),
    },
  };

  await runStateMachine<
    FulfillerOrderStateName,
    FulfillerOrderCommand,
    FulfillerOrderWorkflowContext,
    void,
    FulfillerOrderCommand
  >(config, context, [], signals);

  return context.so;
}
