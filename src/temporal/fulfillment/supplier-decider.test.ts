import { describe, it, expect } from 'vitest';
import { decide, evolve } from './supplier-decider';
import type { SupplierOrderCommand } from './supplier-decider';
import type { SupplierOrderWorkflowContext } from './supplier-workflows';
import type { FulfillmentSupplierOrderState } from './types';

function makeCtx(
  soOverrides: Partial<FulfillmentSupplierOrderState> = {},
): SupplierOrderWorkflowContext {
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
      supplierOrderId: 'so-1',
      supplierId: 'simulated',
      supplierType: 'simulated',
      status: 'received',
      items: [
        { sku: 'SKU-1', productId: 'p1', variantId: 'v1', quantity: 1, unitPrice: 10, title: 'T', status: 'pending' },
      ],
      statusHistory: [],
      ...soOverrides,
    } as FulfillmentSupplierOrderState,
    manualMode: false,
  };
}

const apply = (ctx: SupplierOrderWorkflowContext, cmd: SupplierOrderCommand) =>
  decide(cmd, ctx).reduce(evolve, ctx);

describe('supplier-order decide/evolve', () => {
  it('submitted records the external id and moves items to in_production', () => {
    const ctx = apply(makeCtx(), { type: 'submitted', supplierExternalId: 'ext-1', at: 't1' });
    expect(ctx.so.supplierExternalId).toBe('ext-1');
    expect(ctx.so.submittedAt).toBe('t1');
    expect(ctx.so.status).toBe('in_production');
    expect(ctx.so.items[0].status).toBe('in_production');
  });

  it('autoShipped creates the simulated shipment with the injected tracking number', () => {
    const ctx = apply(makeCtx({ status: 'in_production' }), {
      type: 'autoShipped',
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

  it('autoDelivered completes the order', () => {
    const ctx = apply(makeCtx({ status: 'shipped' }), { type: 'autoDelivered', at: 't3' });
    expect(ctx.so.status).toBe('delivered');
    expect(ctx.so.completedAt).toBe('t3');
    expect(ctx.so.items[0].status).toBe('delivered');
  });

  it('supplierStatus shipped appends a shipment from the update payload', () => {
    const ctx = apply(makeCtx({ status: 'in_production' }), {
      type: 'supplierStatus',
      update: {
        supplierOrderId: 'so-1',
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

  it('supplierStatus delivered stamps the newest shipment', () => {
    const shipped = apply(makeCtx({ status: 'in_production' }), {
      type: 'autoShipped',
      trackingNumber: 'SIM1',
      at: 't2',
    });
    const ctx = apply(shipped, {
      type: 'supplierStatus',
      update: { supplierOrderId: 'so-1', status: 'delivered', timestamp: 't5' } as never,
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
