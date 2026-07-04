import { log, setHandler, uuid4 } from '@temporalio/workflow';
import { OrderLineItem, Cart } from '../contracts';
type CartItem = Cart.CartItem;
import {
  saveOrderToDatabase,
  updateOrderInDatabase,
  resolveSupplierAssignments,
  insertStatusHistoryEntry,
  indexOrder,
  indexSupplierOrder,
  indexCustomer,
  startFulfillmentWorkflow
} from './activities';
import {
  OrderState,
  OrderEvent,
  OrderWorkflowInput,
  OmsStateName,
  OmsWorkflowContext,
  StatusHistoryEntry,
  SupplierOrder,
  FulfillmentStatusUpdate,
  UpdateStatusSignal,
  CancelOrderSignal,
  SubmitFeedbackSignal
} from './types';
import { buildOrderDocument, buildSupplierOrderDocument } from './document-builder';

import type { FulfillmentSupplierOrderInput, FulfillmentItem } from '../contracts/fulfillment';

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

import { runStateMachine, StateMachineConfig, MappedUpdateRegistration } from '../framework';
import { OMS_STATES } from './states';

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

  let ctx: OmsWorkflowContext = {
    customerEmail: input.customerEmail,
    state: {
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
    }
  };

  // Query for current order state (reads the driver-owned context)
  setHandler(getOrderStateQuery, () => ctx.state);

  // Helper to build OrderDocument from current state
  const getOrderDocument = (state: OrderState) =>
    buildOrderDocument(input.order, state, input.customerEmail);

  const config: StateMachineConfig<
    OmsStateName,
    OrderEvent,
    OmsWorkflowContext,
    OrderState,
    FulfillmentStatusUpdate
  > = {
    states: OMS_STATES,
    initialState: 'processing',
    // Startup pipeline: persist, index, auto-assign, trigger fulfillment — then wait.
    onStart: async (startCtx: OmsWorkflowContext) => {
      const state = startCtx.state;

      // Persist order to database
      log.info('[OMS] Saving order to database');
      await saveOrderToDatabase(input.order);

      // Persist initial status history entry
      await insertStatusHistoryEntry(input.order.orderId, state.statusHistory[0]);

      // Index order to Elasticsearch
      await indexOrder(getOrderDocument(state));

      // Index/upsert customer to Elasticsearch
      await indexCustomer({
        email: input.customerEmail,
        firstName: input.order.shippingAddress.firstName,
        lastName: input.order.shippingAddress.lastName,
        phone: input.order.shippingAddress.phone || '',
        totalSpent: input.order.total,
        orderCount: 1,
        lastOrderAt: new Date().toISOString()
      });

      // ── AUTO-ASSIGNMENT: Resolve supplier assignments via plugins ──
      const lineItems: OrderLineItem[] = input.order.items.map((item) => {
        // CartItem may carry extra fields at runtime (productId, title) from checkout
        const ext = item as CartItem & { productId?: string; title?: string; variantTitle?: string };
        return {
          lineItemId: item.lineItemId,
          variantId: item.variantId,
          productId: ext.productId || 'unknown',
          quantity: item.quantity,
          productTitle: ext.title || 'Unknown Product',
          variantTitle: ext.variantTitle || 'Unknown Variant',
          unitPrice: item.price,
          currency: input.order.currency
        } as OrderLineItem;
      });

      log.info('[OMS] Resolving supplier assignments', { itemCount: lineItems.length });
      const assignments = await resolveSupplierAssignments(lineItems, { preferredSuppliers: [] });

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

      const simulatedCount = state.assignments.filter(
        (a) => a.supplierId === 'default-supplier' || a.supplierId === 'simulated'
      ).length;
      log.info('[OMS] Auto-assignment complete', {
        totalAssignments: state.assignments.length,
        simulated: simulatedCount
      });

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
      await updateOrderInDatabase(input.order.orderId, {
        status: state.status,
        statusHistory: state.statusHistory,
        assignments: state.assignments
      });
      await insertStatusHistoryEntry(input.order.orderId, readyEntry);

      // Trigger fulfillment
      log.info('[OMS] Triggering fulfillment');
      await triggerFulfillment(state, input, 'system');
      log.info('[OMS] Fulfillment triggered, entering main loop', {
        status: state.status,
        supplierOrderCount: state.supplierOrders.length
      });

      return { context: startCtx, nextState: 'processing' as const };
    },
    onContextUpdate: (newCtx: OmsWorkflowContext) => {
      ctx = newCtx;
    },
    // Projection sync after every transition (replaces the old dirty-flag loop).
    onTransition: async (_from, _to, _event, currentCtx: OmsWorkflowContext) => {
      await indexOrder(getOrderDocument(currentCtx.state));
      for (const so of currentCtx.state.supplierOrders) {
        await indexSupplierOrder(buildSupplierOrderDocument(so));
      }
    },
    onTerminal: async (finalCtx: OmsWorkflowContext) => {
      log.info('[OMS] Reached terminal state', { finalStatus: finalCtx.state.status });
      await indexOrder(getOrderDocument(finalCtx.state));
      for (const so of finalCtx.state.supplierOrders) {
        await indexSupplierOrder(buildSupplierOrderDocument(so));
      }
    }
  };

  const updateHandlers: MappedUpdateRegistration<OrderEvent, OmsWorkflowContext, OrderState>[] = [
    {
      definition: updateStatusUpdate,
      toEvent: (s: UpdateStatusSignal) => ({ type: 'updateStatus', ...s })
    },
    {
      definition: cancelOrderUpdate,
      toEvent: (s: CancelOrderSignal) => ({ type: 'cancelOrder', reason: s.reason })
    },
    {
      definition: submitFeedbackUpdate,
      toEvent: (s: SubmitFeedbackSignal) => ({ type: 'submitFeedback', rating: s.rating, comment: s.comment })
    }
  ];

  ctx = await runStateMachine<
    OmsStateName,
    OrderEvent,
    OmsWorkflowContext,
    OrderState,
    FulfillmentStatusUpdate
  >(config, ctx, updateHandlers, fulfillmentStatusSignal);

  return ctx.state;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Trigger fulfillment for all assigned items.
 * Groups assignments by supplier, builds SupplierOrder records,
 * then starts a standalone fulfillment workflow via activity.
 */
async function triggerFulfillment(
  state: OrderState,
  input: OrderWorkflowInput,
  updatedBy: 'admin' | 'system'
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
    const isSimulated = supplierId === 'default-supplier' || supplierId === 'simulated';
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
    await indexSupplierOrder(buildSupplierOrderDocument(supplierOrder));

    // Update assignment references
    for (const assignment of assignments) {
      assignment.supplierOrderId = supplierOrderId;
      assignment.status = 'fulfilled';
    }

    // Build fulfillment items from order items
    const fulfillmentItems: FulfillmentItem[] = assignments.map((a) => {
      const orderItem = input.order.items.find((i) => i.variantId === a.variantId);
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
      supplierType: 'simulated',
      items: fulfillmentItems
    });
  }

  // Start standalone fulfillment workflow via activity
  const fulfillmentInput = {
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
  };

  log.info('[OMS] Starting fulfillment workflow via activity', {
    orderId: input.order.orderId,
    supplierOrderCount: fulfillmentSupplierOrders.length
  });

  await startFulfillmentWorkflow(fulfillmentInput);

  // Mark all supplier orders as processing
  for (const supplierOrder of state.supplierOrders) {
    supplierOrder.status = 'processing';
    supplierOrder.statusHistory.push({
      status: 'processing',
      timestamp: new Date().toISOString(),
      note: 'Submitted to fulfillment workflow'
    });
    await indexSupplierOrder(buildSupplierOrderDocument(supplierOrder));
  }

  state.status = 'processing';
  const processingEntry: StatusHistoryEntry = {
    status: 'processing',
    timestamp: new Date().toISOString(),
    note: `Fulfilled via ${Object.keys(bySupplier).length} supplier(s)`,
    updatedBy
  };
  state.statusHistory.push(processingEntry);
  await insertStatusHistoryEntry(input.order.orderId, processingEntry);

  await updateOrderInDatabase(input.order.orderId, {
    status: state.status,
    statusHistory: state.statusHistory,
    assignments: state.assignments,
    supplierOrders: state.supplierOrders
  });

  await indexOrder(buildOrderDocument(input.order, state, input.customerEmail));
}
