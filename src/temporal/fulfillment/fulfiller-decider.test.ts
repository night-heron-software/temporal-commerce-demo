import { describe, it, expect } from 'vitest';
import { decide, evolve } from './fulfiller-decider';
import type { FulfillerOrderCommand } from './fulfiller-decider';
import type { FulfillerOrderWorkflowContext } from './fulfiller-workflows';
import type { FulfillmentFulfillerOrderState } from './types';

function makeCtx(
  soOverrides: Partial<FulfillmentFulfillerOrderState> = {},
): FulfillerOrderWorkflowContext {
  return {
    orderId: 'o-1',
    cartId: 'c-1',
    customerId: 'cust-1',
    customerEmail: 'a@b.c',
    confirmationNumber: 'DEMO1234',
    shippingAddress: {
      firstName: 'A',
      lastName: 'B',
      email: 'a@b.c',
      address1: '1 Main St',
      city: 'Springfield',
      region: 'IL',
      zip: '62701',
      country: 'US',
    },
    so: {
      fulfillerOrderId: 'so-1',
      fulfillerId: 'simulated',
      fulfillerType: 'simulated',
      status: 'received',
      items: [
        {
          sku: 'SKU-1',
          productId: 'p1',
          variantId: 'v1',
          quantity: 1,
          unitPrice: 10,
          title: 'T',
          status: 'pending',
        },
      ],
      statusHistory: [],
      ...soOverrides,
    } as FulfillmentFulfillerOrderState,
    manualMode: false,
  };
}

const apply = (ctx: FulfillerOrderWorkflowContext, cmd: FulfillerOrderCommand) =>
  decide(cmd, ctx).reduce(evolve, ctx);

describe('fulfiller-order decide/evolve', () => {
  it('submitted records the external id and moves items to in_production', () => {
    const ctx = apply(makeCtx(), { type: 'submitted', fulfillerExternalId: 'ext-1', at: 't1' });
    expect(ctx.so.fulfillerExternalId).toBe('ext-1');
    expect(ctx.so.submittedAt).toBe('t1');
    expect(ctx.so.status).toBe('in_production');
    expect(ctx.so.items[0].status).toBe('in_production');
  });

  it('simulatedShip creates the simulated shipment with the injected tracking number', () => {
    const ctx = apply(makeCtx({ status: 'in_production' }), {
      type: 'simulatedShip',
      trackingNumber: 'SIMABC123',
      at: 't2',
    });
    expect(ctx.so.status).toBe('shipped');
    expect(ctx.so.shippedAt).toBe('t2');
    expect(ctx.so.trackingNumber).toBe('SIMABC123');
    expect(ctx.so.shipments).toHaveLength(1);
    expect(ctx.so.shipments![0].shippedAt).toBe('t2');
    expect(ctx.so.items[0].status).toBe('shipped');
  });

  it('simulatedDeliver completes the order', () => {
    const ctx = apply(makeCtx({ status: 'shipped' }), { type: 'simulatedDeliver', at: 't3' });
    expect(ctx.so.status).toBe('delivered');
    expect(ctx.so.completedAt).toBe('t3');
    expect(ctx.so.items[0].status).toBe('delivered');
  });

  it('fulfillerStatus shipped appends a shipment from the update payload', () => {
    const ctx = apply(makeCtx({ status: 'in_production' }), {
      type: 'fulfillerStatus',
      update: {
        fulfillerOrderId: 'so-1',
        status: 'shipped',
        timestamp: 't4',
        shipmentInfo: {
          carrier: 'UPS',
          trackingNumber: '1Z999',
          items: [{ sku: 'SKU-1', quantity: 1 }],
        },
      } as never,
    });
    expect(ctx.so.status).toBe('shipped');
    expect(ctx.so.shipments).toHaveLength(1);
    expect(ctx.so.shipments![0].carrier).toBe('UPS');
    expect(ctx.so.carrier).toBe('UPS');
  });

  it('fulfillerStatus delivered stamps the newest shipment', () => {
    const shipped = apply(makeCtx({ status: 'in_production' }), {
      type: 'simulatedShip',
      trackingNumber: 'SIM1',
      at: 't2',
    });
    const ctx = apply(shipped, {
      type: 'fulfillerStatus',
      update: { fulfillerOrderId: 'so-1', status: 'delivered', timestamp: 't5' } as never,
    });
    expect(ctx.so.status).toBe('delivered');
    expect(ctx.so.shipments![0].deliveredAt).toBe('t5');
  });

  it('cancel cascades to line items', () => {
    const ctx = apply(makeCtx({ status: 'in_production' }), { type: 'cancel' });
    expect(ctx.so.status).toBe('cancelled');
    expect(ctx.so.items[0].status).toBe('cancelled');
  });

  it('does not mutate the input context', () => {
    const ctx = makeCtx();
    apply(ctx, { type: 'cancel' });
    expect(ctx.so.status).toBe('received');
  });
});
