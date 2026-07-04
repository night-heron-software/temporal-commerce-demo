import * as wf from '@temporalio/workflow';
import { Fulfillment, Suppliers } from '../contracts';
import { buildWorkflowId, DEMO_STORE_ID } from '../contracts/constants';
import type { FulfillmentSupplierOrderState, FulfillmentLineItemState } from './types';
import {
  sendShippedEmail,
  sendDeliveredEmail,
  indexShipment,
  fulfillInventoryReservations,
  releaseInventoryReservations,
  getFeatureFlag,
} from './activities';

import { runStateMachine, StateMachineConfig, SignalRegistration, isTerminal } from '../framework';
import { buildSupplierOrderStates } from './supplier-states';

export type SupplierOrderStateName = 'received' | 'submitting' | 'in_production' | 'shipped';

export type SupplierOrderSignal =
  | { kind: 'supplierStatus'; update: Suppliers.SupplierStatusUpdate }
  | { kind: 'cancel' };

export interface SupplierOrderWorkflowInput {
  orderId: string;
  cartId: string;
  customerId: string;
  customerEmail?: string;
  confirmationNumber?: string;
  shippingAddress: Fulfillment.ShippingAddress;
  shippingMethod?: 'standard' | 'express' | 'economy';
  supplierOrder: FulfillmentSupplierOrderState;
}

export interface SupplierOrderWorkflowContext {
  orderId: string;
  cartId: string;
  customerId: string;
  customerEmail?: string;
  confirmationNumber?: string;
  shippingAddress: Fulfillment.ShippingAddress;
  shippingMethod?: 'standard' | 'express' | 'economy';
  so: FulfillmentSupplierOrderState;
  manualMode: boolean;
}

// Signals and Queries defined locally for the child workflow
export const childSupplierStatusSignal = wf.defineSignal<[Suppliers.SupplierStatusUpdate]>('supplierStatusUpdate');
export const childCancelSignal = wf.defineSignal('cancel');
export const getSupplierOrderStateQuery = wf.defineQuery<FulfillmentSupplierOrderState>('getSupplierOrderState');

async function notifyParent(
  so: FulfillmentSupplierOrderState,
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

// Supplier Order Workflow Implementation
export async function supplierOrderWorkflow(
  input: SupplierOrderWorkflowInput,
): Promise<FulfillmentSupplierOrderState> {
  const manualMode = await getFeatureFlag('MANUAL_FULFILLMENT');

  const context: SupplierOrderWorkflowContext = {
    orderId: input.orderId,
    cartId: input.cartId,
    customerId: input.customerId,
    customerEmail: input.customerEmail,
    confirmationNumber: input.confirmationNumber,
    shippingAddress: input.shippingAddress,
    shippingMethod: input.shippingMethod,
    so: {
      ...input.supplierOrder,
      items: input.supplierOrder.items.map((i) => ({ ...i })),
    },
    manualMode,
  };

  wf.setHandler(getSupplierOrderStateQuery, () => context.so);

  const signals: SignalRegistration<SupplierOrderSignal>[] = [
    {
      definition: childSupplierStatusSignal,
      toSignal: (update: Suppliers.SupplierStatusUpdate) => ({ kind: 'supplierStatus' as const, update }),
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
    SupplierOrderStateName,
    never,
    SupplierOrderWorkflowContext,
    void,
    SupplierOrderSignal
  > = {
    states: buildSupplierOrderStates({ processingDelayMs, shippingDelayMs, deliveryDelayMs }),
    initialState: 'received',
    onContextUpdate: (newCtx: SupplierOrderWorkflowContext) => {
      Object.assign(context, newCtx);
    },
    onTransition: async (from: SupplierOrderStateName, to: SupplierOrderStateName | `__terminal:${string}`, event: 'timeout' | 'signal', currentCtx: SupplierOrderWorkflowContext) => {
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
    onCancellation: async (cancelCtx: SupplierOrderWorkflowContext) => {
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
    onTerminal: async (finalCtx: SupplierOrderWorkflowContext) => {
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
    SupplierOrderStateName,
    never,
    SupplierOrderWorkflowContext,
    void,
    SupplierOrderSignal
  >(config, context, [], signals);

  return context.so;
}
