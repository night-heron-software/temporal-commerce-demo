/**
 * Fulfiller-Order Decider — pure Functional Core for the fulfiller-order child workflow.
 *
 *   decide: (command, state) => Event[]
 *   evolve: (state, event)   => State   // the ONLY writer of the fulfiller-order state
 *
 * Pure and infrastructure-free: timestamps and generated ids (tracking numbers, the
 * fulfiller's external id) arrive on the command from the shell.
 */
import type { Fulfillers } from '../contracts';
import type { ShipmentInfo } from './types';
import type { FulfillerOrderWorkflowContext } from './fulfiller-workflows';

export type FulfillerOrderCommand =
  | { type: 'submitted'; fulfillerExternalId: string; at: string }
  | { type: 'simulatedShip'; trackingNumber: string; at: string }
  | { type: 'simulatedDeliver'; at: string }
  | { type: 'fulfillerStatus'; update: Fulfillers.FulfillerStatusUpdate }
  | { type: 'cancel' };

export type FulfillerOrderFact =
  | { type: 'OrderSubmitted'; fulfillerExternalId: string; at: string }
  | { type: 'SimulatedShipped'; trackingNumber: string; at: string }
  | { type: 'SimulatedDelivered'; at: string }
  | { type: 'FulfillerStatusApplied'; update: Fulfillers.FulfillerStatusUpdate }
  | { type: 'Cancelled' };

function copyCtx(ctx: Readonly<FulfillerOrderWorkflowContext>): FulfillerOrderWorkflowContext {
  return {
    ...ctx,
    so: {
      ...ctx.so,
      items: ctx.so.items.map((i) => ({ ...i })),
      shipments: ctx.so.shipments ? ctx.so.shipments.map((s) => ({ ...s })) : undefined,
    },
  };
}

export function decide(
  command: FulfillerOrderCommand,
  _state: FulfillerOrderWorkflowContext,
): FulfillerOrderFact[] {
  switch (command.type) {
    case 'submitted':
      return [
        {
          type: 'OrderSubmitted',
          fulfillerExternalId: command.fulfillerExternalId,
          at: command.at,
        },
      ];
    case 'simulatedShip':
      return [{ type: 'SimulatedShipped', trackingNumber: command.trackingNumber, at: command.at }];
    case 'simulatedDeliver':
      return [{ type: 'SimulatedDelivered', at: command.at }];
    case 'fulfillerStatus':
      return [{ type: 'FulfillerStatusApplied', update: command.update }];
    case 'cancel':
      return [{ type: 'Cancelled' }];
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

export function evolve(
  state: FulfillerOrderWorkflowContext,
  fact: FulfillerOrderFact,
): FulfillerOrderWorkflowContext {
  const draft = copyCtx(state);
  const so = draft.so;

  switch (fact.type) {
    case 'OrderSubmitted':
      so.fulfillerExternalId = fact.fulfillerExternalId;
      so.submittedAt = fact.at;
      so.status = 'in_production';
      so.items.forEach((i) => (i.status = 'in_production'));
      return draft;

    case 'SimulatedShipped':
      so.status = 'shipped';
      so.shippedAt = fact.at;
      so.carrier = 'Simulated Carrier';
      so.trackingNumber = fact.trackingNumber;
      so.shipments = [
        {
          shipmentId: `${draft.orderId}-${so.fulfillerOrderId}-1`,
          carrier: 'Simulated Carrier',
          trackingNumber: fact.trackingNumber,
          items: so.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
          shippedAt: fact.at,
        },
      ];
      so.items.forEach((i) => (i.status = 'shipped'));
      return draft;

    case 'SimulatedDelivered':
      so.status = 'delivered';
      so.completedAt = fact.at;
      so.items.forEach((i) => (i.status = 'delivered'));
      return draft;

    case 'FulfillerStatusApplied':
      applyFulfillerUpdate(draft, fact.update);
      return draft;

    case 'Cancelled':
      so.status = 'cancelled';
      so.items.forEach((i) => (i.status = 'cancelled'));
      return draft;

    default:
      return draft;
  }
}
