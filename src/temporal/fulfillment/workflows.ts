import * as wf from '@temporalio/workflow';
import { OMS } from '../contracts';
import { buildWorkflowId, buildWorkflowStartOptions, DEMO_STORE_ID } from '../contracts/constants';
import type {
  FulfillmentOrderRequest,
  FulfillmentOrderStatus,
  FulfillmentWorkflowState,
  FulfillmentFulfillerOrderState,
  FulfillmentLineItemState,
  FulfillerStatusUpdate,
  FulfillmentStateName,
  FulfillmentSignal,
} from './types';
import {
  getStatusQuery,
  fulfillerStatusSignal,
  cancelSignal,
  childStatusSignal,
  type FulfillmentResult,
  type FulfillmentFulfillerOrderResult,
} from './definitions';
import {
  transferInventoryReservations,
  releaseInventoryReservations,
  indexFulfillment,
} from './activities';
import { buildFulfillmentDocument } from './document-builder';
import {
  runStateMachine,
  StateMachineConfig,
  SignalRegistration,
  deriveDisplayStatus,
  isTerminal,
} from '../framework';
import { FULFILLMENT_STATES } from './states';
import {
  fulfillerOrderWorkflow,
  childCancelSignal,
  childFulfillerStatusSignal,
} from './fulfiller-workflows';

// Re-export fulfillerOrderWorkflow so it is registered by the Temporal worker
export { fulfillerOrderWorkflow };

export type FulfillmentStatusUpdate = OMS.FulfillmentStatusUpdate;
// Internal alias for the OMS-facing status vocabulary (no external importers).
type FulfillerOrderStatus = OMS.FulfillerOrderStatus;

// ============================================================================
// Status Mapping
// ============================================================================

function mapToFulfillerOrderStatus(status: FulfillmentOrderStatus): FulfillerOrderStatus | null {
  switch (status) {
    case 'in_production':
      return 'processing';
    case 'shipped':
    case 'partially_shipped':
      return 'shipped';
    case 'delivered':
      return 'delivered';
    case 'failed':
    case 'cancelled':
      return 'rejected';
    // Pre-submission phases have no OMS-visible status yet — explicitly skipped.
    case 'received':
    case 'validating':
    case 'submitting':
      return null;
    default:
      // No silent fallbacks: a new status must be mapped (or explicitly skipped) here.
      throw new Error(`Unmapped fulfiller order status: ${status satisfies never}`);
  }
}

// ============================================================================
// OMS Signaling
// ============================================================================

export async function signalParentOMSWorkflow(
  state: FulfillmentWorkflowState,
  fulfillerOrder: FulfillmentFulfillerOrderState,
): Promise<void> {
  const omsStatus = mapToFulfillerOrderStatus(fulfillerOrder.status);
  if (!omsStatus) return;

  const latestShipment = fulfillerOrder.shipments?.[fulfillerOrder.shipments.length - 1];

  const update: FulfillmentStatusUpdate = {
    fulfillerOrderId: fulfillerOrder.fulfillerOrderId,
    status: omsStatus,
    carrier: latestShipment?.carrier,
    trackingNumber: latestShipment?.trackingNumber,
    trackingUrl: latestShipment?.trackingUrl,
    shipmentDate: latestShipment?.shippedAt,
    error: fulfillerOrder.errorMessage,
  };

  try {
    const omsWorkflowId = buildWorkflowId(DEMO_STORE_ID, 'order', state.orderId);
    const omsHandle = wf.getExternalWorkflowHandle(omsWorkflowId);
    await omsHandle.signal<[OMS.FulfillmentStatusUpdate]>('fulfillmentStatus', update);
  } catch (error) {
    wf.log.error(`Failed to signal OMS workflow for order ${state.orderId}`, {
      update,
      error: String(error),
    });
  }
}

async function syncProjections(state: FulfillmentWorkflowState) {
  await indexFulfillment(buildFulfillmentDocument(state));
}

// ============================================================================
// Main Workflow
// ============================================================================

export async function fulfillmentWorkflow(
  request: FulfillmentOrderRequest,
): Promise<FulfillmentResult> {
  // Initialize multi-fulfiller state
  const state: FulfillmentWorkflowState = {
    orderId: request.orderId,
    cartId: request.cartId,
    customerId: request.customerId,
    customerEmail: request.customerEmail,
    confirmationNumber: request.confirmationNumber,
    status: 'received',
    fulfillerOrders: request.fulfillerOrders.map(
      (so): FulfillmentFulfillerOrderState => ({
        fulfillerOrderId: so.fulfillerOrderId,
        fulfillerId: so.fulfillerId,
        fulfillerType: so.fulfillerType,
        items: so.items.map(
          (item): FulfillmentLineItemState => ({
            sku: item.sku,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            status: 'pending',
          }),
        ),
        status: 'received',
      }),
    ),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Map to store child handles by fulfillerOrderId
  const childHandles = new Map<string, wf.ChildWorkflowHandle<typeof fulfillerOrderWorkflow>>();

  // Wire Query
  wf.setHandler(getStatusQuery, () => state);

  // Wire Signals
  const signals: SignalRegistration<FulfillmentSignal>[] = [
    {
      definition: childStatusSignal,
      toSignal: (update: FulfillmentFulfillerOrderState) => ({
        kind: 'childStatus' as const,
        update,
      }),
    },
    {
      definition: cancelSignal,
      toSignal: () => ({ kind: 'cancel' as const }),
    },
  ];

  // Route webhook fulfillerStatusUpdate signals to the appropriate child workflow
  wf.setHandler(fulfillerStatusSignal, (update: FulfillerStatusUpdate) => {
    const childHandle = childHandles.get(update.fulfillerOrderId);
    if (childHandle) {
      childHandle.signal(childFulfillerStatusSignal, update).catch((err) => {
        wf.log.warn('Failed to forward fulfiller status signal to child', { error: String(err) });
      });
    }
  });

  // Wire State Machine Config
  const config: StateMachineConfig<
    FulfillmentStateName,
    never,
    FulfillmentWorkflowState,
    FulfillmentResult,
    FulfillmentSignal
  > = {
    states: FULFILLMENT_STATES,
    initialState: 'received',
    onContextUpdate: (
      newCtx: FulfillmentWorkflowState,
      currentState: FulfillmentStateName | `__terminal:${string}`,
    ) => {
      Object.assign(state, newCtx);
      // Sync top-level status from driver state
      state.status = deriveDisplayStatus<FulfillmentWorkflowState['status']>(currentState);
    },
    onStart: async (startCtx: FulfillmentWorkflowState) => {
      // 1. Transfer inventory reservations to fulfiller locations
      wf.log.info('Transferring inventory reservations', {
        cartId: startCtx.cartId,
        fulfillerOrderCount: startCtx.fulfillerOrders.length,
      });
      const transferItems = startCtx.fulfillerOrders.flatMap((so: FulfillmentFulfillerOrderState) =>
        so.items.map((item: FulfillmentLineItemState) => ({
          variantId: item.variantId,
          fulfillerId: so.fulfillerId,
          quantity: item.quantity,
        })),
      );
      await transferInventoryReservations(startCtx.cartId, transferItems);

      // 2. Spawn fulfiller order child workflows
      startCtx.status = 'in_production';
      startCtx.updatedAt = new Date().toISOString();
      await syncProjections(startCtx);

      for (const fulfillerOrder of startCtx.fulfillerOrders) {
        try {
          const childHandle = await wf.startChild(fulfillerOrderWorkflow, {
            ...buildWorkflowStartOptions({
              storeId: DEMO_STORE_ID,
              domain: 'fulfiller-order',
              entityId: fulfillerOrder.fulfillerOrderId,
              orderId: startCtx.orderId,
              cartId: startCtx.cartId,
            }),
            args: [
              {
                orderId: startCtx.orderId,
                cartId: startCtx.cartId,
                customerId: startCtx.customerId,
                customerEmail: startCtx.customerEmail,
                confirmationNumber: startCtx.confirmationNumber,
                shippingAddress: request.shippingAddress,
                shippingMethod: request.shippingMethod,
                fulfillerOrder,
              },
            ],
          });
          childHandles.set(fulfillerOrder.fulfillerOrderId, childHandle);
        } catch (err) {
          wf.log.error('Failed to start fulfiller order child workflow', {
            fulfillerOrderId: fulfillerOrder.fulfillerOrderId,
            error: String(err),
          });
        }
      }

      return { context: startCtx, nextState: 'in_production' };
    },
    onTransition: async (
      from: FulfillmentStateName,
      to: FulfillmentStateName | `__terminal:${string}`,
      eventDesc: 'timeout' | 'signal',
      currentCtx: FulfillmentWorkflowState,
    ) => {
      await syncProjections(currentCtx);
      for (const so of currentCtx.fulfillerOrders) {
        await signalParentOMSWorkflow(currentCtx, so);
      }
    },
    onCancellation: async (cancelCtx: FulfillmentWorkflowState) => {
      cancelCtx.status = 'cancelled';
      cancelCtx.updatedAt = new Date().toISOString();
      for (const so of cancelCtx.fulfillerOrders) {
        so.status = 'cancelled';
        so.items.forEach((i) => (i.status = 'cancelled'));
      }

      // Signal cancel to all child workflows
      for (const [, childHandle] of childHandles) {
        try {
          await childHandle.signal(childCancelSignal);
        } catch {
          // Ignore errors as child might already be complete
        }
      }

      const allItems = cancelCtx.fulfillerOrders.flatMap((so: FulfillmentFulfillerOrderState) =>
        so.items.map((i: FulfillmentLineItemState) => ({ variantId: i.variantId })),
      );
      try {
        await releaseInventoryReservations(cancelCtx.cartId, allItems);
      } catch (releaseErr) {
        wf.log.error('Failed to release inventory on workflow cancellation', {
          error: String(releaseErr),
        });
      }
      await syncProjections(cancelCtx);
    },
    onTerminal: async (finalCtx: FulfillmentWorkflowState, finalState: string) => {
      if (isTerminal(finalState, 'cancelled') || isTerminal(finalState, 'failed')) {
        for (const [, childHandle] of childHandles) {
          try {
            await childHandle.signal(childCancelSignal);
          } catch {
            // Ignore
          }
        }
      }

      // Inventory fulfillment on delivery happens in the fulfiller-order child (which
      // owns the shipment lifecycle) — fulfilling here too double-decremented stock.
      await syncProjections(finalCtx);
    },
  };

  await runStateMachine<
    FulfillmentStateName,
    never,
    FulfillmentWorkflowState,
    FulfillmentResult,
    FulfillmentSignal
  >(config, state, [], signals);

  return buildResult(state);
}

function buildResult(state: FulfillmentWorkflowState): FulfillmentResult {
  return {
    status: state.status,
    fulfillerOrders: state.fulfillerOrders.map(
      (so): FulfillmentFulfillerOrderResult => ({
        fulfillerOrderId: so.fulfillerOrderId,
        status: so.status,
        carrier: so.carrier,
        trackingNumber: so.trackingNumber,
        trackingUrl: so.trackingUrl,
        shipments: so.shipments,
      }),
    ),
  };
}
