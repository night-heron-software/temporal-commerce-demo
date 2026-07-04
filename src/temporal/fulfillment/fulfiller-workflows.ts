import * as wf from '@temporalio/workflow';
import { Fulfillment, Fulfillers } from '../contracts';
import { buildWorkflowId, DEMO_STORE_ID } from '../contracts/constants';
import type { FulfillmentFulfillerOrderState, FulfillmentLineItemState } from './types';
import {
  sendShippedEmail,
  sendDeliveredEmail,
  indexShipment,
  fulfillInventoryReservations,
  releaseInventoryReservations,
  getFeatureFlag,
} from './activities';

import { runStateMachine, StateMachineConfig, SignalRegistration, isTerminal } from '../framework';
import { buildFulfillerOrderStates } from './fulfiller-states';

export type FulfillerOrderStateName = 'received' | 'submitting' | 'in_production' | 'shipped';

export type FulfillerOrderSignal =
  | { kind: 'fulfillerStatus'; update: Fulfillers.FulfillerStatusUpdate }
  | { kind: 'cancel' };

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

export interface FulfillerOrderWorkflowContext {
  orderId: string;
  cartId: string;
  customerId: string;
  customerEmail?: string;
  confirmationNumber?: string;
  shippingAddress: Fulfillment.ShippingAddress;
  shippingMethod?: 'standard' | 'express' | 'economy';
  so: FulfillmentFulfillerOrderState;
  manualMode: boolean;
}

// Signals and Queries defined locally for the child workflow
export const childFulfillerStatusSignal = wf.defineSignal<[Fulfillers.FulfillerStatusUpdate]>('fulfillerStatusUpdate');
export const childCancelSignal = wf.defineSignal('cancel');
export const getFulfillerOrderStateQuery = wf.defineQuery<FulfillmentFulfillerOrderState>('getFulfillerOrderState');

async function notifyParent(
  so: FulfillmentFulfillerOrderState,
  orderId: string,
) {
  try {
    const parentWorkflowId = buildWorkflowId(DEMO_STORE_ID, 'fulfillment', orderId);
    const parentHandle = wf.getExternalWorkflowHandle(parentWorkflowId);
    await parentHandle.signal('childStatusUpdate', so);
  } catch (err) {
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

  const signals: SignalRegistration<FulfillerOrderSignal>[] = [
    {
      definition: childFulfillerStatusSignal,
      toSignal: (update: Fulfillers.FulfillerStatusUpdate) => ({ kind: 'fulfillerStatus' as const, update }),
    },
    {
      definition: childCancelSignal,
      toSignal: () => ({ kind: 'cancel' as const }),
    },
  ];

  const processingDelayMs = parseInt(
    (wf.workflowInfo().memo?.processingDelayMs as string) || "15000",
    10,
  );
  const shippingDelayMs = parseInt(
    (wf.workflowInfo().memo?.shippingDelayMs as string) || "15000",
    10,
  );
  const deliveryDelayMs = parseInt(
    (wf.workflowInfo().memo?.deliveryDelayMs as string) || "15000",
    10,
  );

  const config: StateMachineConfig<
    FulfillerOrderStateName,
    never,
    FulfillerOrderWorkflowContext,
    void,
    FulfillerOrderSignal
  > = {
    states: buildFulfillerOrderStates({ processingDelayMs, shippingDelayMs, deliveryDelayMs }),
    initialState: 'received',
    onContextUpdate: (newCtx: FulfillerOrderWorkflowContext) => {
      Object.assign(context, newCtx);
    },
    onTransition: async (from: FulfillerOrderStateName, to: FulfillerOrderStateName | `__terminal:${string}`, event: 'timeout' | 'signal', currentCtx: FulfillerOrderWorkflowContext) => {
      await notifyParent(currentCtx.so, currentCtx.orderId);

      if (to === 'shipped') {
        const trackingNumber = currentCtx.so.trackingNumber || '';
        const carrier = currentCtx.so.carrier || '';
        const trackingUrl = currentCtx.so.trackingUrl;

        if (currentCtx.so.shipments?.length) {
          const shipment = currentCtx.so.shipments[currentCtx.so.shipments.length - 1];
          await indexShipment({
            shipmentId: shipment.shipmentId,
            orderId: currentCtx.orderId,
            carrier: shipment.carrier,
            trackingNumber: shipment.trackingNumber,
            trackingUrl: shipment.trackingUrl,
            itemCount: shipment.items.length,
            shippedAt: shipment.shippedAt,
          });
        }

        if (currentCtx.customerEmail) {
          const confirmNumber = currentCtx.confirmationNumber || currentCtx.orderId;
          await sendShippedEmail(currentCtx.customerEmail, currentCtx.orderId, confirmNumber, {
            carrier,
            trackingNumber,
            trackingUrl,
          });
        }
      } else if (isTerminal(to, 'delivered')) {
        if (currentCtx.customerEmail) {
          const confirmNumber = currentCtx.confirmationNumber || currentCtx.orderId;
          await sendDeliveredEmail(currentCtx.customerEmail, currentCtx.orderId, confirmNumber);
        }
      }
    },
    onCancellation: async (cancelCtx: FulfillerOrderWorkflowContext) => {
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
    onTerminal: async (finalCtx: FulfillerOrderWorkflowContext) => {
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
  };

  await runStateMachine<
    FulfillerOrderStateName,
    never,
    FulfillerOrderWorkflowContext,
    void,
    FulfillerOrderSignal
  >(config, context, [], signals);

  return context.so;
}
