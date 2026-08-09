/**
 * Fulfiller-order (child) Decider — pure Functional Core, on the ADR-0024 decider-native
 * surface: the framework owns the fold, this module supplies only
 *
 *   decide: (command, state) => Event[]     // what happened, as past-tense events
 *   evolve: (state, event)   => State       // fold one event into state (the ONLY writer)
 *
 * Pure — no I/O, no clock. The simulated intake's I/O (the fulfiller submit call) lives
 * in the states' `prepare` phases (`fulfiller-states.ts`); its result — and the
 * workflow-id-derived simulated tracking number — arrive enriched on the commands.
 * Every outcome the machine routes on is DECIDED here as an event, including what a
 * fulfiller status update means for the lifecycle.
 *
 * Demo divergence from mono (sync ledger): no plugin registry / strategy descriptors —
 * fulfillment is hardcoded simulated, so the `submitted`/`OrderSubmitted` pair replaces
 * mono's strategy-descriptor submit router, and the simulated tracking number is derived
 * from the workflow id in the shell rather than from the timestamp in `evolve`.
 */

import type { Fulfillers } from '../contracts';
import type { Fulfillment } from '../contracts';
import type { FulfillmentFulfillerOrderState, ShipmentInfo } from './types';
import type { MachineDecider } from '../framework';
import type { FulfillerOrderCommand } from './fulfiller-states';

export interface FulfillerOrderWorkflowContext {
  orderId: string;
  cartId: string;
  customerId: string;
  customerEmail?: string;
  confirmationNumber?: string;
  shippingAddress: Fulfillment.ShippingAddress;
  shippingMethod?: 'standard' | 'express' | 'economy';
  so: FulfillmentFulfillerOrderState;
  /** MANUAL_FULFILLMENT feature flag — suppresses the simulation timers. */
  manualMode: boolean;
}

/**
 * The command as the decider sees it: the wire/timer command union with the fields the
 * states' `prepare` phases inject (the fulfiller's external id, the workflow-id-derived
 * tracking number), plus the framework's deterministic timestamp.
 */
export type EnrichedFulfillerCommand = (
  | (Extract<FulfillerOrderCommand, { type: 'submitted' }> & { fulfillerExternalId: string })
  | (Extract<FulfillerOrderCommand, { type: 'simulatedShip' }> & { trackingNumber: string })
  | Exclude<FulfillerOrderCommand, { type: 'submitted' | 'simulatedShip' }>
) & { at: string };

/** Past-tense domain events. */
export type FulfillerEvent =
  | { type: 'SubmissionStarted'; at: string }
  | { type: 'OrderSubmitted'; fulfillerExternalId: string; at: string }
  | { type: 'SimulatedShipped'; trackingNumber: string; at: string }
  | { type: 'SimulatedDelivered'; at: string }
  | { type: 'FulfillerStatusApplied'; update: Fulfillers.FulfillerStatusUpdate; at: string }
  | { type: 'ShipmentProgressed'; at: string }
  | { type: 'DeliveryConfirmed'; at: string }
  | { type: 'FulfillerOrderFailed'; errorMessage?: string; at: string }
  | { type: 'Cancelled'; at: string };

/** Deep-copy the context's fulfiller order for immutable folds. */
function draftCtx(ctx: Readonly<FulfillerOrderWorkflowContext>): FulfillerOrderWorkflowContext {
  return {
    ...ctx,
    so: {
      ...ctx.so,
      items: ctx.so.items.map((i) => ({ ...i })),
      shipments: ctx.so.shipments ? ctx.so.shipments.map((s) => ({ ...s })) : undefined,
    },
  };
}

/** The lifecycle outcome a fulfiller-reported status implies, as an event (or none). */
function statusOutcome(
  status: Fulfillers.FulfillerStatusUpdate['status'],
  at: string,
): FulfillerEvent | null {
  switch (status) {
    case 'shipped':
    case 'partially_shipped':
      return { type: 'ShipmentProgressed', at };
    case 'delivered':
      return { type: 'DeliveryConfirmed', at };
    case 'failed':
      return { type: 'FulfillerOrderFailed', at };
    case 'cancelled':
      return { type: 'Cancelled', at };
    default:
      return null;
  }
}

/** decide(command, state) → events. Pure. */
export function decide(
  command: EnrichedFulfillerCommand,
  _state: FulfillerOrderWorkflowContext,
): FulfillerEvent[] {
  const at = command.at;
  switch (command.type) {
    case 'beginSubmit':
      return [{ type: 'SubmissionStarted', at }];

    case 'submitted':
      return [{ type: 'OrderSubmitted', fulfillerExternalId: command.fulfillerExternalId, at }];

    case 'simulatedShip':
      return [{ type: 'SimulatedShipped', trackingNumber: command.trackingNumber, at }];

    case 'simulatedDeliver':
      return [{ type: 'SimulatedDelivered', at }];

    case 'fulfillerStatus': {
      const events: FulfillerEvent[] = [
        { type: 'FulfillerStatusApplied', update: command.update, at },
      ];
      const outcome = statusOutcome(command.update.status, at);
      if (outcome) events.push(outcome);
      return events;
    }

    case 'cancel':
      return [{ type: 'Cancelled', at }];

    default:
      return [];
  }
}

/** Fold a fulfiller webhook/manual status update into the fulfiller-order state. */
function applyFulfillerUpdate(
  draft: FulfillerOrderWorkflowContext,
  update: Fulfillers.FulfillerStatusUpdate,
): void {
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
              i.sku === updateItem.fulfillerLineItemId ||
              i.fulfillerLineItemId === updateItem.fulfillerLineItemId,
          );
          if (stateItem && updateItem.status === 'shipped') {
            stateItem.status = 'shipped';
          }
        }
      }
      if (update.shipmentInfo) {
        appendShipment(so, update.shipmentInfo, update.timestamp);
      }
      break;

    case 'shipped':
      so.status = 'shipped';
      so.shippedAt = update.timestamp;
      so.items.forEach((i) => (i.status = 'shipped'));
      if (update.shipmentInfo) {
        appendShipment(so, update.shipmentInfo, update.timestamp);
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
}

function appendShipment(
  so: FulfillerOrderWorkflowContext['so'],
  shipmentInfo: NonNullable<Fulfillers.FulfillerStatusUpdate['shipmentInfo']>,
  at: string,
): void {
  const shipment: ShipmentInfo = {
    shipmentId: `${so.fulfillerOrderId}-${(so.shipments?.length ?? 0) + 1}`,
    carrier: shipmentInfo.carrier,
    trackingNumber: shipmentInfo.trackingNumber,
    trackingUrl: shipmentInfo.trackingUrl,
    items: shipmentInfo.items,
    shippedAt: at,
  };
  so.shipments = [...(so.shipments ?? []), shipment];
  so.carrier = shipment.carrier;
  so.trackingNumber = shipment.trackingNumber;
  so.trackingUrl = shipment.trackingUrl;
}

/** evolve(state, event) → state. Pure fold; the ONLY writer of the fulfiller-order state. */
export function evolve(
  state: FulfillerOrderWorkflowContext,
  event: FulfillerEvent,
): FulfillerOrderWorkflowContext {
  const draft = draftCtx(state);
  const so = draft.so;

  switch (event.type) {
    case 'SubmissionStarted':
      so.status = 'submitting';
      return draft;

    case 'OrderSubmitted':
      so.fulfillerExternalId = event.fulfillerExternalId;
      so.submittedAt = event.at;
      so.status = 'in_production';
      so.items.forEach((i) => (i.status = 'in_production'));
      return draft;

    case 'SimulatedShipped':
      // Demo divergence: the simulated tracking number is derived from the workflow id
      // in the shell (prepare) and rides the event — mono derives it from the timestamp.
      so.status = 'shipped';
      so.shippedAt = event.at;
      so.carrier = 'Simulated Carrier';
      so.trackingNumber = event.trackingNumber;
      so.shipments = [
        {
          shipmentId: `${draft.orderId}-${so.fulfillerOrderId}-1`,
          carrier: 'Simulated Carrier',
          trackingNumber: event.trackingNumber,
          items: so.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
          shippedAt: event.at,
        },
      ];
      so.items.forEach((i) => (i.status = 'shipped'));
      return draft;

    case 'SimulatedDelivered':
      so.status = 'delivered';
      so.completedAt = event.at;
      so.items.forEach((i) => (i.status = 'delivered'));
      return draft;

    case 'FulfillerStatusApplied':
      applyFulfillerUpdate(draft, event.update);
      return draft;

    // Routing/effect markers — the companion FulfillerStatusApplied fold owns the state.
    case 'ShipmentProgressed':
    case 'DeliveryConfirmed':
      return state;

    case 'FulfillerOrderFailed':
      so.status = 'failed';
      so.items.forEach((i) => (i.status = 'failed'));
      if (event.errorMessage) so.errorMessage = event.errorMessage;
      return draft;

    case 'Cancelled':
      so.status = 'cancelled';
      so.items.forEach((i) => (i.status = 'cancelled'));
      return draft;

    default:
      return draft;
  }
}

/**
 * The assembled decider, conforming to the framework's `MachineDecider` shape (ADR-0024:
 * `isTerminal` is gone — terminality is the route tables' job; `initialState` remains as
 * the canonical empty shape for decider unit tests, never consulted at runtime).
 */
export const fulfillerDecider: MachineDecider<
  EnrichedFulfillerCommand,
  FulfillerEvent,
  FulfillerOrderWorkflowContext
> = {
  decide,
  evolve,
  initialState: {
    orderId: '',
    cartId: '',
    customerId: '',
    shippingAddress: {} as FulfillerOrderWorkflowContext['shippingAddress'],
    so: {
      fulfillerOrderId: '',
      fulfillerId: '',
      fulfillerType: 'simulated',
      status: 'received',
      items: [],
    } as FulfillmentFulfillerOrderState,
    manualMode: false,
  },
};
