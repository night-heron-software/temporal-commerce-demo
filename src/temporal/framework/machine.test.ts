import { describe, it, expect, vi } from 'vitest';

// machine.ts only needs `log` from the workflow runtime; mock it so effect-failure
// tests can assert the logged-and-swallowed contract without a sandbox.
const logged = vi.hoisted(() => ({ errors: [] as unknown[] }));
vi.mock('@temporalio/workflow', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((...args: unknown[]) => {
      logged.errors.push(args);
    }),
  },
}));

import { applyCommand, defineMachine, reject, isRejection } from './machine';
import type { MachineDecider } from './machine';
import { terminal } from './authoring';
import { SELF } from './types';
import type { StateInput } from './types';

// ── A small cart-like domain exercising the whole pipeline ─────────────

interface Ctx {
  items: number;
  version: number;
  submitting: boolean;
  lastSku?: string;
  lastAt?: string;
}

type Cmd =
  | { type: 'add'; qty: number }
  | { type: 'remove'; qty: number }
  | { type: 'begin' }
  | { type: 'expire' };

type Ev =
  | { type: 'Added'; qty: number; sku?: string; at?: string }
  | { type: 'Removed'; qty: number }
  | { type: 'Emptied' }
  | { type: 'CheckoutBegun' }
  | { type: 'Expired' };

// The enriched command the decider sees: wire command + prepared/meta fields.
type DCmd = Cmd & { at?: string; sku?: string };

const decider: MachineDecider<DCmd, Ev, Ctx> = {
  decide(command, state) {
    switch (command.type) {
      case 'add':
        return [{ type: 'Added', qty: command.qty, sku: command.sku, at: command.at }];
      case 'remove':
        // A command generating TWO events: the removal, and — when it empties the
        // cart — the consequence. Routing must key on the LAST routed event.
        return state.items - command.qty <= 0
          ? [{ type: 'Removed', qty: command.qty }, { type: 'Emptied' }]
          : [{ type: 'Removed', qty: command.qty }];
      case 'begin':
        return [{ type: 'CheckoutBegun' }];
      case 'expire':
        return [{ type: 'Expired' }];
    }
  },
  evolve(state, event) {
    switch (event.type) {
      case 'Added':
        return {
          ...state,
          items: state.items + event.qty,
          version: state.version + 1,
          lastSku: event.sku,
          lastAt: event.at,
        };
      case 'Removed':
        return { ...state, items: state.items - event.qty, version: state.version + 1 };
      case 'Emptied':
      case 'CheckoutBegun':
      case 'Expired':
        return state;
    }
  },
  initialState: { items: 0, version: 0, submitting: false },
};

const ctx0: Ctx = { items: 0, version: 0, submitting: false };
const cmd = (c: Cmd, ts = 't0'): StateInput<Cmd, Cmd> => ({
  kind: 'event',
  event: c,
  timestamp: ts,
});
const sig = (c: Cmd, ts = 't0'): StateInput<Cmd, Cmd> => ({
  kind: 'signal',
  result: c,
  timestamp: ts,
});
const tick = (ts = 't0'): StateInput<Cmd, Cmd> => ({ kind: 'timeout', timestamp: ts });

describe('applyCommand — the framework-owned fold', () => {
  it('folds emitted events and returns both context and events', () => {
    const { context, events } = applyCommand(
      decider,
      { ...ctx0, items: 2 },
      { type: 'remove', qty: 2 },
    );
    expect(events.map((e) => e.type)).toEqual(['Removed', 'Emptied']);
    expect(context.items).toBe(0);
    expect(context.version).toBe(1);
  });

  it('an empty decision folds to the same context', () => {
    const noop: MachineDecider<DCmd, Ev, Ctx> = { ...decider, decide: () => [] };
    const { context, events } = applyCommand(noop, ctx0, { type: 'begin' });
    expect(events).toEqual([]);
    expect(context).toBe(ctx0);
  });
});

describe('defineMachine — pipeline', () => {
  const m = defineMachine<'active' | 'checkout', Cmd, Ev, Ctx, { items: number }>({
    decider,
    respond: (ctx) => ({ items: ctx.items }),
  });

  const active = m.state('active', {
    commands: {
      add: {
        guard: (ctx) => (ctx.submitting ? reject('Cart is being submitted') : undefined),
        prepare: async (_ctx, c) => ({ sku: `sku-${c.qty}` }),
      },
      remove: {},
      begin: {},
    },
    route: { CheckoutBegun: 'checkout', Emptied: terminal('abandoned'), '*': SELF },
  });

  it('runs guard → prepare → enrich → decide → fold and routes on the emitted event', async () => {
    const out = await active.fn(ctx0, cmd({ type: 'add', qty: 3 }, 'ts-1'));
    expect(out.next).toBe('active'); // '*' → SELF resolved to the state's own name
    expect(out.context.items).toBe(3);
    // Default enrichment: prepared fields + the deterministic timestamp reached the decider.
    expect(out.context.lastSku).toBe('sku-3');
    expect(out.context.lastAt).toBe('ts-1');
    expect(out.response).toEqual({ items: 3 });
    expect(out.rejected).toBeUndefined();
  });

  it('a signal-arm input carries a command through the same pipeline', async () => {
    const out = await active.fn(ctx0, sig({ type: 'add', qty: 2 }, 'ts-2'));
    expect(out.context.items).toBe(2);
    expect(out.context.lastAt).toBe('ts-2');
  });

  it('the LAST routed event wins when a command emits several', async () => {
    const out = await active.fn({ ...ctx0, items: 1 }, cmd({ type: 'remove', qty: 1 }));
    expect(out.next).toBe('__terminal:abandoned'); // Removed → '*' (SELF), then Emptied → terminal
    expect(out.context.items).toBe(0);
  });

  it('routes to another state on its named event', async () => {
    const out = await active.fn({ ...ctx0, items: 1 }, cmd({ type: 'begin' }));
    expect(out.next).toBe('checkout');
  });

  it('a trailing UNROUTED event clobbers an earlier routed one when `*` is present', async () => {
    // The sharp edge behind `'*': SELF`, pinned so nobody rediscovers it in production.
    // `resolveNext` reads `routeTable[ev.type] ?? routeTable['*']` for EVERY event in
    // emission order, last non-undefined wins. With a `'*'` entry present, an unrouted
    // event is not skipped — it resolves to the wildcard and OVERWRITES the target an
    // earlier routed event had already set.
    //
    // Every marker event in the commerce machines (FulfillmentApplied, ChildStatusApplied,
    // FulfillerStatusApplied) is emitted FIRST for exactly this reason. Emit one last and
    // the transition silently becomes a self-loop.
    const trailing = m.state('active', {
      commands: { begin: {} },
      route: { CheckoutBegun: 'checkout', '*': SELF },
    });
    const twoEvents: MachineDecider<DCmd, Ev, Ctx> = {
      ...decider,
      decide: () => [{ type: 'CheckoutBegun' }, { type: 'Removed', qty: 0 }],
    };
    const mm = defineMachine<'active' | 'checkout', Cmd, Ev, Ctx, { items: number }>({
      decider: twoEvents,
      respond: (ctx) => ({ items: ctx.items }),
    });
    const clobbered = mm.state('active', {
      commands: { begin: {} },
      route: { CheckoutBegun: 'checkout', '*': SELF },
    });

    // Routed-only ordering behaves as you would expect…
    expect((await trailing.fn(ctx0, cmd({ type: 'begin' }))).next).toBe('checkout');
    // …but a trailing unrouted event drags it back to SELF.
    expect((await clobbered.fn(ctx0, cmd({ type: 'begin' }))).next).toBe('active');
  });
});

describe('defineMachine — rejection', () => {
  const m = defineMachine<'active', Cmd, Ev, Ctx>({ decider });
  const active = m.state('active', {
    commands: {
      add: {
        guard: (ctx) => (ctx.submitting ? reject('Cart is being submitted') : undefined),
        prepare: async (_ctx, c) => {
          if (c.qty > 10) throw new Error('Out of stock');
          return {};
        },
      },
    },
    route: { '*': SELF },
  });

  it('a guard refusal rejects: error out, context unchanged, marked rejected', async () => {
    const busy = { ...ctx0, submitting: true };
    const out = await active.fn(busy, cmd({ type: 'add', qty: 1 }));
    expect(out.rejected).toBe(true);
    expect(out.error).toBe('Cart is being submitted');
    expect(out.next).toBe('active');
    expect(out.context).toBe(busy); // untouched — no fold ran
  });

  it('a prepare throw rejects with the thrown message', async () => {
    const out = await active.fn(ctx0, cmd({ type: 'add', qty: 99 }));
    expect(out.rejected).toBe(true);
    expect(out.error).toBe('Out of stock');
    expect(out.context.items).toBe(0);
  });

  it('a command the state does not list is rejected', async () => {
    const out = await active.fn(ctx0, cmd({ type: 'begin' }));
    expect(out.rejected).toBe(true);
    expect(out.error).toBe("State 'active' does not accept command 'begin'");
  });

  it('isRejection only recognizes reject() shapes', () => {
    expect(isRejection(reject('x'))).toBe(true);
    expect(isRejection(undefined)).toBe(false);
    expect(isRejection({ rejected: true })).toBe(false);
  });
});

describe('defineMachine — effects, respond, enrich override', () => {
  it('runs state-level effects before machine-level, in event-emission order, on the folded context', async () => {
    const calls: string[] = [];
    const m = defineMachine<'active', Cmd, Ev, Ctx>({
      decider,
      effects: {
        Removed: async (_e, ctx) => {
          calls.push(`machine:Removed@items=${ctx.items}`);
        },
        Emptied: async () => {
          calls.push('machine:Emptied');
        },
      },
    });
    const active = m.state('active', {
      commands: { remove: {} },
      route: { '*': SELF },
      effects: {
        Removed: async () => {
          calls.push('state:Removed');
        },
      },
    });

    await active.fn({ ...ctx0, items: 1 }, cmd({ type: 'remove', qty: 1 }));
    // Removed (state, then machine) precedes Emptied; effects see the FOLDED context.
    expect(calls).toEqual(['state:Removed', 'machine:Removed@items=0', 'machine:Emptied']);
  });

  it('an effect failure is logged and swallowed — the decision stands', async () => {
    logged.errors.length = 0;
    const m = defineMachine<'active', Cmd, Ev, Ctx>({
      decider,
      effects: {
        Added: async () => {
          throw new Error('effect boom');
        },
      },
    });
    const active = m.state('active', { commands: { add: {} }, route: { '*': SELF } });
    const out = await active.fn(ctx0, cmd({ type: 'add', qty: 1 }));
    expect(out.context.items).toBe(1);
    expect(out.error).toBeUndefined();
    expect(logged.errors.length).toBe(1);
  });

  it('a command-level respond overrides the machine default', async () => {
    const m = defineMachine<'active', Cmd, Ev, Ctx, string>({
      decider,
      respond: () => 'machine',
    });
    const active = m.state('active', {
      commands: {
        add: { respond: (_ctx, events) => `command:${events[0]!.type}` },
        remove: {},
      },
      route: { '*': SELF },
    });
    expect((await active.fn(ctx0, cmd({ type: 'add', qty: 1 }))).response).toBe('command:Added');
    expect((await active.fn({ ...ctx0, items: 5 }, cmd({ type: 'remove', qty: 1 }))).response).toBe(
      'machine',
    );
  });

  it('enrich overrides the default spread — normalizing one wire command into another decider command', async () => {
    const m = defineMachine<'active', Cmd, Ev, Ctx>({ decider });
    const active = m.state('active', {
      commands: {
        // 'expire' arrives on the wire but the domain decides it as a remove-all.
        expire: { enrich: (_c, _p, meta) => ({ type: 'remove', qty: 999, at: meta.timestamp }) },
      },
      route: { Emptied: terminal('expired'), '*': SELF },
    });
    const out = await active.fn({ ...ctx0, items: 4 }, cmd({ type: 'expire' }));
    expect(out.next).toBe('__terminal:expired');
    expect(out.context.items).toBe(4 - 999);
  });
});

describe('defineMachine — timeouts and config passthrough', () => {
  it('onTimeout synthesizes a command that runs the full pipeline, guard included', async () => {
    const m = defineMachine<'active', Cmd, Ev, Ctx>({ decider });
    const active = m.state('active', {
      commands: {
        expire: {
          guard: (ctx) => (ctx.items === 0 ? reject('nothing to expire') : undefined),
        },
      },
      route: { Expired: terminal('expired'), '*': SELF },
      onTimeout: () => ({ type: 'expire' }),
      timeout: '1 hour',
    });

    const live = await active.fn({ ...ctx0, items: 2 }, tick());
    expect(live.next).toBe('__terminal:expired');

    const guarded = await active.fn(ctx0, tick());
    expect(guarded.rejected).toBe(true);
    expect(guarded.error).toBe('nothing to expire');
  });

  it('a timeout with no onTimeout stays put without rejecting', async () => {
    const m = defineMachine<'active', Cmd, Ev, Ctx>({ decider });
    const active = m.state('active', { commands: {}, route: { '*': SELF } });
    const out = await active.fn(ctx0, tick());
    expect(out.next).toBe('active');
    expect(out.rejected).toBeUndefined();
    expect(out.error).toBeUndefined();
  });

  it('carries timeout and transitional onto the StateConfig — no registry spreading', () => {
    const m = defineMachine<'active', Cmd, Ev, Ctx>({ decider });
    const cfg = m.state('active', {
      commands: {},
      route: { '*': SELF },
      timeout: '2 hours',
      transitional: true,
    });
    expect(cfg.timeout).toBe('2 hours');
    expect(cfg.transitional).toBe(true);
  });

  it('passes a per-execution timeout resolver through to the StateConfig', () => {
    const m = defineMachine<'active', Cmd, Ev, Ctx>({ decider });
    const resolve = (ctx: Readonly<Ctx>) => (ctx.items > 0 ? '1 hour' : '15 minutes');
    const cfg = m.state('active', { commands: {}, route: { '*': SELF }, timeout: resolve });
    expect(cfg.timeout).toBe(resolve);
    expect((cfg.timeout as (c: Ctx) => string)({ ...ctx0, items: 2 })).toBe('1 hour');
  });
});
