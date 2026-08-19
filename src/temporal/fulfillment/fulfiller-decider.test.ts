import { describe, it, expect } from 'vitest';

// Pure Functional Core: no Temporal sandbox, no activity mocks. The per-command blocks
// are exported structures, so each command's decide / evolve entries are exercised
// directly in addition to the assembled dispatchers.
import {
  decide,
  evolve,
  fulfillerDecider,
  applyFulfillerUpdatePure,
  beginSubmitBlock,
  submittedBlock,
  simulatedShipBlock,
  simulatedDeliverBlock,
  fulfillerStatusBlock,
  cancelBlock,
} from './fulfiller-states';
import type {
  EnrichedFulfillerCommand,
  FulfillerEvent,
  FulfillerOrderWorkflowContext,
} from './fulfiller-states';
import type { FulfillmentFulfillerOrderState, FulfillerStatusUpdate } from './types';

const AT = '2026-02-01T00:00:00.000Z';

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
      items: [{ sku: 'SKU-1', productId: 'p1', variantId: 'v1', quantity: 1, status: 'pending' }],
      ...soOverrides,
    },
    manualMode: false,
  };
}

const apply = (ctx: FulfillerOrderWorkflowContext, cmd: EnrichedFulfillerCommand) =>
  decide(cmd, ctx).reduce(evolve, ctx);

const shippedUpdate: FulfillerStatusUpdate = {
  fulfillerOrderId: 'so-1',
  status: 'shipped',
  timestamp: 't4',
  shipmentInfo: {
    carrier: 'UPS',
    trackingNumber: '1Z999',
    items: [{ sku: 'SKU-1', quantity: 1 }],
  },
} as FulfillerStatusUpdate;

describe('fulfiller decide() — events emitted', () => {
  it('maps each command to its events — outcomes decided alongside the application', () => {
    expect(decide({ type: 'beginSubmit', at: AT }, makeCtx())).toEqual([
      { type: 'SubmissionStarted', at: AT },
    ]);
    expect(decide({ type: 'submitted', fulfillerExternalId: 'ext-1', at: AT }, makeCtx())).toEqual([
      { type: 'OrderSubmitted', fulfillerExternalId: 'ext-1', at: AT },
    ]);
    expect(decide({ type: 'simulatedShip', trackingNumber: 'SIMABC', at: AT }, makeCtx())).toEqual([
      { type: 'SimulatedShipped', trackingNumber: 'SIMABC', at: AT },
    ]);
    expect(decide({ type: 'simulatedDeliver', at: AT }, makeCtx())).toEqual([
      { type: 'SimulatedDelivered', at: AT },
    ]);
    expect(decide({ type: 'cancel', at: AT }, makeCtx())).toEqual([{ type: 'Cancelled', at: AT }]);

    // A shipped update applies AND progresses the shipment (routing reads the event).
    expect(
      decide({ type: 'fulfillerStatus', update: shippedUpdate, at: AT }, makeCtx()).map(
        (e) => e.type,
      ),
    ).toEqual(['FulfillerStatusApplied', 'ShipmentProgressed']);
    expect(
      decide(
        {
          type: 'fulfillerStatus',
          update: { fulfillerOrderId: 'so-1', status: 'failed', timestamp: AT },
          at: AT,
        },
        makeCtx(),
      ).map((e) => e.type),
    ).toEqual(['FulfillerStatusApplied', 'FulfillerOrderFailed']);
    expect(
      decide(
        {
          type: 'fulfillerStatus',
          update: { fulfillerOrderId: 'so-1', status: 'in_production', timestamp: AT },
          at: AT,
        },
        makeCtx(),
      ).map((e) => e.type),
    ).toEqual(['FulfillerStatusApplied']);
  });

  it('decide never mutates the input state', () => {
    const s = makeCtx();
    const snap = structuredClone(s);
    decide({ type: 'fulfillerStatus', update: shippedUpdate, at: AT }, s);
    expect(s).toEqual(snap);
  });
});

describe('fulfiller-order decide→evolve (folded)', () => {
  it('beginSubmit marks the order submitting', () => {
    const ctx = apply(makeCtx(), { type: 'beginSubmit', at: 't0' });
    expect(ctx.so.status).toBe('submitting');
  });

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
    expect(ctx.so.carrier).toBe('Simulated Carrier');
    expect(ctx.so.trackingNumber).toBe('SIMABC123');
    expect(ctx.so.shipments).toHaveLength(1);
    expect(ctx.so.shipments![0].shippedAt).toBe('t2');
    expect(ctx.so.shipments![0].trackingNumber).toBe('SIMABC123');
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
      update: shippedUpdate,
      at: 't4',
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
      update: { fulfillerOrderId: 'so-1', status: 'delivered', timestamp: 't5' },
      at: 't5',
    });
    expect(ctx.so.status).toBe('delivered');
    expect(ctx.so.completedAt).toBe('t5');
    expect(ctx.so.shipments![0].deliveredAt).toBe('t5');
  });

  it('fulfillerStatus failed cascades failed to the line items', () => {
    const ctx = apply(makeCtx({ status: 'in_production' }), {
      type: 'fulfillerStatus',
      update: { fulfillerOrderId: 'so-1', status: 'failed', timestamp: 't5' },
      at: 't5',
    });
    expect(ctx.so.status).toBe('failed');
    expect(ctx.so.items.every((i) => i.status === 'failed')).toBe(true);
  });

  it('cancel cascades to line items', () => {
    const ctx = apply(makeCtx({ status: 'in_production' }), { type: 'cancel', at: 't6' });
    expect(ctx.so.status).toBe('cancelled');
    expect(ctx.so.items[0].status).toBe('cancelled');
  });

  it('does not mutate the input context', () => {
    const ctx = makeCtx();
    apply(ctx, { type: 'cancel', at: 't' });
    expect(ctx.so.status).toBe('received');
  });
});

describe('fulfillerDecider — the assembled decider', () => {
  it("has no isTerminal — terminality is the route tables' job (ADR-0024)", () => {
    expect('isTerminal' in fulfillerDecider).toBe(false);
  });

  it('exposes decide and evolve', () => {
    expect(fulfillerDecider.decide).toBe(decide);
    expect(fulfillerDecider.evolve).toBe(evolve);
  });
});

// ── The regression net the purity refactor buys: apply EVERY FulfillerEvent type and
// prove the input context is untouched. The mapped-type table makes a missing event a
// compile-time hole; the length pin keeps the net growing with the union.
const eventSamples: { [E in FulfillerEvent['type']]: Extract<FulfillerEvent, { type: E }> } = {
  SubmissionStarted: { type: 'SubmissionStarted', at: AT },
  OrderSubmitted: { type: 'OrderSubmitted', fulfillerExternalId: 'ext-1', at: AT },
  SimulatedShipped: { type: 'SimulatedShipped', trackingNumber: 'SIMABC', at: AT },
  SimulatedDelivered: { type: 'SimulatedDelivered', at: AT },
  FulfillerStatusApplied: { type: 'FulfillerStatusApplied', update: shippedUpdate, at: AT },
  ShipmentProgressed: { type: 'ShipmentProgressed', at: AT },
  DeliveryConfirmed: { type: 'DeliveryConfirmed', at: AT },
  FulfillerOrderFailed: { type: 'FulfillerOrderFailed', errorMessage: 'boom', at: AT },
  Cancelled: { type: 'Cancelled', at: AT },
};

describe('evolve never mutates its input — every FulfillerEvent type', () => {
  it('the table covers the whole event union', () => {
    expect(Object.keys(eventSamples)).toHaveLength(9);
  });

  it.each(Object.entries(eventSamples))('%s leaves the input context untouched', (_type, event) => {
    const s = makeCtx({
      status: 'in_production',
      shipments: [
        {
          shipmentId: 'so-1-1',
          carrier: 'UPS',
          trackingNumber: '1Z000',
          items: [{ sku: 'SKU-1', quantity: 1 }],
          shippedAt: 't1',
        },
      ],
    });
    const snapshot = structuredClone(s);
    evolve(s, event as FulfillerEvent);
    expect(s).toEqual(snapshot);
  });
});

// ── Per-command blocks: each command is packaged as ONE exported structure (guard /
// prepare / decide / evolve), so its pure fields are exercised directly here (prepare is
// I/O and is covered through the machine in fulfiller-states.test.ts with mocked
// activities).
describe('command blocks — one structure per command', () => {
  it('events shared by several commands reference ONE evolve function (assembly invariant)', () => {
    expect(fulfillerStatusBlock.evolve!.Cancelled).toBe(cancelBlock.evolve!.Cancelled);
  });

  it('beginSubmitBlock / simulatedDeliverBlock decide their single event', () => {
    expect(beginSubmitBlock.decide({ type: 'beginSubmit', at: AT }, makeCtx())).toEqual([
      { type: 'SubmissionStarted', at: AT },
    ]);
    expect(simulatedDeliverBlock.decide({ type: 'simulatedDeliver', at: AT }, makeCtx())).toEqual([
      { type: 'SimulatedDelivered', at: AT },
    ]);
  });

  it('submittedBlock.evolve.OrderSubmitted records the external id immutably', () => {
    const s = makeCtx();
    const next = submittedBlock.evolve!.OrderSubmitted!(s, eventSamples.OrderSubmitted);
    expect(next).not.toBe(s);
    expect(next.so.fulfillerExternalId).toBe('ext-1');
    expect(next.so.status).toBe('in_production');
    expect(s.so.status).toBe('received'); // input untouched
  });

  it('simulatedShipBlock.evolve.SimulatedShipped builds the shipment from the injected number', () => {
    const s = makeCtx({ status: 'in_production' });
    const next = simulatedShipBlock.evolve!.SimulatedShipped!(s, eventSamples.SimulatedShipped);
    expect(next.so.trackingNumber).toBe('SIMABC');
    expect(next.so.shipments).toHaveLength(1);
    expect(s.so.shipments).toBeUndefined(); // input untouched
  });

  it('fulfillerStatusBlock routing markers leave the context unchanged (the applied entry owns state)', () => {
    const s = makeCtx({ status: 'in_production' });
    expect(
      fulfillerStatusBlock.evolve!.ShipmentProgressed!(s, eventSamples.ShipmentProgressed),
    ).toBe(s);
    expect(fulfillerStatusBlock.evolve!.DeliveryConfirmed!(s, eventSamples.DeliveryConfirmed)).toBe(
      s,
    );
  });

  it('applyFulfillerUpdatePure returns a NEW context and never writes the input', () => {
    const s = makeCtx({ status: 'in_production' });
    const next = applyFulfillerUpdatePure(s, shippedUpdate);
    expect(next).not.toBe(s);
    expect(next.so.status).toBe('shipped');
    expect(next.so.shipments).toHaveLength(1);
    expect(s.so.status).toBe('in_production'); // input untouched
    expect(s.so.shipments).toBeUndefined();
  });
});

/**
 * A fulfiller-reported failure keeps the fulfiller's words (ported from mono #281 / its #269).
 *
 * `FulfillerStatusUpdate` — the shape a real fulfiller's webhook sends — had no failure-reason
 * field while `DynamicFulfillerStatusUpdate` next door has had `failureReason` all along. So the
 * reason existed on the wire and was dropped one call short of the event that needed it:
 * `statusOutcome` received a bare status, and the failure landed with no message.
 *
 * (The mono also stamps a `FulfillmentErrorCode` here; the demo has no error-code taxonomy —
 * that half depends on unported -013 work and is recorded in the sync doc, not silently skipped.)
 */
describe('a fulfiller-reported failure keeps its reason (#269 port)', () => {
  const failed = (failureReason?: string): FulfillerStatusUpdate =>
    ({
      fulfillerOrderId: 'ext-1',
      status: 'failed',
      timestamp: AT,
      ...(failureReason ? { failureReason } : {}),
    }) as FulfillerStatusUpdate;

  it('carries the fulfiller reason through to the event and onto state', () => {
    const events = decide(
      { type: 'fulfillerStatus', update: failed('Artwork rejected: DPI below minimum'), at: AT },
      makeCtx(),
    );
    const fail = events.find((e) => e.type === 'FulfillerOrderFailed') as
      | { type: string; errorMessage?: string }
      | undefined;
    expect(fail).toBeDefined();
    expect(fail!.errorMessage).toBe('Artwork rejected: DPI below minimum');

    // …and the evolve stores it, so the projection and any operator query can read it.
    const next = evolve(makeCtx(), fail as never);
    expect(next.so.status).toBe('failed');
    expect(next.so.errorMessage).toBe('Artwork rejected: DPI below minimum');
  });

  it('a failure with no prose still fails the order — silence must not soften the verdict', () => {
    const events = decide({ type: 'fulfillerStatus', update: failed(), at: AT }, makeCtx());
    const fail = events.find((e) => e.type === 'FulfillerOrderFailed') as
      | { type: string; errorMessage?: string }
      | undefined;
    expect(fail).toBeDefined();
    expect(fail!.errorMessage).toBeUndefined();
  });

  it('CONTROL: a non-failure status is unaffected', () => {
    // Without this, a change that stamped a message onto every outcome would pass the tests
    // above while polluting shipped and delivered orders.
    const events = decide({ type: 'fulfillerStatus', update: shippedUpdate, at: AT }, makeCtx());
    expect(events.map((e) => e.type)).toEqual(['FulfillerStatusApplied', 'ShipmentProgressed']);
    expect(events.every((e) => (e as { errorMessage?: string }).errorMessage === undefined)).toBe(
      true,
    );
  });
});
