/**
 * The fulfiller-order (child) machine, co-located in one file (ADR-0024 decider-native
 * surface, aligned with nightheron-mono's CommandBlock convention).
 *
 * Everything about the machine lives here, in reading order: the command union, the
 * workflow context, the enriched command union and the past-tense event union; the pure
 * fulfiller-update helpers; the evolve entries shared by several commands; then ONE
 * `CommandBlock` PER COMMAND — a single exported structure holding the command's whole
 * story, code inlined: its `prepare` (the only I/O), its `decide` case, and the `evolve`
 * entries for the events it emits; then the central `decide`/`evolve`, ASSEMBLED from
 * the blocks; and finally the machine assembly: effects, the `m.state` declarations
 * (whose commands tables reference the SAME blocks), and the registry.
 *
 *   decide: (command, context) => Event[]     // what happened, as past-tense events
 *   evolve: (context, event)   => Context     // apply one event — returns a NEW context
 *
 * The child simulates fulfiller fulfillment: timer-driven auto-progression
 * (received → submitting → in_production → shipped → delivered) unless
 * MANUAL_FULFILLMENT mode is on, in which case `onTimeout` returns null (idle tick)
 * and webhook/manual `fulfillerStatus` commands drive the transitions. All I/O (the
 * fulfiller submit call, shipment indexing, customer emails) lives in the blocks'
 * `prepare` phases and event-keyed effects; timestamps come from the framework's
 * deterministic `meta.timestamp`. Every routed outcome is an event the decider emitted.
 *
 * Purity is structural, not conventional: every state-writing function takes a
 * `Readonly<...>` parameter and returns a NEW value built by structural sharing — the
 * old blanket deep-copy barrier (`draftCtx`) is gone entirely.
 *
 * Demo divergence from mono (sync ledger): no plugin registry / strategy descriptors —
 * fulfillment is hardcoded simulated, so the `submitted`/`OrderSubmitted` pair replaces
 * mono's strategy-descriptor submit router, and the simulated tracking number is derived
 * from the workflow id in the shell (`prepare`) rather than from the timestamp in
 * `evolve`. Simulation delays ride workflow memo, so `buildFulfillerOrderStates` spreads
 * plain Durations over the registry rather than using `(context) => Duration` resolvers.
 */
import * as wf from '@temporalio/workflow';
import type { Fulfillers, Fulfillment } from '../contracts';
import { parseWorkflowId } from '../contracts/constants';
import { defineMachine, terminal, SELF } from '../framework';
import type { EffectsMap, MachineDecider, Rejection, StateRegistry } from '../framework';
import type { FulfillmentFulfillerOrderState, ShipmentInfo } from './types';
import {
  submitFulfillerOrder,
  sendShippedEmail,
  sendDeliveredEmail,
  indexShipment,
} from './activities';

// ==================
// Commands, context, and events — the machine's whole vocabulary
// ==================

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
 * blocks' `prepare` phases inject (the fulfiller's external id, the workflow-id-derived
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

/** One member of the WIRE command union (pre-enrichment), by its `type` tag. */
type Wire<K extends FulfillerOrderCommand['type']> = Extract<FulfillerOrderCommand, { type: K }>;

/** One member of the ENRICHED command union (wire + prepared data + `at`), by its `type` tag. */
type Enriched<K extends FulfillerOrderCommand['type']> = Extract<
  EnrichedFulfillerCommand,
  { type: K }
>;

/** One member of the event union, by its `type` tag. */
type Ev<K extends FulfillerEvent['type']> = Extract<FulfillerEvent, { type: K }>;

// ==================
// Pure fulfiller-update helpers — no I/O, no Temporal state, no side effects: each takes
// a `Readonly` context and returns a NEW value.
// ==================

/**
 * Pure application of a fulfiller status update — the core `evolve` for
 * `FulfillerStatusApplied`.
 */
export function applyFulfillerUpdatePure(
  context: Readonly<FulfillerOrderWorkflowContext>,
  update: Fulfillers.FulfillerStatusUpdate,
): FulfillerOrderWorkflowContext {
  // Function-local scratch — cloned up front and mutated freely below, but nothing
  // reachable from a parameter is ever written.
  const so: FulfillmentFulfillerOrderState = {
    ...context.so,
    items: context.so.items.map((item) => ({ ...item })),
    shipments: context.so.shipments ? context.so.shipments.map((s) => ({ ...s })) : undefined,
  };

  const recordShipment = () => {
    if (!update.shipmentInfo) return;
    const shipment: ShipmentInfo = {
      shipmentId: `${so.fulfillerOrderId}-${(so.shipments?.length ?? 0) + 1}`,
      carrier: update.shipmentInfo.carrier,
      trackingNumber: update.shipmentInfo.trackingNumber,
      trackingUrl: update.shipmentInfo.trackingUrl,
      items: update.shipmentInfo.items,
      shippedAt: update.timestamp,
    };
    so.shipments = [...(so.shipments ?? []), shipment];
    so.carrier = shipment.carrier;
    so.trackingNumber = shipment.trackingNumber;
    so.trackingUrl = shipment.trackingUrl;
  };

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
          if (stateItem && updateItem.status === 'shipped') stateItem.status = 'shipped';
        }
      }
      recordShipment();
      break;

    case 'shipped':
      so.status = 'shipped';
      so.shippedAt = update.timestamp;
      so.items.forEach((i) => (i.status = 'shipped'));
      recordShipment();
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

  return { ...context, so };
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

// ==================
// Shared evolve entries — the pieces referenced by MORE THAN ONE command block.
// Everything used by exactly one command lives INLINE in that command's block below
// (the inlining rule: the block IS the code, not an index of named functions).
// ==================

/** Emitted by cancel and by a fulfiller-reported cancellation (fulfillerStatus). */
function evolveCancelled(
  context: Readonly<FulfillerOrderWorkflowContext>,
  _event: Ev<'Cancelled'>,
): FulfillerOrderWorkflowContext {
  return {
    ...context,
    so: {
      ...context.so,
      status: 'cancelled',
      items: context.so.items.map((item) => ({ ...item, status: 'cancelled' as const })),
    },
  };
}

// ==================
// Command blocks — ONE exported structure per command, every field that defines the
// command in one value, with the code INLINED. The `m.state` declarations at the bottom
// reference these SAME blocks (the framework reads only `guard`/`prepare`; structural
// typing admits the extra fields), the central `decide`/`evolve` dispatchers are
// assembled from them, and tests exercise their fields directly.
// ==================

/**
 * A block's evolve — keyed by EVENT TYPE, because evolve's unit is the event, not the
 * command: one command may emit several event types, and some events are shared across
 * commands (those reference one shared evolve function instead of inlining twice). The
 * machine's single `evolve(context, event)` is assembled by merging every block's map.
 */
type EvolveMap = {
  [E in FulfillerEvent['type']]?: (
    context: Readonly<FulfillerOrderWorkflowContext>,
    event: Ev<E>,
  ) => FulfillerOrderWorkflowContext;
};

/** One command's whole story: refusal, I/O, decision, and the evolve for what it emits. */
export interface CommandBlock<K extends FulfillerOrderCommand['type']> {
  guard?: (context: Readonly<FulfillerOrderWorkflowContext>, command: Wire<K>) => Rejection | void;
  prepare?: (
    context: Readonly<FulfillerOrderWorkflowContext>,
    command: Wire<K>,
  ) => Promise<object | void>;
  decide: (
    command: Enriched<K>,
    context: Readonly<FulfillerOrderWorkflowContext>,
  ) => FulfillerEvent[];
  evolve?: EvolveMap;
}

// ==================
// Command: beginSubmit — the whole story (synthesized by the `received` hop; marks the
// order as submitting)
// ==================

export const beginSubmitBlock: CommandBlock<'beginSubmit'> = {
  decide: (command, _context) => [{ type: 'SubmissionStarted', at: command.at }],

  evolve: {
    SubmissionStarted: (context, _event) => ({
      ...context,
      so: { ...context.so, status: 'submitting' },
    }),
  },
};

// ==================
// Command: submitted — the whole story. `prepare` submits the order to the (simulated)
// fulfiller; the external id it returns rides the enriched command. Demo divergence
// (sync ledger): a failed submit REJECTS via the prepare-throw path — stay in
// `submitting`, surface the error, and let the state's timer re-synthesize the command
// (the visible retry loop).
// ==================

export const submittedBlock: CommandBlock<'submitted'> = {
  prepare: async (context) => {
    const result = await submitFulfillerOrder({
      fulfillmentId: wf.workflowInfo().workflowId,
      fulfillerType: 'simulated',
      items: context.so.items.map((item) => ({
        sku: item.sku,
        productId: item.productId,
        quantity: item.quantity,
        fulfillerProductId: 'simulated',
        fulfillerVariantId: 0,
      })),
      shippingAddress: {
        firstName: 'Simulated',
        lastName: 'Customer',
        email: context.customerEmail || 'simulated@example.com',
        address1: context.shippingAddress.address1,
        city: context.shippingAddress.city,
        region: context.shippingAddress.region,
        zip: context.shippingAddress.zip,
        country: context.shippingAddress.country,
      },
      shippingMethod: context.shippingMethod ?? 'standard',
    });
    // A resolved-but-failed submit must not advance the order (and a missing
    // fulfillerOrderId can't fill the required external id). Throwing here uses the
    // prepare-throw REJECTION path: stay in `submitting`, surface the error, let the
    // timeout retry.
    if (!result.success || !result.fulfillerOrderId) {
      throw new Error(result.errorMessage ?? 'fulfiller submit failed');
    }
    return { fulfillerExternalId: result.fulfillerOrderId };
  },

  decide: (command, _context) => [
    { type: 'OrderSubmitted', fulfillerExternalId: command.fulfillerExternalId, at: command.at },
  ],

  evolve: {
    OrderSubmitted: (context, event) => ({
      ...context,
      so: {
        ...context.so,
        fulfillerExternalId: event.fulfillerExternalId,
        submittedAt: event.at,
        status: 'in_production',
        items: context.so.items.map((item) => ({ ...item, status: 'in_production' as const })),
      },
    }),
  },
};

// ==================
// Command: simulatedShip — the whole story. `prepare` derives the simulated tracking
// number from the workflow id (demo divergence from mono, which derives it from the
// timestamp in `evolve`); the decider records the shipment.
// ==================

export const simulatedShipBlock: CommandBlock<'simulatedShip'> = {
  prepare: async () => {
    // Derive from the ENTITY segment of the dot-delimited id (`so-<8hex>`), so every
    // shipment gets a distinct number (R7 — the old `slice(0, 8)` of an ADR-0011 dot-id
    // was the shared prefix, making every tracking number the constant `SIMDEMO.FUL`).
    // The derivation-from-workflow-id itself remains the recorded divergence.
    const { workflowId } = wf.workflowInfo();
    const entityId = parseWorkflowId(workflowId)?.entityId ?? workflowId;
    return { trackingNumber: `SIM-${entityId.toUpperCase()}` };
  },

  decide: (command, _context) => [
    { type: 'SimulatedShipped', trackingNumber: command.trackingNumber, at: command.at },
  ],

  evolve: {
    SimulatedShipped: (context, event) => ({
      ...context,
      so: {
        ...context.so,
        status: 'shipped',
        shippedAt: event.at,
        carrier: 'Simulated Carrier',
        trackingNumber: event.trackingNumber,
        shipments: [
          {
            shipmentId: `${context.orderId}-${context.so.fulfillerOrderId}-1`,
            carrier: 'Simulated Carrier',
            trackingNumber: event.trackingNumber,
            items: context.so.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
            shippedAt: event.at,
          },
        ],
        items: context.so.items.map((item) => ({ ...item, status: 'shipped' as const })),
      },
    }),
  },
};

// ==================
// Command: simulatedDeliver — the whole story (the simulation timer completes the order)
// ==================

export const simulatedDeliverBlock: CommandBlock<'simulatedDeliver'> = {
  decide: (command, _context) => [{ type: 'SimulatedDelivered', at: command.at }],

  evolve: {
    SimulatedDelivered: (context, event) => ({
      ...context,
      so: {
        ...context.so,
        status: 'delivered',
        completedAt: event.at,
        items: context.so.items.map((item) => ({ ...item, status: 'delivered' as const })),
      },
    }),
  },
};

// ==================
// Command: fulfillerStatus — the whole story. A webhook/manual status update is applied
// (`applyFulfillerUpdatePure`), and the lifecycle outcome it implies is decided as a
// second event (`statusOutcome`) — routing keys on the decided events.
// ==================

export const fulfillerStatusBlock: CommandBlock<'fulfillerStatus'> = {
  decide: (command, _context) => {
    const at = command.at;
    const events: FulfillerEvent[] = [
      { type: 'FulfillerStatusApplied', update: command.update, at },
    ];
    const outcome = statusOutcome(command.update.status, at);
    if (outcome) events.push(outcome);
    return events;
  },

  evolve: {
    FulfillerStatusApplied: (context, event) => applyFulfillerUpdatePure(context, event.update),

    // Routing/effect markers — the companion FulfillerStatusApplied entry owns the
    // state, so these leave the context unchanged.
    ShipmentProgressed: (context, _event) => context,
    DeliveryConfirmed: (context, _event) => context,

    FulfillerOrderFailed: (context, event) => ({
      ...context,
      so: {
        ...context.so,
        status: 'failed',
        items: context.so.items.map((item) => ({ ...item, status: 'failed' as const })),
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
      },
    }),

    Cancelled: evolveCancelled, // shared with cancel
  },
};

// ==================
// Command: cancel — the whole story (parent cancel signal; same outcome as a
// fulfiller-reported cancellation)
// ==================

export const cancelBlock: CommandBlock<'cancel'> = {
  decide: (command, _context) => [{ type: 'Cancelled', at: command.at }],

  evolve: {
    Cancelled: evolveCancelled,
  },
};

// ==================
// The central decide / evolve — dispatchers ASSEMBLED from the blocks above, conforming
// to the framework's `MachineDecider`.
// ==================

/**
 * Every command's block, keyed by command type — the machine's whole command surface.
 * The mapped type pins each key to ITS OWN block, so a mixed-up entry is a type error.
 */
const blocks: { [K in FulfillerOrderCommand['type']]: CommandBlock<K> } = {
  fulfillerStatus: fulfillerStatusBlock,
  cancel: cancelBlock,
  beginSubmit: beginSubmitBlock,
  submitted: submittedBlock,
  simulatedShip: simulatedShipBlock,
  simulatedDeliver: simulatedDeliverBlock,
};

/** A block's decide, widened for dispatch (the `blocks` mapped type guarantees the match). */
type AnyDecide = (
  command: EnrichedFulfillerCommand,
  context: Readonly<FulfillerOrderWorkflowContext>,
) => FulfillerEvent[];

/** An evolve entry, widened for dispatch (the assembled map keys guarantee the match). */
type AnyEvolveEntry = (
  context: Readonly<FulfillerOrderWorkflowContext>,
  event: FulfillerEvent,
) => FulfillerOrderWorkflowContext;

/**
 * Merge every block's evolve map into the machine's single event → entry table.
 * Duplicate keys must be the IDENTICAL function reference (the shared evolve functions
 * above) — two blocks inlining different code for one event throws here, at module
 * load, so shared events cannot silently diverge.
 */
function assembleEvolve(blockList: ReadonlyArray<{ evolve?: EvolveMap }>): EvolveMap {
  const merged: EvolveMap = {};
  for (const block of blockList) {
    if (!block.evolve) continue;
    for (const type of Object.keys(block.evolve) as FulfillerEvent['type'][]) {
      const entry = block.evolve[type];
      if (!entry) continue;
      const existing = merged[type];
      if (existing && existing !== entry) {
        throw new Error(
          `fulfiller-order evolve assembly: event '${type}' has two different evolve entries — ` +
            'share one named evolve function between the blocks instead',
        );
      }
      (merged as Record<FulfillerEvent['type'], unknown>)[type] = entry;
    }
  }
  return merged;
}

const evolveByEvent: EvolveMap = assembleEvolve(Object.values(blocks));

/**
 * decide(command, context) → events. Pure: emits the events implied by the command, and
 * nothing else. This is a thin dispatcher: each command's decision code lives inline in
 * its block above.
 */
export function decide(
  command: EnrichedFulfillerCommand,
  context: Readonly<FulfillerOrderWorkflowContext>,
): FulfillerEvent[] {
  return (blocks[command.type].decide as AnyDecide)(command, context);
}

/**
 * evolve(context, event) → context. Pure application of a single event — the ONLY writer
 * of the fulfiller-order state — and it writes it by returning a NEW context built by
 * structural sharing. The dispatcher hands the event to the emitting block's evolve
 * entry (assembled above); an event with no entry leaves the context as-is. No deep
 * copy, no mutation anywhere (`draftCtx` is retired).
 */
export function evolve(
  context: Readonly<FulfillerOrderWorkflowContext>,
  event: FulfillerEvent,
): FulfillerOrderWorkflowContext {
  const entry = evolveByEvent[event.type];
  return entry ? (entry as AnyEvolveEntry)(context, event) : context;
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

// ==================
// The machine (ADR-0024 decider-native surface)
// ==================

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
  const indexLastShipment = async (context: Readonly<FulfillerOrderWorkflowContext>) => {
    const shipment = context.so.shipments?.[context.so.shipments.length - 1];
    if (!shipment) return;
    await indexShipment({
      shipmentId: shipment.shipmentId,
      orderId: context.orderId,
      correlationId: context.cartId,
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: shipment.trackingUrl,
      itemCount: shipment.items.length,
      shippedAt: shipment.shippedAt,
      deliveredAt: shipment.deliveredAt,
    });
  };
  const shippedEmail = async (context: Readonly<FulfillerOrderWorkflowContext>) => {
    if (!context.customerEmail) return;
    await sendShippedEmail(
      context.customerEmail,
      context.orderId,
      context.confirmationNumber || context.orderId,
      {
        carrier: context.so.carrier || '',
        trackingNumber: context.so.trackingNumber || '',
        trackingUrl: context.so.trackingUrl,
      },
    );
  };
  const deliveredEmail = async (context: Readonly<FulfillerOrderWorkflowContext>) => {
    if (!context.customerEmail) return;
    await sendDeliveredEmail(
      context.customerEmail,
      context.orderId,
      context.confirmationNumber || context.orderId,
    );
  };

  return {
    // A fulfiller update that recorded a shipment indexes it (post-evolve, so the
    // shipment is the last entry).
    FulfillerStatusApplied: async (event, context) => {
      if (event.update.shipmentInfo) await indexLastShipment(context);
    },
    ShipmentProgressed: async (_event, context) => {
      await shippedEmail(context);
    },
    SimulatedShipped: async (_event, context) => {
      await indexLastShipment(context);
      await shippedEmail(context);
    },
    DeliveryConfirmed: async (_event, context) => {
      await deliveredEmail(context);
    },
    SimulatedDelivered: async (_event, context) => {
      await deliveredEmail(context);
    },
  };
}

// ==================
// States — the commands tables reference the SAME blocks the dispatchers are assembled
// from; the framework reads only their `guard`/`prepare`.
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
    commands: { beginSubmit: beginSubmitBlock, cancel: cancelBlock },
    route: {
      SubmissionStarted: 'submitting',
      Cancelled: terminal('cancelled'),
    },
    timeout: '1 millisecond',
    onTimeout: () => ({ type: 'beginSubmit' }),
  }),

  /** submitting — submits the order to the (simulated) fulfiller. */
  submitting: m.state('submitting', {
    commands: { submitted: submittedBlock, cancel: cancelBlock },
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
      simulatedShip: simulatedShipBlock,
      fulfillerStatus: fulfillerStatusBlock,
      cancel: cancelBlock,
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
    onTimeout: (context) => (context.manualMode ? null : { type: 'simulatedShip' }),
  }),

  /** shipped — auto-delivers on timeout (unless manual mode); accepts fulfiller updates. */
  shipped: m.state('shipped', {
    commands: {
      simulatedDeliver: simulatedDeliverBlock,
      fulfillerStatus: fulfillerStatusBlock,
      cancel: cancelBlock,
    },
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
    onTimeout: (context) => (context.manualMode ? null : { type: 'simulatedDeliver' }),
  }),
};

/**
 * Build the runtime registry with the simulation delays supplied by the workflow (they
 * come from workflow memo, so the timeouts are only known at run time). Demo divergence
 * from mono: the delays ride workflow memo, not a strategy descriptor, so these stay
 * plain Durations spread over the registry rather than `(context) => Duration` resolvers.
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
