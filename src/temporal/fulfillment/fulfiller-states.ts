/**
 * Fulfiller-order states — the shell around the pure fulfiller-order Decider.
 *
 * The child simulates fulfiller fulfillment: timer-driven auto-progression
 * (received → submitting → in_production → shipped → delivered) unless
 * MANUAL_FULFILLMENT mode is on, in which case webhook/manual `fulfillerStatus`
 * signals drive the transitions. All I/O (the fulfiller submit call, shipment
 * indexing) lives in prepare/finalize; timestamps come from the driver's
 * deterministic `meta.timestamp`.
 */
import * as wf from '@temporalio/workflow';
import { submitFulfillerOrder, indexShipment } from './activities';
import { decide as fulfillerDecide, evolve } from './fulfiller-decider';
import type { FulfillerOrderCommand } from './fulfiller-decider';
import type {
  FulfillerOrderStateName,
  FulfillerOrderSignal,
  FulfillerOrderWorkflowContext,
} from './fulfiller-workflows';
import { defineDomain, terminal, SELF } from '../framework';
import type { StateRegistry } from '../framework';

const fulfiller = defineDomain<
  FulfillerOrderStateName,
  never,
  FulfillerOrderWorkflowContext,
  void,
  FulfillerOrderSignal
>();

/** Shell adapter — run the pure Decider (decide → evolve) for the next context. */
function apply(
  ctx: Readonly<FulfillerOrderWorkflowContext>,
  command: FulfillerOrderCommand,
): FulfillerOrderWorkflowContext {
  const state = ctx as FulfillerOrderWorkflowContext;
  return fulfillerDecide(command, state).reduce(evolve, state);
}

// ==================
// Shared signal entries — cancel and fulfiller webhook/manual updates
// ==================

const cancelEntry = {
  decide(ctx: Readonly<FulfillerOrderWorkflowContext>) {
    const context = apply(ctx, { type: 'cancel' });
    return { context, next: terminal('cancelled') };
  },
};

/** Index the newest shipment when a fulfiller update added one (side effect → finalize). */
async function indexNewestShipment(ctx: FulfillerOrderWorkflowContext): Promise<void> {
  const so = ctx.so;
  if (!so.shipments?.length) return;
  const shipment = so.shipments[so.shipments.length - 1];
  await indexShipment({
    shipmentId: shipment.shipmentId,
    orderId: so.fulfillerOrderId,
    correlationId: ctx.cartId,
    carrier: shipment.carrier,
    trackingNumber: shipment.trackingNumber,
    trackingUrl: shipment.trackingUrl,
    itemCount: shipment.items.length,
    shippedAt: shipment.shippedAt,
    deliveredAt: shipment.deliveredAt,
  });
}

/**
 * Route a fulfiller-status decision by the resulting status.
 *
 * By design: `partially_shipped` routes into the `shipped` state, whose simulation
 * timer auto-delivers the whole order — partials intentionally auto-complete so the
 * demo keeps moving instead of waiting on outstanding items. `manualMode`
 * (MANUAL_FULFILLMENT) is the escape hatch for demos that want to hold partials and
 * drive the remaining updates manually.
 */
function routeByStatus(
  context: FulfillerOrderWorkflowContext,
): FulfillerOrderStateName | `__terminal:${string}` {
  const status = context.so.status;
  if (status === 'shipped' || status === 'partially_shipped') return 'shipped';
  if (status === 'delivered') return terminal('delivered');
  if (status === 'failed') return terminal('failed');
  if (status === 'cancelled') return terminal('cancelled');
  return 'in_production';
}

const fulfillerStatusEntry = {
  decide(
    ctx: Readonly<FulfillerOrderWorkflowContext>,
    signal: Extract<FulfillerOrderSignal, { kind: 'fulfillerStatus' }>,
  ) {
    const context = apply(ctx, { type: 'fulfillerStatus', update: signal.update });
    const addedShipment = (context.so.shipments?.length ?? 0) > (ctx.so.shipments?.length ?? 0);
    return {
      context,
      next: routeByStatus(context),
      finalize: addedShipment ? { indexShipment: true } : undefined,
    };
  },
  async finalize(
    ctx: Readonly<FulfillerOrderWorkflowContext>,
    decision: { context: FulfillerOrderWorkflowContext; finalize?: { indexShipment: boolean } },
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
const received = fulfiller.transitions(
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

/** submitting — submits the order to the (simulated) fulfiller. */
const submitting = fulfiller.transitions(
  'submitting',
  {},
  {
    onTimeout: {
      async prepare(ctx) {
        const result = await submitFulfillerOrder({
          fulfillmentId: wf.workflowInfo().workflowId,
          fulfillerType: 'simulated',
          items: ctx.so.items.map((item) => ({
            sku: item.sku,
            productId: item.productId,
            quantity: item.quantity,
            fulfillerProductId: 'simulated',
            fulfillerVariantId: 0,
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
        // A resolved-but-failed submit must not advance the order (and a missing
        // fulfillerOrderId can't fill the required external id). Throwing here reuses
        // the prepare-throw path: stay in `submitting`, surface the error, let the
        // timeout retry.
        if (!result.success || !result.fulfillerOrderId) {
          throw new Error(result.errorMessage ?? 'fulfiller submit failed');
        }
        return { fulfillerExternalId: result.fulfillerOrderId };
      },
      decide(ctx, meta, prepared: { fulfillerExternalId: string }) {
        const context = apply(ctx, {
          type: 'submitted',
          fulfillerExternalId: prepared.fulfillerExternalId,
          at: meta.timestamp,
        });
        return { context, next: 'in_production' as const };
      },
    },
    onSignals: { cancel: cancelEntry },
  },
);

/** in_production — auto-ships on timeout (unless manual mode); accepts fulfiller updates. */
const inProduction = fulfiller.transitions(
  'in_production',
  {},
  {
    onTimeout: {
      decide(ctx, meta) {
        if (ctx.manualMode) {
          return { context: ctx as FulfillerOrderWorkflowContext, next: SELF };
        }
        const trackingNumber = `SIM${wf.workflowInfo().workflowId.slice(0, 8).toUpperCase()}`;
        const context = apply(ctx, { type: 'simulatedShip', trackingNumber, at: meta.timestamp });
        return { context, next: 'shipped' as const };
      },
    },
    onSignals: {
      cancel: cancelEntry,
      fulfillerStatus: fulfillerStatusEntry,
    },
  },
);

/** shipped — auto-delivers on timeout (unless manual mode); accepts fulfiller updates. */
const shipped = fulfiller.transitions(
  'shipped',
  {},
  {
    onTimeout: {
      // By design: this timer fires for partially-shipped orders too (routeByStatus sends
      // `partially_shipped` here), so partials auto-complete on the simulation timer —
      // the demo favors forward motion over blocking on unshipped items. Set `manualMode`
      // (MANUAL_FULFILLMENT) to suppress the timer and drive delivery manually.
      decide(ctx, meta) {
        if (ctx.manualMode) {
          return { context: ctx as FulfillerOrderWorkflowContext, next: SELF };
        }
        const context = apply(ctx, { type: 'simulatedDeliver', at: meta.timestamp });
        return { context, next: terminal('delivered') };
      },
    },
    onSignals: {
      cancel: cancelEntry,
      fulfillerStatus: fulfillerStatusEntry,
    },
  },
);

/**
 * The fulfiller-order state registry. `in_production`/`shipped` timeouts are placeholders
 * here — {@link buildFulfillerOrderStates} overrides them with the memo-driven simulation
 * delays at workflow start. Exported as a const so the state-diagram generator (static
 * AST analysis over `*_STATES` registries) can discover the machine.
 */
export const FULFILLER_ORDER_STATES: StateRegistry<
  FulfillerOrderStateName,
  never,
  FulfillerOrderWorkflowContext,
  void,
  FulfillerOrderSignal
> = {
  received: { ...received, timeout: '1 millisecond' },
  submitting: { ...submitting, timeout: '1 millisecond' },
  in_production: { ...inProduction },
  shipped: { ...shipped },
};

/**
 * Build the runtime registry with the simulation delays supplied by the workflow (they
 * come from workflow memo, so the timeouts are only known at run time).
 */
export function buildFulfillerOrderStates(delays: {
  processingDelayMs: number;
  shippingDelayMs: number;
  deliveryDelayMs: number;
}): StateRegistry<
  FulfillerOrderStateName,
  never,
  FulfillerOrderWorkflowContext,
  void,
  FulfillerOrderSignal
> {
  return {
    ...FULFILLER_ORDER_STATES,
    in_production: {
      ...FULFILLER_ORDER_STATES.in_production,
      timeout: `${delays.processingDelayMs}ms`,
    },
    shipped: {
      ...FULFILLER_ORDER_STATES.shipped,
      timeout: `${delays.shippingDelayMs + delays.deliveryDelayMs}ms`,
    },
  };
}
