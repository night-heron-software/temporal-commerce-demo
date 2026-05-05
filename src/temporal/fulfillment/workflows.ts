/**
 * Fulfillment Workflow
 * Manages the fulfillment lifecycle for all supplier orders in a single order.
 * Receives pre-decided supplier orders from OMS and handles:
 * - Inventory reservation transfer to suppliers
 * - Per-supplier strategy execution (Printify / Simulated)
 * - Status aggregation and OMS signaling
 * - Inventory lifecycle (fulfill on delivery, release on rejection/cancellation)
 */

import * as wf from "@temporalio/workflow";
import { OMS, Suppliers } from '../contracts';
import type {
  FulfillmentOrderRequest,
  FulfillmentWorkflowState,
  FulfillmentSupplierOrderState,
  FulfillmentLineItemState,
  SupplierStatusUpdate,
  ShipmentInfo,
} from "./types";
import {
  getStatusQuery,
  supplierStatusSignal,
  cancelSignal,
  type FulfillmentResult,
  type FulfillmentSupplierOrderResult,
} from "./definitions";
import {
  getFeatureFlag,
  submitSupplierOrder,
  buildFulfillmentPayload,
  pollSupplierStatus,
  sendShippedEmail,
  sendDeliveredEmail,
  transferInventoryReservations,
  fulfillInventoryReservations,
  releaseInventoryReservations,
  indexFulfillment,
  indexShipment,
} from "./activities";
import { buildFulfillmentDocument } from "./document-builder";
export type FulfillmentStatusUpdate = OMS.FulfillmentStatusUpdate;
export type SupplierOrderStatus = OMS.SupplierOrderStatus;

const POLLING_INTERVAL = "15 minutes";

// ============================================================================
// Status Mapping
// ============================================================================

/**
 * Map internal fulfillment status to SupplierOrderStatus for OMS
 */
function mapToSupplierOrderStatus(
  status: FulfillmentSupplierOrderState["status"],
): SupplierOrderStatus | null {
  switch (status) {
    case "in_production":
      return "processing";
    case "shipped":
    case "partially_shipped":
      return "shipped";
    case "delivered":
      return "delivered";
    case "failed":
    case "cancelled":
      return "rejected";
    default:
      return null;
  }
}

// ============================================================================
// OMS Signaling
// ============================================================================

/**
 * Signal the parent OMS workflow with fulfillment status update.
 * Sends per-supplier-order updates so OMS can mirror into its state.
 */
async function signalParentOMSWorkflow(
  state: FulfillmentWorkflowState,
  supplierOrder: FulfillmentSupplierOrderState,
  dataFlowEnabled: boolean = false,
): Promise<void> {
  const omsStatus = mapToSupplierOrderStatus(supplierOrder.status);
  if (!omsStatus) return;

  const latestShipment =
    supplierOrder.shipments?.[supplierOrder.shipments.length - 1];

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
    await omsHandle.signal<[OMS.FulfillmentStatusUpdate]>(
      "fulfillmentStatus",
      update,
    );
    if (dataFlowEnabled) {
      wf.log.info("[DataFlow] Status: FulfillmentStatusUpdate → OMS", {
        dataFlow: true,
        stage: "Status: Fulfillment → OMS",
        label: "output.FulfillmentStatusUpdate",
        data: JSON.stringify(update, null, 2),
      });
    }
  } catch (error) {
    wf.log.error(`Failed to signal OMS workflow for order ${state.orderId}`, {
      update,
      error: String(error),
    });
  }
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
    status: "received",
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
            status: "pending",
          }),
        ),
        status: "received",
      }),
    ),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const dataFlowEnabled = await getFeatureFlag("DATA_FLOW_LOGGING");

  // Helper: sync projections to ES
  const syncProjections = async () => {
    await indexFulfillment(buildFulfillmentDocument(state));
  };

  // Query handler
  wf.setHandler(getStatusQuery, () => state);

  // Signal handlers
  wf.setHandler(supplierStatusSignal, (update: SupplierStatusUpdate) => {
    // Route signal to the appropriate supplier order
    for (const so of state.supplierOrders) {
      if (
        so.supplierExternalId === update.supplierOrderId ||
        so.supplierOrderId === update.supplierOrderId
      ) {
        handleSupplierUpdate(so, update);
        if (dataFlowEnabled) {
          wf.log.info("[DataFlow] Status: SupplierStatusUpdate inbound", {
            dataFlow: true,
            stage: "Status: Supplier → Fulfillment",
            label: "input.SupplierStatusUpdate",
            data: JSON.stringify(update, null, 2),
          });
        }
        // Re-aggregate fulfillment-level status
        state.status = aggregateStatus(state);
        state.updatedAt = new Date().toISOString();
        break;
      }
    }
  });

  wf.setHandler(cancelSignal, () => {
    state.status = "cancelled";
    state.updatedAt = new Date().toISOString();
    for (const so of state.supplierOrders) {
      so.status = "cancelled";
      so.items.forEach((i) => (i.status = "cancelled"));
    }
  });

  try {
    // 1. Transfer inventory reservations to supplier locations
    wf.log.info("Transferring inventory reservations", {
      cartId: state.cartId,
      supplierOrderCount: state.supplierOrders.length,
    });
    const transferItems = state.supplierOrders.flatMap((so) =>
      so.items.map((item) => ({
        variantId: item.sku,
        supplierId: so.supplierId,
        quantity: item.quantity,
      })),
    );
    await transferInventoryReservations(state.cartId, transferItems);

    // 2. Run per-supplier strategies
    state.status = "in_production";
    state.updatedAt = new Date().toISOString();
    await syncProjections();

    // Execute each supplier order (sequentially to avoid overwhelming suppliers)
    for (const supplierOrder of state.supplierOrders) {
      if ((state.status as string) === "cancelled") break;

      if (supplierOrder.supplierType === "simulated") {
        await runSimulatedFulfillment(
          state,
          supplierOrder,
          request,
          syncProjections,
        );
      } else if (
        supplierOrder.supplierType === "printify-dynamic" ||
        supplierOrder.supplierType === "swiftpod"
      ) {
        await runDynamicFulfillment(
          state,
          supplierOrder,
          request,
          syncProjections,
        );
      } else {
        supplierOrder.status = "failed";
        supplierOrder.errorMessage = `Unsupported supplier type: ${supplierOrder.supplierType}`;
        await signalParentOMSWorkflow(state, supplierOrder);
      }

      // Handle inventory lifecycle per supplier order
      if (supplierOrder.status === "delivered") {
        try {
          await fulfillInventoryReservations(
            state.cartId,
            supplierOrder.items.map((i) => ({ variantId: i.sku })),
          );
          wf.log.info("Fulfilled inventory for delivered supplier order", {
            supplierOrderId: supplierOrder.supplierOrderId,
          });
        } catch (e) {
          wf.log.error("Failed to fulfill inventory on delivery", {
            error: String(e),
          });
        }
      } else if (
        supplierOrder.status === "failed" ||
        supplierOrder.status === "cancelled"
      ) {
        try {
          await releaseInventoryReservations(
            state.cartId,
            supplierOrder.items.map((i) => ({ variantId: i.sku })),
          );
          wf.log.info(
            "Released inventory for failed/cancelled supplier order",
            {
              supplierOrderId: supplierOrder.supplierOrderId,
            },
          );
        } catch (e) {
          wf.log.error("Failed to release inventory", { error: String(e) });
        }
      }
    }

    // 3. Aggregate final status
    state.status = aggregateStatus(state);
    state.updatedAt = new Date().toISOString();
    if (
      state.status === "delivered" ||
      state.status === "failed" ||
      state.status === "cancelled"
    ) {
      state.completedAt = new Date().toISOString();
    }
    await syncProjections();

    return buildResult(state);
  } catch (error) {
    state.status = "failed";
    state.errorMessage = String(error);
    state.updatedAt = new Date().toISOString();

    // Release all inventory on failure
    try {
      const allItems = state.supplierOrders.flatMap((so) =>
        so.items.map((i) => ({ variantId: i.sku })),
      );
      await releaseInventoryReservations(state.cartId, allItems);
    } catch (releaseErr) {
      wf.log.error("Failed to release inventory on workflow failure", {
        error: String(releaseErr),
      });
    }

    await syncProjections();
    throw error;
  }
}

// ============================================================================
// Status Aggregation
// ============================================================================

function aggregateStatus(
  state: FulfillmentWorkflowState,
): FulfillmentWorkflowState["status"] {
  const statuses = state.supplierOrders.map((so) => so.status);

  if (statuses.every((s) => s === "delivered")) return "delivered";
  if (statuses.every((s) => s === "cancelled" || s === "failed"))
    return "failed";
  if (statuses.every((s) => s === "shipped" || s === "delivered"))
    return "shipped";
  if (statuses.some((s) => s === "shipped" || s === "delivered"))
    return "partially_shipped";
  return "in_production";
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

// ============================================================================
// Dynamic Fulfillment Strategy
// ============================================================================

async function runDynamicFulfillment(
  state: FulfillmentWorkflowState,
  so: FulfillmentSupplierOrderState,
  request: FulfillmentOrderRequest,
  syncProjections: () => Promise<void>,
): Promise<void> {
  // 1. Validate items (all items must have a productId)
  so.status = "validating";
  so.items.forEach((i) => (i.status = "pending"));
  state.updatedAt = new Date().toISOString();

  const missingProducts = so.items
    .filter((i) => !i.productId)
    .map((i) => i.sku);
  if (missingProducts.length > 0) {
    so.status = "failed";
    so.errorMessage = `Items missing productId for dynamic order: ${missingProducts.join(", ")}`;
    await signalParentOMSWorkflow(state, so);
    return;
  }

  // 2. Submit to supplier
  so.status = "submitting";
  state.updatedAt = new Date().toISOString();

  const result = await submitSupplierOrder({
    fulfillmentId: wf.workflowInfo().workflowId,
    supplierType: so.supplierType as "printify-dynamic" | "swiftpod",
    items: so.items.map((item) => ({
      sku: item.sku,
      productId: item.productId,
      quantity: item.quantity,
      supplierProductId: "",
      supplierVariantId: "",
    })),
    shippingAddress: request.shippingAddress,
    shippingMethod: request.shippingMethod ?? "standard",
  });

  if (!result.success) {
    so.status = "failed";
    so.errorMessage = result.errorMessage;
    await signalParentOMSWorkflow(state, so);
    return;
  }

  so.supplierExternalId = result.supplierOrderId;
  so.submittedAt = new Date().toISOString();
  state.updatedAt = new Date().toISOString();

  so.items.forEach((item) => {
    item.status = "submitted";
    const lineItemIdRecord = (result.lineItemIds ?? {}) as Record<
      string,
      string
    >;
    if (item.sku in lineItemIdRecord) {
      item.supplierLineItemId = lineItemIdRecord[item.sku];
    }
  });

  so.status = "in_production";
  so.items.forEach((i) => (i.status = "in_production"));
  state.updatedAt = new Date().toISOString();
  await syncProjections();
  await signalParentOMSWorkflow(state, so);

  // 3. Wait for completion with periodic polling
  await waitForSupplierCompletion(state, so, syncProjections);
}

// ============================================================================
// Simulated Fulfillment Strategy
// ============================================================================

async function runSimulatedFulfillment(
  state: FulfillmentWorkflowState,
  so: FulfillmentSupplierOrderState,
  request: FulfillmentOrderRequest,
  syncProjections: () => Promise<void>,
): Promise<void> {
  // Submit order (always succeeds for simulated)
  so.status = "submitting";
  state.updatedAt = new Date().toISOString();

  const result = await submitSupplierOrder({
    fulfillmentId: wf.workflowInfo().workflowId,
    supplierType: "simulated",
    items: so.items.map((item) => ({
      sku: item.sku,
      supplierProductId: "simulated",
      supplierVariantId: 0,
      quantity: item.quantity,
    })),
    shippingAddress: {
      firstName: "Simulated",
      lastName: "Customer",
      email: state.customerEmail || "simulated@example.com",
      address1: "123 Simulated St",
      city: "Sim City",
      region: "SC",
      zip: "00000",
      country: "US",
    },
    shippingMethod: "standard",
  });

  so.supplierExternalId = result.supplierOrderId;
  so.submittedAt = new Date().toISOString();
  so.items.forEach((item) => {
    item.status = "submitted";
  });

  // Move to in_production
  so.status = "in_production";
  so.items.forEach((item) => {
    item.status = "in_production";
  });
  state.updatedAt = new Date().toISOString();
  await syncProjections();
  await signalParentOMSWorkflow(state, so);

  // Check if manual fulfillment mode is enabled
  const manualMode = await getFeatureFlag("MANUAL_FULFILLMENT");

  if (manualMode) {
    await runManualSimulatedFulfillment(state, so, syncProjections);
  } else {
    await runAutomaticSimulatedFulfillment(state, so, syncProjections);
  }
}

async function runManualSimulatedFulfillment(
  state: FulfillmentWorkflowState,
  so: FulfillmentSupplierOrderState,
  syncProjections: () => Promise<void>,
): Promise<void> {
  wf.log.info(
    "Manual fulfillment mode — waiting for signal to advance to shipped",
    {
      supplierOrderId: so.supplierOrderId,
    },
  );
  await wf.condition(() => so.status !== "in_production");

  if (so.status === "shipped") {
    await syncProjections();
    await signalParentOMSWorkflow(state, so);

    if (state.customerEmail && so.shipments?.length) {
      const confirmNumber = state.confirmationNumber || state.orderId;
      const shipment = so.shipments[so.shipments.length - 1];
      await sendShippedEmail(
        state.customerEmail,
        state.orderId,
        confirmNumber,
        {
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
        },
      );
    }

    wf.log.info(
      "Manual fulfillment mode — waiting for signal to advance to delivered",
    );
    await wf.condition(() => so.status !== "shipped");

    if ((so.status as string) === "delivered") {
      await syncProjections();
      await signalParentOMSWorkflow(state, so);

      if (state.customerEmail) {
        const confirmNumber = state.confirmationNumber || state.orderId;
        await sendDeliveredEmail(
          state.customerEmail,
          state.orderId,
          confirmNumber,
        );
      }
    }
  }

  if (so.status === "cancelled" || so.status === "failed") {
    await syncProjections();
    await signalParentOMSWorkflow(state, so);
  }
}

async function runAutomaticSimulatedFulfillment(
  state: FulfillmentWorkflowState,
  so: FulfillmentSupplierOrderState,
  syncProjections: () => Promise<void>,
): Promise<void> {
  const processingDelayMs = parseInt(
    (wf.workflowInfo().memo?.processingDelayMs as string) || "60000",
    10,
  );
  const shippingDelayMs = parseInt(
    (wf.workflowInfo().memo?.shippingDelayMs as string) || "60000",
    10,
  );
  const deliveryDelayMs = parseInt(
    (wf.workflowInfo().memo?.deliveryDelayMs as string) || "60000",
    10,
  );

  // Wait for processing phase
  await wf.sleep(processingDelayMs);

  // Transition to shipped
  const trackingNumber = `SIM${Date.now().toString(36).toUpperCase()}`;
  so.status = "shipped";
  so.shippedAt = new Date().toISOString();
  so.carrier = "Simulated Carrier";
  so.trackingNumber = trackingNumber;
  so.shipments = [
    {
      shipmentId: `${state.orderId}-${so.supplierOrderId}-1`,
      carrier: "Simulated Carrier",
      trackingNumber,
      items: so.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
      shippedAt: new Date().toISOString(),
    },
  ];
  so.items.forEach((item) => {
    item.status = "shipped";
  });
  state.updatedAt = new Date().toISOString();
  await syncProjections();
  await signalParentOMSWorkflow(state, so);

  // Index the shipment
  const shipment = so.shipments[0];
  await indexShipment({
    shipmentId: shipment.shipmentId,
    orderId: state.orderId,
    carrier: shipment.carrier,
    trackingNumber: shipment.trackingNumber,
    itemCount: shipment.items.length,
    shippedAt: shipment.shippedAt,
  });

  // Send shipped email
  if (state.customerEmail) {
    const confirmNumber = state.confirmationNumber || state.orderId;
    await sendShippedEmail(state.customerEmail, state.orderId, confirmNumber, {
      carrier: "Simulated Carrier",
      trackingNumber,
    });
  }

  // Wait for delivery phase
  await wf.sleep(shippingDelayMs + deliveryDelayMs);

  // Transition to delivered
  so.status = "delivered";
  so.completedAt = new Date().toISOString();
  so.items.forEach((item) => {
    item.status = "delivered";
  });
  state.updatedAt = new Date().toISOString();
  await syncProjections();
  await signalParentOMSWorkflow(state, so);

  // Send delivered email
  if (state.customerEmail) {
    const confirmNumber = state.confirmationNumber || state.orderId;
    await sendDeliveredEmail(state.customerEmail, state.orderId, confirmNumber);
  }
}

// ============================================================================
// Polling / Signal Waiting (Printify)
// ============================================================================

async function waitForSupplierCompletion(
  state: FulfillmentWorkflowState,
  so: FulfillmentSupplierOrderState,
  syncProjections: () => Promise<void>,
): Promise<void> {
  const isTerminal = () =>
    so.status === "delivered" ||
    so.status === "failed" ||
    so.status === "cancelled";

  let previousStatus = so.status;

  while (!isTerminal()) {
    // Wake up if we reach a terminal state OR if a signal changed our status
    const statusChanged = () => so.status !== previousStatus;
    const conditionMet = await wf.condition(
      () => isTerminal() || statusChanged(),
      POLLING_INTERVAL,
    );

    if (!conditionMet && !isTerminal() && so.supplierExternalId) {
      try {
        const update = await pollSupplierStatus({
          supplierOrderId: so.supplierExternalId,
          supplierType: so.supplierType,
        });
        handleSupplierUpdate(so, update);
      } catch {
        // Polling failed, will retry next interval
      }
    }

    // Process any status changes (whether from signal or polling)
    if (so.status !== previousStatus) {
      if (state.customerEmail) {
        const confirmNumber = state.confirmationNumber || state.orderId;

        if (so.status === "shipped" && so.shipments?.length) {
          const latestShipment = so.shipments[so.shipments.length - 1];
          await sendShippedEmail(
            state.customerEmail,
            state.orderId,
            confirmNumber,
            {
              carrier: latestShipment.carrier,
              trackingNumber: latestShipment.trackingNumber,
              trackingUrl: latestShipment.trackingUrl,
            },
          );
        } else if (so.status === "delivered") {
          await sendDeliveredEmail(
            state.customerEmail,
            state.orderId,
            confirmNumber,
          );
        }
      }

      // Sync ES projection on every status transition
      await syncProjections();
      await signalParentOMSWorkflow(state, so);
      previousStatus = so.status;
    }
  }

  await syncProjections();
}

// ============================================================================
// Supplier Update Handler
// ============================================================================

function handleSupplierUpdate(
  so: FulfillmentSupplierOrderState,
  update: SupplierStatusUpdate,
): void {
  switch (update.status) {
    case "in_production":
      so.status = "in_production";
      so.items.forEach((i) => (i.status = "in_production"));
      break;

    case "partially_shipped":
      so.status = "partially_shipped";
      if (update.lineItems) {
        for (const updateItem of update.lineItems) {
          const stateItem = so.items.find(
            (i) =>
              i.sku === updateItem.supplierLineItemId ||
              i.supplierLineItemId === updateItem.supplierLineItemId,
          );
          if (stateItem && updateItem.status === "shipped") {
            stateItem.status = "shipped";
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

        void indexShipment({
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

    case "shipped":
      so.status = "shipped";
      so.shippedAt = update.timestamp;
      so.items.forEach((i) => (i.status = "shipped"));
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

        void indexShipment({
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

    case "delivered":
      so.status = "delivered";
      so.completedAt = update.timestamp;
      so.items.forEach((i) => (i.status = "delivered"));
      if (so.shipments?.length) {
        so.shipments[so.shipments.length - 1].deliveredAt = update.timestamp;
      }
      break;

    case "cancelled":
      so.status = "cancelled";
      so.items.forEach((i) => (i.status = "cancelled"));
      break;

    case "failed":
      so.status = "failed";
      so.items.forEach((i) => (i.status = "failed"));
      break;
  }
}
