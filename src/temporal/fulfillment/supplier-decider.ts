/**
 * Supplier-Order Decider — pure Functional Core for the fulfiller-order child workflow.
 *
 *   decide: (command, state) => Event[]
 *   evolve: (state, event)   => State   // the ONLY writer of the supplier-order state
 *
 * Pure and infrastructure-free: timestamps and generated ids (tracking numbers, the
 * supplier's external id) arrive on the command from the shell.
 */
import type { Suppliers } from '../contracts';
import type { ShipmentInfo } from './types';
import type { SupplierOrderWorkflowContext } from './supplier-workflows';

export type SupplierOrderCommand =
  | { type: 'submitted'; supplierExternalId: string; at: string }
  | { type: 'autoShipped'; trackingNumber: string; at: string }
  | { type: 'autoDelivered'; at: string }
  | { type: 'supplierStatus'; update: Suppliers.SupplierStatusUpdate }
  | { type: 'cancel' };

export type SupplierOrderFact =
  | { type: 'OrderSubmitted'; supplierExternalId: string; at: string }
  | { type: 'AutoShipped'; trackingNumber: string; at: string }
  | { type: 'AutoDelivered'; at: string }
  | { type: 'SupplierStatusApplied'; update: Suppliers.SupplierStatusUpdate }
  | { type: 'OrderCancelled' };

function copyCtx(ctx: Readonly<SupplierOrderWorkflowContext>): SupplierOrderWorkflowContext {
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
  command: SupplierOrderCommand,
  _state: SupplierOrderWorkflowContext,
): SupplierOrderFact[] {
  switch (command.type) {
    case 'submitted':
      return [{ type: 'OrderSubmitted', supplierExternalId: command.supplierExternalId, at: command.at }];
    case 'autoShipped':
      return [{ type: 'AutoShipped', trackingNumber: command.trackingNumber, at: command.at }];
    case 'autoDelivered':
      return [{ type: 'AutoDelivered', at: command.at }];
    case 'supplierStatus':
      return [{ type: 'SupplierStatusApplied', update: command.update }];
    case 'cancel':
      return [{ type: 'OrderCancelled' }];
    default:
      return [];
  }
}

/** Fold a supplier webhook/manual status update into the supplier-order state. */
function applySupplierUpdate(
  draft: SupplierOrderWorkflowContext,
  update: Suppliers.SupplierStatusUpdate,
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
              i.sku === updateItem.supplierLineItemId ||
              i.supplierLineItemId === updateItem.supplierLineItemId,
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
  so: SupplierOrderWorkflowContext['so'],
  shipmentInfo: NonNullable<Suppliers.SupplierStatusUpdate['shipmentInfo']>,
  at: string,
): void {
  const shipment: ShipmentInfo = {
    shipmentId: `${so.supplierOrderId}-${(so.shipments?.length ?? 0) + 1}`,
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
  state: SupplierOrderWorkflowContext,
  fact: SupplierOrderFact,
): SupplierOrderWorkflowContext {
  const draft = copyCtx(state);
  const so = draft.so;

  switch (fact.type) {
    case 'OrderSubmitted':
      so.supplierExternalId = fact.supplierExternalId;
      so.submittedAt = fact.at;
      so.status = 'in_production';
      so.items.forEach((i) => (i.status = 'in_production'));
      return draft;

    case 'AutoShipped':
      so.status = 'shipped';
      so.shippedAt = fact.at;
      so.carrier = 'Simulated Carrier';
      so.trackingNumber = fact.trackingNumber;
      so.shipments = [
        {
          shipmentId: `${draft.orderId}-${so.supplierOrderId}-1`,
          carrier: 'Simulated Carrier',
          trackingNumber: fact.trackingNumber,
          items: so.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
          shippedAt: fact.at,
        },
      ];
      so.items.forEach((i) => (i.status = 'shipped'));
      return draft;

    case 'AutoDelivered':
      so.status = 'delivered';
      so.completedAt = fact.at;
      so.items.forEach((i) => (i.status = 'delivered'));
      return draft;

    case 'SupplierStatusApplied':
      applySupplierUpdate(draft, fact.update);
      return draft;

    case 'OrderCancelled':
      so.status = 'cancelled';
      so.items.forEach((i) => (i.status = 'cancelled'));
      return draft;

    default:
      return draft;
  }
}
