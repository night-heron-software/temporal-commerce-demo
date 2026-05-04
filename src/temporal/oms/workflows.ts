import {
  allHandlersFinished,
  condition,
  continueAsNew,
  getExternalWorkflowHandle,
  log,
  setHandler,
  startChild,
  uuid4
} from '@temporalio/workflow';
const getFeatureFlag = async (flag: string) => false;
import { OrderLineItem } from '../contracts';
import {
  saveOrderToDatabase,
  updateOrderInDatabase,
  sendOrderStatusEmail,
  sendFeedbackThankYouEmail,
  resolveSupplierAssignments,
  insertStatusHistoryEntry,
  indexOrder,
  indexSupplierOrder
} from './activities';
import {
  OrderState,
  OrderWorkflowInput,
  StatusHistoryEntry,
  SupplierOrder
} from './types';
import { buildOrderDocument, buildSupplierOrderDocument } from './document-builder';

import { defineSignal } from '@temporalio/workflow';
type FulfillmentSupplierOrderInput = any;
type FulfillmentItem = any;
const fulfillmentCancelSignal = defineSignal('cancel');
const FULFILLMENT_TASK_QUEUE_NAME = 'fulfillment-queue';

// Import definitions from the dedicated definitions file
import {
  updateStatusUpdate,
  cancelOrderUpdate,
  submitFeedbackUpdate,
  getOrderStateQuery,
  fulfillmentStatusSignal
} from './definitions';

// Re-export definitions for backward compatibility with workers
export {
  updateStatusUpdate,
  cancelOrderUpdate,
  submitFeedbackUpdate,
  getOrderStateQuery,
  fulfillmentStatusSignal
};


// ==================
// Order Workflow
// ==================

export async function orderWorkflow(input: OrderWorkflowInput): Promise<OrderState> {
  log.info('[OMS] orderWorkflow started', {
    orderId: input.order.orderId,
    cartId: input.order.cartId,
    itemCount: input.order.items.length,
    customerEmail: input.customerEmail
  });

  const dataFlowEnabled = await getFeatureFlag('DATA_FLOW_LOGGING');

  const state: OrderState = {
    order: input.order,
    status: 'pending_assignment',
    statusHistory: [
      {
        status: 'pending_assignment',
        timestamp: new Date().toISOString(),
        updatedBy: 'system'
      }
    ],
    assignments: [],
    supplierOrders: []
  };

  let isComplete = false;
  let isCancelled = false;

  // Continue-as-New: signal counter to prevent unbounded history growth
  const CONTINUE_AS_NEW_THRESHOLD = 200;
  let signalCount = input.signalCount || 0;

  // Non-blocking projection sync: dirty flag for main loop
  let projectionDirty = false;
  const supplierOrdersToIndex: string[] = [];
  function syncProjections(supplierOrderId?: string): void {
    projectionDirty = true;
    if (supplierOrderId) {
      supplierOrdersToIndex.push(supplierOrderId);
    }
  }

  // Standard Update Handler Lifecycle: centralized post-mutation helper
  const finalizeUpdate = (supplierOrderId?: string) => {
    state.updatedAt = new Date().toISOString();
    syncProjections(supplierOrderId);
    signalCount++;
  };

  // Restore state from Continue-as-New if applicable
  const isResumed = !!input.restoredState;
  if (isResumed) {
    Object.assign(state, input.restoredState);
    log.info('[OMS] Resumed from Continue-as-New', { status: state.status, signalCount });
  }

  // Skip initial persistence on Continue-as-New resume
  if (!isResumed) {
    // Persist order to database
    log.info('[OMS] Saving order to database');
    await saveOrderToDatabase(input.order);

    // Persist initial status history entry
    await insertStatusHistoryEntry(input.order.storeId, input.order.orderId, state.statusHistory[0]);
  }

  // Helper to build OrderDocument from current state
  const getOrderDocument = () => buildOrderDocument(input.order.storeId, input.order, state, input.customerEmail);

  // Index order to Elasticsearch (always, even on resume)
  await indexOrder(getOrderDocument());

  // Skip auto-assignment and fulfillment trigger on Continue-as-New resume
  if (!isResumed) {
    // ============================================================================
    
    // ============================================================================
    // AUTO-ASSIGNMENT: Resolve supplier assignments via plugins
    // ============================================================================
    const lineItems: OrderLineItem[] = input.order.items.map((item: any) => ({
      lineItemId: item.lineItemId,
      variantId: item.variantId,
      productId: item.productId || 'unknown',
      quantity: item.quantity,
      productTitle: item.title || 'Unknown Product',
      variantTitle: item.variantTitle || 'Unknown Variant',
      unitPrice: item.price,
      currency: input.order.currency
    }));
    
    log.info('[OMS] Resolving supplier assignments', { itemCount: lineItems.length });
    const assignments = await resolveSupplierAssignments(lineItems, { storeId: input.order.storeId, preferredSuppliers: [] });
    
    // Auto-assign all items based on plugin resolution
    for (let i = 0; i < input.order.items.length; i++) {
      const item = input.order.items[i];
      const assignment = assignments[i];
      
      state.assignments.push({
        assignmentId: `asg-${uuid4().slice(0, 8)}`,
        lineItemId: item.lineItemId,
        variantId: item.variantId,
        supplierId: assignment.supplierId,
        supplierName: assignment.supplierName,
        quantity: item.quantity,
        status: 'assigned'
      });
    }

    const printifyDynamicCount = state.assignments.filter(a => a.supplierId === 'printify-dynamic').length;
    const simulatedCount = state.assignments.filter(a => a.supplierId === 'simulated').length;
    log.info('[OMS] Auto-assignment complete', {
      totalAssignments: state.assignments.length,
      printifyDynamic: printifyDynamicCount,
      simulated: simulatedCount
    });
    if (dataFlowEnabled) {
      log.info('[DataFlow] T6: Order → OrderAssignment[] — mid.assignments', {
        dataFlow: true, stage: 'T6: Order → FulfillmentOrderRequest', label: 'mid.OrderAssignment[]',
        data: JSON.stringify(state.assignments, null, 2)
      });
    }

    // All items are now assigned, move to ready_to_fulfill
    state.status = 'ready_to_fulfill';
    const readyEntry: StatusHistoryEntry = {
      status: 'ready_to_fulfill',
      timestamp: new Date().toISOString(),
      note: 'All items auto-assigned',
      updatedBy: 'system'
    };
    state.statusHistory.push(readyEntry);

    // Persist assignments to database
    await updateOrderInDatabase(input.order.storeId, input.order.orderId, {
      status: state.status,
      statusHistory: state.statusHistory,
      assignments: state.assignments
    });
    await insertStatusHistoryEntry(input.order.storeId, input.order.orderId, readyEntry);

    // Auto-trigger fulfillment
    log.info('[OMS] Triggering fulfillment');
    await triggerFulfillment(state, input, 'system', dataFlowEnabled);
    log.info('[OMS] Fulfillment triggered, entering main loop', {
      status: state.status,
      supplierOrderCount: state.supplierOrders.length
    });
  }

  // Query for current order state
  setHandler(getOrderStateQuery, () => state);

  // Handle fulfillment status updates from child workflow
  setHandler(fulfillmentStatusSignal, async (update) => {
    log.info('[OMS] Received fulfillment status signal', {
      supplierOrderId: update.supplierOrderId,
      status: update.status,
      carrier: update.carrier,
      trackingNumber: update.trackingNumber
    });

    // Find the matching supplier order
    const supplierOrder = state.supplierOrders.find(
      (so) => so.supplierOrderId === update.supplierOrderId
    );

    if (!supplierOrder) {
      log.warn('[OMS] Received fulfillment status for unknown supplier order', {
        supplierOrderId: update.supplierOrderId
      });
      return;
    }

    // Mirror supplier order status from fulfillment
    supplierOrder.status = update.status;
    supplierOrder.updatedAt = new Date().toISOString();

    if (update.carrier) {
      supplierOrder.carrier = update.carrier;
    }
    if (update.trackingNumber) {
      supplierOrder.trackingNumber = update.trackingNumber;
    }
    if (update.trackingUrl) {
      supplierOrder.trackingUrl = update.trackingUrl;
    }

    supplierOrder.statusHistory.push({
      status: update.status,
      timestamp: new Date().toISOString(),
      note: update.error || `Status updated from fulfillment workflow`
    });

    // Update corresponding assignment statuses
    for (const item of supplierOrder.items) {
      const assignment = state.assignments.find((a) => a.assignmentId === item.assignmentId);
      if (assignment) {
        if (update.status === 'shipped') {
          assignment.status = 'shipped';
          if (update.carrier) {
            assignment.carrier = update.carrier;
          }
        } else if (update.status === 'delivered') {
          assignment.status = 'delivered';
        } else if (update.status === 'rejected') {
          assignment.status = 'rejected';
        }
      }
    }

    // Propagate order-level status changes
    if (update.status === 'shipped' && state.status === 'processing') {
      const allShipped = state.supplierOrders.every(
        (so) => so.status === 'shipped' || so.status === 'delivered' || so.status === 'rejected'
      );
      if (allShipped) {
        state.status = 'shipped';
        const shippedEntry: StatusHistoryEntry = {
          status: 'shipped',
          timestamp: new Date().toISOString(),
          note: 'All supplier orders shipped',
          updatedBy: 'system'
        };
        state.statusHistory.push(shippedEntry);
        await insertStatusHistoryEntry(input.order.storeId, input.order.orderId, shippedEntry);
      }
    } else if (update.status === 'delivered' && (state.status === 'shipped' || state.status === 'processing')) {
      const allDelivered = state.supplierOrders.every(
        (so) => so.status === 'delivered' || so.status === 'rejected'
      );
      if (allDelivered) {
        state.status = 'delivered';
        state.deliveredAt = new Date().toISOString();
        const deliveredEntry: StatusHistoryEntry = {
          status: 'delivered',
          timestamp: new Date().toISOString(),
          note: 'All supplier orders delivered',
          updatedBy: 'system'
        };
        state.statusHistory.push(deliveredEntry);
        await insertStatusHistoryEntry(input.order.storeId, input.order.orderId, deliveredEntry);
      }
    }

    // Persist updates
    await updateOrderInDatabase(input.order.storeId, input.order.orderId, {
      status: state.status,
      statusHistory: state.statusHistory,
      assignments: state.assignments,
      supplierOrders: state.supplierOrders
    });

    finalizeUpdate(supplierOrder.supplierOrderId);
  });

  // Update order status
  setHandler(updateStatusUpdate, async (signal) => {
    log.info('[OMS] updateStatusUpdate received', { newStatus: signal.status, note: signal.note, updatedBy: signal.updatedBy });
    state.status = signal.status;

    const historyEntry: StatusHistoryEntry = {
      status: signal.status,
      timestamp: new Date().toISOString(),
      note: signal.note,
      updatedBy: signal.updatedBy
    };
    state.statusHistory.push(historyEntry);
    await insertStatusHistoryEntry(input.order.storeId, input.order.orderId, historyEntry);

    await updateOrderInDatabase(input.order.storeId, input.order.orderId, {
      status: signal.status,
      statusHistory: state.statusHistory
    });

    finalizeUpdate();

    // Send status email for significant changes
    if (['shipped', 'delivered', 'cancelled', 'refunded'].includes(signal.status)) {
      await sendOrderStatusEmail(input.customerEmail, input.order.orderId, signal.status, {});
    }

    if (signal.status === 'delivered') {
      state.deliveredAt = new Date().toISOString();
    }

    if (signal.status === 'complete') {
      isComplete = true;
    }

    if (signal.status === 'cancelled' || signal.status === 'refunded') {
      // Signal fulfillment workflow to cancel (it will release inventory)
      try {
        const fulfillmentWorkflowId = `${input.order.storeId}-fulfillment-${input.order.orderId}`;
        const handle = getExternalWorkflowHandle(fulfillmentWorkflowId);
        await handle.signal(fulfillmentCancelSignal);
        log.info('[OMS] Sent cancel signal to fulfillment workflow');
      } catch (e) {
        log.warn('[OMS] Failed to signal fulfillment cancel (may have already completed)', { error: String(e) });
      }
      isCancelled = true;
    }

    return state;
  });

  // Cancel order
  setHandler(cancelOrderUpdate, async (signal) => {
    log.info('[OMS] cancelOrderUpdate received', { reason: signal.reason });
    state.status = 'cancelled';

    const historyEntry: StatusHistoryEntry = {
      status: 'cancelled',
      timestamp: new Date().toISOString(),
      note: signal.reason || 'Order cancelled',
      updatedBy: 'admin'
    };
    state.statusHistory.push(historyEntry);
    await insertStatusHistoryEntry(input.order.storeId, input.order.orderId, historyEntry);

    await updateOrderInDatabase(input.order.storeId, input.order.orderId, {
      status: 'cancelled',
      statusHistory: state.statusHistory
    });

    await sendOrderStatusEmail(input.customerEmail, input.order.orderId, 'cancelled', {});

    // Signal fulfillment workflow to cancel (it will release inventory)
    try {
      const fulfillmentWorkflowId = `${input.order.storeId}-fulfillment-${input.order.orderId}`;
      const handle = getExternalWorkflowHandle(fulfillmentWorkflowId);
      await handle.signal(fulfillmentCancelSignal);
      log.info('[OMS] Sent cancel signal to fulfillment workflow');
    } catch (e) {
      log.warn('[OMS] Failed to signal fulfillment cancel (may have already completed)', { error: String(e) });
    }

    isCancelled = true;
    finalizeUpdate();
    return state;
  });

  // Submit customer feedback
  setHandler(submitFeedbackUpdate, async (signal) => {
    state.customerFeedback = {
      rating: signal.rating,
      comment: signal.comment,
      submittedAt: new Date().toISOString()
    };

    await updateOrderInDatabase(input.order.storeId, input.order.orderId, {
      customerFeedback: state.customerFeedback
    });

    await sendFeedbackThankYouEmail(input.customerEmail, input.order.orderId);

    state.status = 'complete';
    const completeEntry: StatusHistoryEntry = {
      status: 'complete',
      timestamp: new Date().toISOString(),
      note: 'Customer submitted feedback',
      updatedBy: 'customer'
    };
    state.statusHistory.push(completeEntry);
    await insertStatusHistoryEntry(input.order.storeId, input.order.orderId, completeEntry);

    isComplete = true;
    finalizeUpdate();
    return state;
  });

  // Main loop: keep running until complete or cancelled, flushing projections
  while (!isComplete && !isCancelled) {
    await condition(() => isComplete || isCancelled || projectionDirty, '365 days');

    log.info('[OMS] Main loop woke', { isComplete, isCancelled, projectionDirty, signalCount });
    if (projectionDirty) {
      projectionDirty = false;
      await indexOrder(getOrderDocument());
      for (const soId of supplierOrdersToIndex.splice(0)) {
        const so = state.supplierOrders.find(s => s.supplierOrderId === soId);
        if (so) await indexSupplierOrder(buildSupplierOrderDocument(input.order.storeId, so));
      }
    }

    // Continue-as-New if signal threshold reached
    if (signalCount >= CONTINUE_AS_NEW_THRESHOLD && !isComplete && !isCancelled) {
      log.info('[OMS] Signal threshold reached, continuing as new', { signalCount });
      await condition(allHandlersFinished);
      await continueAsNew<typeof orderWorkflow>({
        ...input,
        restoredState: state,
        signalCount: 0
      });
    }
  }
  log.info('[OMS] Exited main loop', { finalStatus: state.status });
  await condition(allHandlersFinished);

  // Final projection flush
  if (projectionDirty) {
    projectionDirty = false;
    await indexOrder(getOrderDocument());
    for (const soId of supplierOrdersToIndex.splice(0)) {
      const so = state.supplierOrders.find(s => s.supplierOrderId === soId);
      if (so) await indexSupplierOrder(buildSupplierOrderDocument(input.order.storeId, so));
    }
  }

  return state;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Trigger fulfillment for all assigned items.
 * Groups assignments by supplier, builds SupplierOrder records,
 * then starts a SINGLE fulfillment child workflow with all supplier orders.
 */
async function triggerFulfillment(
  state: OrderState,
  input: OrderWorkflowInput,
  updatedBy: 'admin' | 'system',
  dataFlowEnabled: boolean = false
): Promise<void> {
  // Group assignments by supplierId
  const bySupplier: Record<string, typeof state.assignments> = {};
  for (const assignment of state.assignments) {
    if (!bySupplier[assignment.supplierId]) {
      bySupplier[assignment.supplierId] = [];
    }
    bySupplier[assignment.supplierId].push(assignment);
  }

  log.info('[OMS] triggerFulfillment grouping', { supplierIds: Object.keys(bySupplier) });

  // Build SupplierOrder records and fulfillment inputs
  const fulfillmentSupplierOrders: FulfillmentSupplierOrderInput[] = [];

  for (const [supplierId, assignments] of Object.entries(bySupplier)) {
    const supplierOrderId = `so-${uuid4().slice(0, 8)}`;
    const isSimulated = supplierId === 'simulated';
    log.info('[OMS] Creating supplier order', { supplierOrderId, supplierId, itemCount: assignments.length, isSimulated });

    // Build OMS SupplierOrder (stays in OMS state)
    const supplierOrder: SupplierOrder = {
      supplierOrderId,
      orderId: input.order.orderId,
      supplierId,
      supplierName: assignments[0].supplierName || supplierId,
      status: 'pending',
      items: assignments.map((a) => ({
        assignmentId: a.assignmentId,
        variantId: a.variantId,
        quantity: a.quantity
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      statusHistory: [
        {
          status: 'pending',
          timestamp: new Date().toISOString(),
          note: 'Supplier order created'
        }
      ]
    };
    state.supplierOrders.push(supplierOrder);

    // Index supplier order to Elasticsearch
    await indexSupplierOrder(buildSupplierOrderDocument(input.order.storeId, supplierOrder));

    // Update assignment references
    for (const assignment of assignments) {
      assignment.supplierOrderId = supplierOrderId;
      assignment.status = 'fulfilled';
    }

    // Build fulfillment items from order items
    const fulfillmentItems: FulfillmentItem[] = assignments.map((a) => {
      const orderItem = input.order.items.find((i: any) => i.variantId === a.variantId);
      return {
        sku: a.variantId,
        productId: a.variantId,
        variantId: a.variantId,
        quantity: a.quantity,
        unitPrice: orderItem?.price ?? 0,
        title: `Item ${a.variantId.slice(0, 8)}`
      };
    });

    fulfillmentSupplierOrders.push({
      supplierOrderId,
      supplierId,
      supplierType: isSimulated ? 'simulated' : (supplierId as 'printify-dynamic'),
      items: fulfillmentItems
    });
  }

  if (dataFlowEnabled) {
    log.info('[DataFlow] T6: Order → FulfillmentOrderRequest — output.FulfillmentSupplierOrderInput[]', {
      dataFlow: true, stage: 'T6: Order → FulfillmentOrderRequest', label: 'output.FulfillmentSupplierOrderInput[]',
      data: JSON.stringify(fulfillmentSupplierOrders, null, 2)
    });
  }

  // Start SINGLE fulfillment child workflow with all supplier orders
  const fulfillmentWorkflowId = `${input.order.storeId}-fulfillment-${input.order.orderId}`;
  log.info('[OMS] Starting fulfillment child workflow', {
    workflowId: fulfillmentWorkflowId,
    taskQueue: FULFILLMENT_TASK_QUEUE_NAME,
    supplierOrderCount: fulfillmentSupplierOrders.length
  });

  await startChild('fulfillmentWorkflow', {
    workflowId: fulfillmentWorkflowId,
    args: [{
      storeId: input.order.storeId,
      orderId: input.order.orderId,
      cartId: input.order.cartId,
      customerId: input.customerEmail,
      customerEmail: input.customerEmail,
      confirmationNumber: input.order.confirmationNumber,
      shippingAddress: {
        firstName: input.order.shippingAddress.firstName,
        lastName: input.order.shippingAddress.lastName,
        email: input.customerEmail,
        phone: input.order.shippingAddress.phone,
        address1: input.order.shippingAddress.address1,
        address2: input.order.shippingAddress.address2,
        city: input.order.shippingAddress.city,
        region: input.order.shippingAddress.state,
        zip: input.order.shippingAddress.postalCode,
        country: input.order.shippingAddress.country
      },
      shippingMethod: 'standard',
      supplierOrders: fulfillmentSupplierOrders
    }],
    taskQueue: FULFILLMENT_TASK_QUEUE_NAME,
    workflowExecutionTimeout: '90 days'
  });

  // Mark all supplier orders as processing
  for (const supplierOrder of state.supplierOrders) {
    supplierOrder.status = 'processing';
    supplierOrder.statusHistory.push({
      status: 'processing',
      timestamp: new Date().toISOString(),
      note: 'Submitted to fulfillment workflow'
    });
    await indexSupplierOrder(buildSupplierOrderDocument(input.order.storeId, supplierOrder));
  }

  state.status = 'processing';
  const processingEntry: StatusHistoryEntry = {
    status: 'processing',
    timestamp: new Date().toISOString(),
    note: `Fulfilled via ${Object.keys(bySupplier).length} supplier(s)`,
    updatedBy
  };
  state.statusHistory.push(processingEntry);
  await insertStatusHistoryEntry(input.order.storeId, input.order.orderId, processingEntry);

  await updateOrderInDatabase(input.order.storeId, input.order.orderId, {
    status: state.status,
    statusHistory: state.statusHistory,
    assignments: state.assignments,
    supplierOrders: state.supplierOrders
  });

  await indexOrder(buildOrderDocument(input.order.storeId, input.order, state, input.customerEmail));
}
