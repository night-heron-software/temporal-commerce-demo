/**
 * Supplier-order states — the shell around the pure supplier-order Decider.
 *
 * The child simulates supplier fulfillment: timer-driven auto-progression
 * (received → submitting → in_production → shipped → delivered) unless
 * MANUAL_FULFILLMENT mode is on, in which case webhook/manual `supplierStatus`
 * signals drive the transitions. All I/O (the supplier submit call, shipment
 * indexing) lives in prepare/finalize; timestamps come from the driver's
 * deterministic `meta.timestamp`.
 */
import * as wf from '@temporalio/workflow';
import { submitSupplierOrder, indexShipment } from './activities';
import { decide as supplierDecide, evolve } from './supplier-decider';
import type { SupplierOrderCommand } from './supplier-decider';
import type {
  SupplierOrderStateName,
  SupplierOrderSignal,
  SupplierOrderWorkflowContext,
} from './supplier-workflows';
import { defineDomain, terminal, SELF } from '../framework';
import type { StateRegistry } from '../framework';

const supplier = defineDomain<
  SupplierOrderStateName,
  never,
  SupplierOrderWorkflowContext,
  void,
  SupplierOrderSignal
>();

/** Shell adapter — run the pure Decider (decide → evolve) for the next context. */
function apply(
  ctx: Readonly<SupplierOrderWorkflowContext>,
  command: SupplierOrderCommand,
): SupplierOrderWorkflowContext {
  const state = ctx as SupplierOrderWorkflowContext;
  return supplierDecide(command, state).reduce(evolve, state);
}

// ==================
// Shared signal entries — cancel and supplier webhook/manual updates
// ==================

const cancelEntry = {
  decide(ctx: Readonly<SupplierOrderWorkflowContext>) {
    const context = apply(ctx, { type: 'cancel' });
    return { context, next: terminal('cancelled') };
  },
};

/** Index the newest shipment when a supplier update added one (side effect → finalize). */
async function indexNewestShipment(ctx: SupplierOrderWorkflowContext): Promise<void> {
  const so = ctx.so;
  if (!so.shipments?.length) return;
  const shipment = so.shipments[so.shipments.length - 1];
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

/** Route a supplier-status decision by the resulting status. */
function routeByStatus(
  context: SupplierOrderWorkflowContext,
): SupplierOrderStateName | `__terminal:${string}` {
  const status = context.so.status;
  if (status === 'shipped' || status === 'partially_shipped') return 'shipped';
  if (status === 'delivered') return terminal('delivered');
  if (status === 'failed') return terminal('failed');
  if (status === 'cancelled') return terminal('cancelled');
  return 'in_production';
}

const supplierStatusEntry = {
  decide(
    ctx: Readonly<SupplierOrderWorkflowContext>,
    signal: Extract<SupplierOrderSignal, { kind: 'supplierStatus' }>,
  ) {
    const context = apply(ctx, { type: 'supplierStatus', update: signal.update });
    const addedShipment =
      (context.so.shipments?.length ?? 0) > (ctx.so.shipments?.length ?? 0);
    return {
      context,
      next: routeByStatus(context),
      finalize: addedShipment ? { indexShipment: true } : undefined,
    };
  },
  async finalize(
    ctx: Readonly<SupplierOrderWorkflowContext>,
    decision: { context: SupplierOrderWorkflowContext; finalize?: { indexShipment: boolean } },
  ) {
    if (decision.finalize?.indexShipment) {
      await indexNewestShipment(decision.context);
    }
  },
};

// ==================
// States
// ==================

/** received — book-keeping hop; marks the order as submitting. */
const received = supplier.transitions(
  'received',
  {},
  {
    onTimeout: {
      decide(ctx) {
        const draft = { ...ctx, so: { ...ctx.so, status: 'submitting' as const } };
        return { context: draft, next: 'submitting' as const };
      },
    },
    onSignals: { cancel: cancelEntry },
  },
);

/** submitting — submits the order to the (simulated) supplier. */
const submitting = supplier.transitions(
  'submitting',
  {},
  {
    onTimeout: {
      async prepare(ctx) {
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
        return { supplierExternalId: result.supplierOrderId };
      },
      decide(ctx, meta, prepared: { supplierExternalId: string }) {
        const context = apply(ctx, {
          type: 'submitted',
          supplierExternalId: prepared.supplierExternalId,
          at: meta.timestamp,
        });
        return { context, next: 'in_production' as const };
      },
    },
    onSignals: { cancel: cancelEntry },
  },
);

/** in_production — auto-ships on timeout (unless manual mode); accepts supplier updates. */
const inProduction = supplier.transitions(
  'in_production',
  {},
  {
    onTimeout: {
      decide(ctx, meta) {
        if (ctx.manualMode) {
          return { context: ctx as SupplierOrderWorkflowContext, next: SELF };
        }
        const trackingNumber = `SIM${wf.workflowInfo().workflowId.slice(0, 8).toUpperCase()}`;
        const context = apply(ctx, { type: 'autoShipped', trackingNumber, at: meta.timestamp });
        return { context, next: 'shipped' as const };
      },
    },
    onSignals: {
      cancel: cancelEntry,
      supplierStatus: supplierStatusEntry,
    },
  },
);

/** shipped — auto-delivers on timeout (unless manual mode); accepts supplier updates. */
const shipped = supplier.transitions(
  'shipped',
  {},
  {
    onTimeout: {
      decide(ctx, meta) {
        if (ctx.manualMode) {
          return { context: ctx as SupplierOrderWorkflowContext, next: SELF };
        }
        const context = apply(ctx, { type: 'autoDelivered', at: meta.timestamp });
        return { context, next: terminal('delivered') };
      },
    },
    onSignals: {
      cancel: cancelEntry,
      supplierStatus: supplierStatusEntry,
    },
  },
);

/**
 * Build the registry with the simulation delays supplied by the workflow (they come from
 * workflow memo, so the registry is assembled at run time).
 */
export function buildSupplierOrderStates(delays: {
  processingDelayMs: number;
  shippingDelayMs: number;
  deliveryDelayMs: number;
}): StateRegistry<
  SupplierOrderStateName,
  never,
  SupplierOrderWorkflowContext,
  void,
  SupplierOrderSignal
> {
  return {
    received: { ...received, timeout: '1 millisecond' },
    submitting: { ...submitting, timeout: '1 millisecond' },
    in_production: { ...inProduction, timeout: `${delays.processingDelayMs}ms` },
    shipped: { ...shipped, timeout: `${delays.shippingDelayMs + delays.deliveryDelayMs}ms` },
  };
}
