import * as wf from '@temporalio/workflow';
import { Fulfillment, Suppliers } from '../contracts';
import type {
  FulfillmentSupplierOrderState,
  FulfillmentLineItemState,
  ShipmentInfo,
  SupplierStatusUpdate,
} from './types';
import {
  submitSupplierOrder,
  sendShippedEmail,
  sendDeliveredEmail,
  indexShipment,
  fulfillInventoryReservations,
  releaseInventoryReservations,
  getFeatureFlag,
} from './activities';

import {
  runStateMachine,
  StateMachineConfig,
  SignalRegistration,
  StateInput,
  StateOutput,
} from '../framework';

type SupplierOrderStateName =
  | 'received'
  | 'submitting'
  | 'in_production'
  | 'shipped';

type SupplierOrderSignal =
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
    const parentWorkflowId = `fulfillment-${orderId}`;
    const parentHandle = wf.getExternalWorkflowHandle(parentWorkflowId);
    await parentHandle.signal('childStatusUpdate', so);
  } catch (err) {
    wf.log.error('Failed to notify parent workflow of child status update', { error: String(err) });
  }
}

// Helper to apply status updates and handle side effects (shipment index, etc.)
export async function applySupplierUpdate(
  ctx: SupplierOrderWorkflowContext,
  update: Suppliers.SupplierStatusUpdate,
): Promise<SupplierOrderWorkflowContext> {
  const draft = {
    ...ctx,
    so: {
      ...ctx.so,
      items: ctx.so.items.map((i) => ({ ...i })),
      shipments: ctx.so.shipments ? ctx.so.shipments.map((s) => ({ ...s })) : undefined,
    },
  };
  const so = draft.so;

  switch (update.status) {
    case 'in_production':
      so.status = 'in_production';
      so.items.forEach((i) => (i.status = 'in_production'));
      break;

    case 'partially_shipped':
      so.status = 'partially_shipped';
      if (update.lineItems) {
        for (const updateItem of update.lineItems) {
          const stateItem = so.items.find(
            (i) =>
              i.sku === updateItem.supplierLineItemId ||
              i.supplierLineItemId === updateItem.supplierLineItemId,
          );
          if (stateItem && updateItem.status === 'shipped') {
            stateItem.status = 'shipped';
          }
        }
      }
      if (update.shipmentInfo) {
        const shipment: ShipmentInfo = {
          shipmentId: `${so.supplierOrderId}-${(so.shipments?.length ?? 0) + 1}`,
          carrier: update.shipmentInfo.carrier,
          trackingNumber: update.shipmentInfo.trackingNumber,
          trackingUrl: update.shipmentInfo.trackingUrl,
          items: update.shipmentInfo.items,
          shippedAt: update.timestamp,
        };
        so.shipments = [...(so.shipments ?? []), shipment];
        so.carrier = shipment.carrier;
        so.trackingNumber = shipment.trackingNumber;
        so.trackingUrl = shipment.trackingUrl;

        await indexShipment({
          shipmentId: shipment.shipmentId,
          orderId: so.supplierOrderId,
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          trackingUrl: shipment.trackingUrl,
          itemCount: shipment.items.length,
          shippedAt: shipment.shippedAt,
          deliveredAt: shipment.deliveredAt,
        });
      }
      break;

    case 'shipped':
      so.status = 'shipped';
      so.shippedAt = update.timestamp;
      so.items.forEach((i) => (i.status = 'shipped'));
      if (update.shipmentInfo) {
        const shipment: ShipmentInfo = {
          shipmentId: `${so.supplierOrderId}-${(so.shipments?.length ?? 0) + 1}`,
          carrier: update.shipmentInfo.carrier,
          trackingNumber: update.shipmentInfo.trackingNumber,
          trackingUrl: update.shipmentInfo.trackingUrl,
          items: update.shipmentInfo.items,
          shippedAt: update.timestamp,
        };
        so.shipments = [...(so.shipments ?? []), shipment];
        so.carrier = shipment.carrier;
        so.trackingNumber = shipment.trackingNumber;
        so.trackingUrl = shipment.trackingUrl;

        await indexShipment({
          shipmentId: shipment.shipmentId,
          orderId: so.supplierOrderId,
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          trackingUrl: shipment.trackingUrl,
          itemCount: shipment.items.length,
          shippedAt: shipment.shippedAt,
          deliveredAt: shipment.deliveredAt,
        });
      }
      break;

    case 'delivered':
      so.status = 'delivered';
      so.completedAt = update.timestamp;
      so.items.forEach((i) => (i.status = 'delivered'));
      if (so.shipments?.length) {
        so.shipments[so.shipments.length - 1].deliveredAt = update.timestamp;
      }
      break;

    case 'cancelled':
      so.status = 'cancelled';
      so.items.forEach((i) => (i.status = 'cancelled'));
      break;

    case 'failed':
      so.status = 'failed';
      so.items.forEach((i) => (i.status = 'failed'));
      break;
  }

  return draft;
}

// State Machine Functions
async function receivedState(
  ctx: Readonly<SupplierOrderWorkflowContext>,
): Promise<StateOutput<SupplierOrderStateName, SupplierOrderWorkflowContext, void>> {
  const draft = { ...ctx };
  draft.so.status = 'submitting';
  return { context: draft, next: 'submitting' as const };
}

async function submittingState(
  ctx: Readonly<SupplierOrderWorkflowContext>,
): Promise<StateOutput<SupplierOrderStateName, SupplierOrderWorkflowContext, void>> {
  const result = await submitSupplierOrder({
    fulfillmentId: wf.workflowInfo().workflowId,
    supplierType: 'simulated',
    items: ctx.so.items.map((item) => ({
      sku: item.sku,
      productId: item.productId,
      quantity: item.quantity,
      supplierProductId: 'simulated',
      supplierVariantId: 0,
    })),
    shippingAddress: {
      firstName: 'Simulated',
      lastName: 'Customer',
      email: ctx.customerEmail || 'simulated@example.com',
      address1: ctx.shippingAddress.address1,
      city: ctx.shippingAddress.city,
      region: ctx.shippingAddress.region,
      zip: ctx.shippingAddress.zip,
      country: ctx.shippingAddress.country,
    },
    shippingMethod: ctx.shippingMethod ?? 'standard',
  });

  const draft = {
    ...ctx,
    so: {
      ...ctx.so,
      supplierExternalId: result.supplierOrderId,
      submittedAt: new Date().toISOString(),
      status: 'in_production' as const,
    },
  };

  draft.so.items.forEach((item) => {
    item.status = 'submitted';
  });
  draft.so.items.forEach((i) => (i.status = 'in_production'));

  return { context: draft, next: 'in_production' as const };
}

async function inProductionState(
  ctx: Readonly<SupplierOrderWorkflowContext>,
  input: StateInput<never, SupplierOrderSignal>,
): Promise<StateOutput<SupplierOrderStateName, SupplierOrderWorkflowContext, void>> {
  const draft = {
    ...ctx,
    so: {
      ...ctx.so,
      items: ctx.so.items.map((i) => ({ ...i })),
      shipments: ctx.so.shipments ? ctx.so.shipments.map((s) => ({ ...s })) : undefined,
    },
  };

  // 1. Handle Cancellation
  if (input.kind === 'signal' && input.result.kind === 'cancel') {
    draft.so.status = 'cancelled';
    draft.so.items.forEach((i) => (i.status = 'cancelled'));
    return { context: draft, next: '__terminal:cancelled' };
  }

  // 2. Handle Timeout (Automatic fulfillment strategy execution)
  if (input.kind === 'timeout') {
    if (!draft.manualMode) {
      // Transition to shipped
      const trackingNumber = `SIM${wf.workflowInfo().workflowId.slice(0, 8).toUpperCase()}`;
      draft.so.status = 'shipped';
      draft.so.shippedAt = new Date().toISOString();
      draft.so.carrier = 'Simulated Carrier';
      draft.so.trackingNumber = trackingNumber;
      draft.so.shipments = [
        {
          shipmentId: `${draft.orderId}-${draft.so.supplierOrderId}-1`,
          carrier: 'Simulated Carrier',
          trackingNumber,
          items: draft.so.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
          shippedAt: new Date().toISOString(),
        },
      ];
      draft.so.items.forEach((item) => {
        item.status = 'shipped';
      });

      return { context: draft, next: 'shipped' as const };
    }
  }

  // 3. Handle Webhook/Manual Signal (Manual fulfillment strategy execution)
  if (input.kind === 'signal' && input.result.kind === 'supplierStatus') {
    const update = input.result.update;
    const updatedContext = await applySupplierUpdate(draft, update);
    const status = updatedContext.so.status;

    if (status === 'shipped' || status === 'partially_shipped') {
      return { context: updatedContext, next: 'shipped' as const };
    }
    if (status === 'delivered') {
      return { context: updatedContext, next: '__terminal:delivered' };
    }
    if (status === 'failed') {
      return { context: updatedContext, next: '__terminal:failed' };
    }
    if (status === 'cancelled') {
      return { context: updatedContext, next: '__terminal:cancelled' };
    }
    return { context: updatedContext, next: 'in_production' as const };
  }

  return { context: draft, next: 'in_production' as const };
}

async function shippedState(
  ctx: Readonly<SupplierOrderWorkflowContext>,
  input: StateInput<never, SupplierOrderSignal>,
): Promise<StateOutput<SupplierOrderStateName, SupplierOrderWorkflowContext, void>> {
  const draft = {
    ...ctx,
    so: {
      ...ctx.so,
      items: ctx.so.items.map((i) => ({ ...i })),
      shipments: ctx.so.shipments ? ctx.so.shipments.map((s) => ({ ...s })) : undefined,
    },
  };

  // 1. Handle Cancellation
  if (input.kind === 'signal' && input.result.kind === 'cancel') {
    draft.so.status = 'cancelled';
    draft.so.items.forEach((i) => (i.status = 'cancelled'));
    return { context: draft, next: '__terminal:cancelled' };
  }

  // 2. Handle Timeout
  if (input.kind === 'timeout') {
    if (!draft.manualMode) {
      // Transition to delivered
      draft.so.status = 'delivered';
      draft.so.completedAt = new Date().toISOString();
      draft.so.items.forEach((item) => {
        item.status = 'delivered';
      });
      return { context: draft, next: '__terminal:delivered' };
    }
  }

  // 3. Handle Webhook Signal
  if (input.kind === 'signal' && input.result.kind === 'supplierStatus') {
    const update = input.result.update;
    const updatedContext = await applySupplierUpdate(draft, update);
    if (updatedContext.so.status === 'delivered') {
      return { context: updatedContext, next: '__terminal:delivered' };
    }
    return { context: draft, next: 'shipped' as const };
  }

  return { context: draft, next: 'shipped' as const };
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
    states: {
      received: {
        fn: receivedState,
        timeout: '1 millisecond',
      },
      submitting: {
        fn: submittingState,
        timeout: '1 millisecond',
      },
      in_production: {
        fn: inProductionState,
        timeout: `${processingDelayMs}ms`,
      },
      shipped: {
        fn: shippedState,
        timeout: `${shippingDelayMs + deliveryDelayMs}ms`,
      },
    },
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
      } else if (to === '__terminal:delivered') {
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
          cancelCtx.so.items.map((i: FulfillmentLineItemState) => ({ variantId: i.sku })),
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
            finalCtx.so.items.map((i: FulfillmentLineItemState) => ({ variantId: i.sku })),
          );
        } catch (e) {
          wf.log.error('Failed to fulfill inventory on delivery', { error: String(e) });
        }
      } else if (finalCtx.so.status === 'failed' || finalCtx.so.status === 'cancelled') {
        try {
          await releaseInventoryReservations(
            finalCtx.cartId,
            finalCtx.so.items.map((i: FulfillmentLineItemState) => ({ variantId: i.sku })),
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
