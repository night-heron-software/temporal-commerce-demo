import * as wf from '@temporalio/workflow';
import { OMS } from '../contracts';
import type {
  FulfillmentOrderRequest,
  FulfillmentWorkflowState,
  FulfillmentSupplierOrderState,
  FulfillmentLineItemState,
  SupplierStatusUpdate,
  ShipmentInfo,
  FulfillmentStateName,
  FulfillmentSignal,
} from './types';
import {
  getStatusQuery,
  supplierStatusSignal,
  cancelSignal,
  childStatusSignal,
  type FulfillmentResult,
  type FulfillmentSupplierOrderResult,
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
} from '../framework';
import { FULFILLMENT_STATES } from './states';
import {
  supplierOrderWorkflow,
  childCancelSignal,
  childSupplierStatusSignal,
} from './supplier-workflows';

// Re-export supplierOrderWorkflow so it is registered by the Temporal worker
export { supplierOrderWorkflow };

export type FulfillmentStatusUpdate = OMS.FulfillmentStatusUpdate;
export type SupplierOrderStatus = OMS.SupplierOrderStatus;

// ============================================================================
// Status Mapping
// ============================================================================

function mapToSupplierOrderStatus(
  status: FulfillmentSupplierOrderState['status'],
): SupplierOrderStatus | null {
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
    default:
      return null;
  }
}

// ============================================================================
// OMS Signaling
// ============================================================================

export async function signalParentOMSWorkflow(
  state: FulfillmentWorkflowState,
  supplierOrder: FulfillmentSupplierOrderState,
): Promise<void> {
  const omsStatus = mapToSupplierOrderStatus(supplierOrder.status);
  if (!omsStatus) return;

  const latestShipment = supplierOrder.shipments?.[supplierOrder.shipments.length - 1];

  const update: FulfillmentStatusUpdate = {
    supplierOrderId: supplierOrder.supplierOrderId,
    status: omsStatus,
    carrier: latestShipment?.carrier,
    trackingNumber: latestShipment?.trackingNumber,
    trackingUrl: latestShipment?.trackingUrl,
    shipmentDate: latestShipment?.shippedAt,
    error: supplierOrder.errorMessage,
  };

  try {
    const omsWorkflowId = `order-${state.orderId}`;
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
  // Initialize multi-supplier state
  const state: FulfillmentWorkflowState = {
    orderId: request.orderId,
    cartId: request.cartId,
    customerId: request.customerId,
    customerEmail: request.customerEmail,
    confirmationNumber: request.confirmationNumber,
    status: 'received',
    supplierOrders: request.supplierOrders.map(
      (so): FulfillmentSupplierOrderState => ({
        supplierOrderId: so.supplierOrderId,
        supplierId: so.supplierId,
        supplierType: so.supplierType,
        items: so.items.map(
          (item): FulfillmentLineItemState => ({
            sku: item.sku,
            productId: item.productId,
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

  // Map to store child handles by supplierOrderId
  const childHandles = new Map<string, wf.ChildWorkflowHandle<typeof supplierOrderWorkflow>>();

  // Wire Query
  wf.setHandler(getStatusQuery, () => state);

  // Wire Signals
  const signals: SignalRegistration<FulfillmentSignal>[] = [
    {
      definition: childStatusSignal,
      toSignal: (update: FulfillmentSupplierOrderState) => ({ kind: 'childStatus' as const, update }),
    },
    {
      definition: cancelSignal,
      toSignal: () => ({ kind: 'cancel' as const }),
    },
  ];

  // Route webhook supplierStatusUpdate signals to the appropriate child workflow
  wf.setHandler(supplierStatusSignal, (update: SupplierStatusUpdate) => {
    const childHandle = childHandles.get(update.supplierOrderId);
    if (childHandle) {
      childHandle.signal(childSupplierStatusSignal, update).catch((err) => {
        wf.log.warn('Failed to forward supplier status signal to child', { error: String(err) });
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
    onContextUpdate: (newCtx: FulfillmentWorkflowState, currentState: FulfillmentStateName | `__terminal:${string}`) => {
      Object.assign(state, newCtx);
      // Sync top-level status from driver state
      const derivedStatus = typeof currentState === 'string' && currentState.startsWith('__terminal:')
        ? currentState.replace('__terminal:', '')
        : currentState;
      state.status = derivedStatus as any;
    },
    onStart: async (startCtx: FulfillmentWorkflowState) => {
      // 1. Transfer inventory reservations to supplier locations
      wf.log.info('Transferring inventory reservations', {
        cartId: startCtx.cartId,
        supplierOrderCount: startCtx.supplierOrders.length,
      });
      const transferItems = startCtx.supplierOrders.flatMap((so: FulfillmentSupplierOrderState) =>
        so.items.map((item: FulfillmentLineItemState) => ({
          variantId: item.sku,
          supplierId: so.supplierId,
          quantity: item.quantity,
        })),
      );
      await transferInventoryReservations(startCtx.cartId, transferItems);

      // 2. Spawn supplier order child workflows
      startCtx.status = 'in_production';
      startCtx.updatedAt = new Date().toISOString();
      await syncProjections(startCtx);

      for (const supplierOrder of startCtx.supplierOrders) {
        try {
          const childHandle = await wf.startChild(supplierOrderWorkflow, {
            workflowId: `fulfillment-${startCtx.orderId}-supplier-${supplierOrder.supplierOrderId}`,
            args: [{
              orderId: startCtx.orderId,
              cartId: startCtx.cartId,
              customerId: startCtx.customerId,
              customerEmail: startCtx.customerEmail,
              confirmationNumber: startCtx.confirmationNumber,
              shippingAddress: request.shippingAddress,
              shippingMethod: request.shippingMethod,
              supplierOrder,
            }],
          });
          childHandles.set(supplierOrder.supplierOrderId, childHandle);
        } catch (err) {
          wf.log.error('Failed to start supplier order child workflow', {
            supplierOrderId: supplierOrder.supplierOrderId,
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
      currentCtx: FulfillmentWorkflowState
    ) => {
      await syncProjections(currentCtx);
      for (const so of currentCtx.supplierOrders) {
        await signalParentOMSWorkflow(currentCtx, so);
      }
    },
    onCancellation: async (cancelCtx: FulfillmentWorkflowState) => {
      cancelCtx.status = 'cancelled';
      cancelCtx.updatedAt = new Date().toISOString();
      for (const so of cancelCtx.supplierOrders) {
        so.status = 'cancelled';
        so.items.forEach((i) => (i.status = 'cancelled'));
      }
      
      // Signal cancel to all child workflows
      for (const [_, childHandle] of childHandles) {
        try {
          await childHandle.signal(childCancelSignal);
        } catch (err) {
          // Ignore errors as child might already be complete
        }
      }

      const allItems = cancelCtx.supplierOrders.flatMap((so: FulfillmentSupplierOrderState) =>
        so.items.map((i: FulfillmentLineItemState) => ({ variantId: i.sku })),
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
      if (finalState === '__terminal:cancelled' || finalState === '__terminal:failed') {
        for (const [_, childHandle] of childHandles) {
          try {
            await childHandle.signal(childCancelSignal);
          } catch (err) {
            // Ignore
          }
        }
      }
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
    supplierOrders: state.supplierOrders.map(
      (so): FulfillmentSupplierOrderResult => ({
        supplierOrderId: so.supplierOrderId,
        status: so.status,
        carrier: so.carrier,
        trackingNumber: so.trackingNumber,
        trackingUrl: so.trackingUrl,
        shipments: so.shipments,
      }),
    ),
  };
}
