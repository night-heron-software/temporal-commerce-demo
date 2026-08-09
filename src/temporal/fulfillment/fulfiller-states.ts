/**
 * The fulfiller-order (child) machine — ADR-0024 decider-native surface.
 *
 * The child simulates fulfiller fulfillment: timer-driven auto-progression
 * (received → submitting → in_production → shipped → delivered) unless
 * MANUAL_FULFILLMENT mode is on, in which case `onTimeout` returns null (idle tick)
 * and webhook/manual `fulfillerStatus` commands drive the transitions. All I/O (the
 * fulfiller submit call, shipment indexing, customer emails) lives in `prepare`
 * phases and event-keyed effects; timestamps come from the framework's deterministic
 * `meta.timestamp`. Every routed outcome is an event the decider emitted.
 */
import * as wf from '@temporalio/workflow';
import type { Fulfillers } from '../contracts';
import { defineMachine, terminal, SELF } from '../framework';
import type { EffectsMap, StateRegistry } from '../framework';
import { fulfillerDecider } from './fulfiller-decider';
import type { FulfillerEvent, FulfillerOrderWorkflowContext } from './fulfiller-decider';
import {
  submitFulfillerOrder,
  sendShippedEmail,
  sendDeliveredEmail,
  indexShipment,
} from './activities';

export type FulfillerOrderStateName = 'received' | 'submitting' | 'in_production' | 'shipped';

/**
 * The commands a fulfiller order accepts (ADR-0024). The first block arrives as
 * Temporal signals (mapped at registration in `fulfiller-workflows.ts`); the second is
 * synthesized by state timers — the intake hops and the simulation ticks. Demo
 * divergence (sync ledger): the `submitted` command keeps the demo's
 * `submitted`/`OrderSubmitted` pair — its `prepare` calls the hardcoded simulated
 * fulfiller; there is no strategy-descriptor router here.
 */
export type FulfillerOrderCommand =
  // — signal transport —
  | { type: 'fulfillerStatus'; update: Fulfillers.FulfillerStatusUpdate }
  | { type: 'cancel' }
  // — synthesized by state timers —
  | { type: 'beginSubmit' }
  | { type: 'submitted' }
  | { type: 'simulatedShip' }
  | { type: 'simulatedDeliver' };

const m = defineMachine<
  FulfillerOrderStateName,
  FulfillerOrderCommand,
  FulfillerEvent,
  FulfillerOrderWorkflowContext
>({
  decider: fulfillerDecider,
  effects: lifecycleEffects(),
});

// ==================
// Effects — shipment indexing + customer emails, keyed by the events that cause them
// (was: a per-transition to-state-sniffing hook in fulfiller-workflows.ts plus a
// finalize that re-derived the shipment list). notifyParent stays in the workflow's
// onTransition — it genuinely is per-transition semantics.
// ==================

function lifecycleEffects(): EffectsMap<FulfillerEvent, FulfillerOrderWorkflowContext> {
  const indexLastShipment = async (ctx: Readonly<FulfillerOrderWorkflowContext>) => {
    const shipment = ctx.so.shipments?.[ctx.so.shipments.length - 1];
    if (!shipment) return;
    await indexShipment({
      shipmentId: shipment.shipmentId,
      orderId: ctx.orderId,
      correlationId: ctx.cartId,
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: shipment.trackingUrl,
      itemCount: shipment.items.length,
      shippedAt: shipment.shippedAt,
      deliveredAt: shipment.deliveredAt,
    });
  };
  const shippedEmail = async (ctx: Readonly<FulfillerOrderWorkflowContext>) => {
    if (!ctx.customerEmail) return;
    await sendShippedEmail(ctx.customerEmail, ctx.orderId, ctx.confirmationNumber || ctx.orderId, {
      carrier: ctx.so.carrier || '',
      trackingNumber: ctx.so.trackingNumber || '',
      trackingUrl: ctx.so.trackingUrl,
    });
  };
  const deliveredEmail = async (ctx: Readonly<FulfillerOrderWorkflowContext>) => {
    if (!ctx.customerEmail) return;
    await sendDeliveredEmail(ctx.customerEmail, ctx.orderId, ctx.confirmationNumber || ctx.orderId);
  };

  return {
    // A fulfiller update that recorded a shipment indexes it (post-fold, so the
    // shipment is the last entry).
    FulfillerStatusApplied: async (event, ctx) => {
      if (event.update.shipmentInfo) await indexLastShipment(ctx);
    },
    ShipmentProgressed: async (_event, ctx) => {
      await shippedEmail(ctx);
    },
    SimulatedShipped: async (_event, ctx) => {
      await indexLastShipment(ctx);
      await shippedEmail(ctx);
    },
    DeliveryConfirmed: async (_event, ctx) => {
      await deliveredEmail(ctx);
    },
    SimulatedDelivered: async (_event, ctx) => {
      await deliveredEmail(ctx);
    },
  };
}

// ==================
// Prepare phases — the simulated fulfiller submit and the workflow-id-derived
// simulated tracking number (demo divergences; sync ledger)
// ==================

async function submitOrder(ctx: Readonly<FulfillerOrderWorkflowContext>) {
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
  // fulfillerOrderId can't fill the required external id). Throwing here uses the
  // prepare-throw REJECTION path: stay in `submitting`, surface the error, let the
  // timeout retry.
  if (!result.success || !result.fulfillerOrderId) {
    throw new Error(result.errorMessage ?? 'fulfiller submit failed');
  }
  return { fulfillerExternalId: result.fulfillerOrderId };
}

/** Simulated tracking number derived from the workflow id (demo divergence from mono). */
async function deriveTrackingNumber() {
  return { trackingNumber: `SIM${wf.workflowInfo().workflowId.slice(0, 8).toUpperCase()}` };
}

// ==================
// States
// ==================

export const FULFILLER_ORDER_STATES: StateRegistry<
  FulfillerOrderStateName,
  FulfillerOrderCommand,
  FulfillerOrderWorkflowContext,
  void,
  FulfillerOrderCommand
> = {
  /** received — book-keeping hop; marks the order as submitting. */
  received: m.state('received', {
    commands: { beginSubmit: {}, cancel: {} },
    route: {
      SubmissionStarted: 'submitting',
      Cancelled: terminal('cancelled'),
    },
    timeout: '1 millisecond',
    onTimeout: () => ({ type: 'beginSubmit' }),
  }),

  /** submitting — submits the order to the (simulated) fulfiller. */
  submitting: m.state('submitting', {
    commands: { submitted: { prepare: submitOrder }, cancel: {} },
    route: {
      OrderSubmitted: 'in_production',
      Cancelled: terminal('cancelled'),
    },
    timeout: '1 millisecond',
    onTimeout: () => ({ type: 'submitted' }),
  }),

  /** in_production — auto-ships on timeout (unless manual mode); accepts fulfiller updates. */
  in_production: m.state('in_production', {
    commands: {
      simulatedShip: { prepare: deriveTrackingNumber },
      fulfillerStatus: {},
      cancel: {},
    },
    route: {
      SimulatedShipped: 'shipped',
      // By design: `partially_shipped` routes into `shipped` too (ShipmentProgressed),
      // whose simulation timer auto-delivers the whole order — partials intentionally
      // auto-complete so the demo keeps moving instead of waiting on outstanding items.
      // `manualMode` (MANUAL_FULFILLMENT) is the escape hatch for demos that want to
      // hold partials and drive the remaining updates manually.
      ShipmentProgressed: 'shipped',
      DeliveryConfirmed: terminal('delivered'),
      FulfillerOrderFailed: terminal('failed'),
      Cancelled: terminal('cancelled'),
      '*': SELF,
    },
    onTimeout: (ctx) => (ctx.manualMode ? null : { type: 'simulatedShip' }),
  }),

  /** shipped — auto-delivers on timeout (unless manual mode); accepts fulfiller updates. */
  shipped: m.state('shipped', {
    commands: { simulatedDeliver: {}, fulfillerStatus: {}, cancel: {} },
    route: {
      SimulatedDelivered: terminal('delivered'),
      DeliveryConfirmed: terminal('delivered'),
      FulfillerOrderFailed: terminal('failed'),
      Cancelled: terminal('cancelled'),
      // A late shipped/partial update re-enters shipped (restarting the simulation
      // timer for the whole order — see the partials note above).
      ShipmentProgressed: 'shipped',
      '*': SELF,
    },
    // By design: this timer fires for partially-shipped orders too, so partials
    // auto-complete on the simulation timer — the demo favors forward motion over
    // blocking on unshipped items. `manualMode` suppresses the tick.
    onTimeout: (ctx) => (ctx.manualMode ? null : { type: 'simulatedDeliver' }),
  }),
};

/**
 * Build the runtime registry with the simulation delays supplied by the workflow (they
 * come from workflow memo, so the timeouts are only known at run time). Demo divergence
 * from mono: the delays ride workflow memo, not a strategy descriptor, so these stay
 * plain Durations spread over the registry rather than `(ctx) => Duration` resolvers.
 */
export function buildFulfillerOrderStates(delays: {
  processingDelayMs: number;
  shippingDelayMs: number;
  deliveryDelayMs: number;
}): StateRegistry<
  FulfillerOrderStateName,
  FulfillerOrderCommand,
  FulfillerOrderWorkflowContext,
  void,
  FulfillerOrderCommand
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
