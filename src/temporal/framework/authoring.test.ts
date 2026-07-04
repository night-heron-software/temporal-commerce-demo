import { describe, it, expect } from 'vitest';
import { defineDomain, terminal } from './authoring';
import { SELF } from './types';

// A tiny domain exercising the co-located transition API (critique §7.1/§7.6).
type Ctx = { count: number };
type Ev = { type: 'inc'; by: number } | { type: 'done' };

const d = defineDomain<'active' | 'review', Ev, Ctx, { count: number }, never>();

const active = d.transitions(
  'active',
  {
    inc: {
      // prepare and decide for one event live together — no second switch.
      async prepare(_ctx, ev) {
        return { validated: ev.by };
      },
      decide(ctx, ev, _meta, prepared) {
        return {
          context: { count: ctx.count + prepared.validated },
          next: 'active',
          response: { count: ctx.count + ev.by },
        };
      },
    },
    done: {
      decide(ctx) {
        return { context: ctx, next: terminal('finished') };
      },
    },
  },
  {
    onTimeout: { decide: (ctx) => ({ context: ctx, next: terminal('expired') }) },
  },
);

// A routing-only state via the declarative façade (§7.2).
const review = d.route('review', { inc: 'active', done: terminal('finished') });

describe('defineTransitions (co-located phases)', () => {
  it('threads prepared data from prepare into decide', async () => {
    const out = await active.fn({ count: 0 }, { kind: 'event', event: { type: 'inc', by: 5 }, timestamp: 't' });
    expect(out.next).toBe('active');
    expect(out.context.count).toBe(5);
    expect(out.response).toEqual({ count: 5 });
  });

  it('routes to a typed terminal', async () => {
    const out = await active.fn({ count: 9 }, { kind: 'event', event: { type: 'done' }, timestamp: 't' });
    expect(out.next).toBe('__terminal:finished');
  });

  it('handles a timeout input via onTimeout', async () => {
    const out = await active.fn({ count: 1 }, { kind: 'timeout', timestamp: 't' });
    expect(out.next).toBe('__terminal:expired');
  });

  it('returns an error for an unknown event without crashing', async () => {
    const out = await active.fn({ count: 1 }, { kind: 'event', event: { type: 'nope' } as never, timestamp: 't' });
    expect(out.next).toBe('active');
    expect(out.error).toMatch(/No transition/);
  });

  it('passes the deterministic meta.timestamp into the event handler', async () => {
    type StampCtx = { stampedAt: string };
    const s = defineDomain<'s', { type: 'go' }, StampCtx, void, never>();
    const state = s.transitions('s', {
      go: {
        decide(ctx, _ev, meta) {
          // The event decide stamps from meta, never Date.now() — the whole point.
          return { context: { ...ctx, stampedAt: meta.timestamp }, next: SELF };
        },
      },
    });
    const out = await state.fn(
      { stampedAt: '' },
      { kind: 'event', event: { type: 'go' }, timestamp: '2026-07-02T00:00:00.000Z' },
    );
    expect(out.context.stampedAt).toBe('2026-07-02T00:00:00.000Z');
  });
});

describe('route (declarative façade)', () => {
  it('maps events straight to next states', async () => {
    const a = await review.fn({ count: 0 }, { kind: 'event', event: { type: 'inc', by: 1 }, timestamp: 't' });
    const done = await review.fn({ count: 0 }, { kind: 'event', event: { type: 'done' }, timestamp: 't' });
    expect(a.next).toBe('active');
    expect(done.next).toBe('__terminal:finished');
  });
});

describe('terminal()', () => {
  it('builds the __terminal: encoding', () => {
    expect(terminal('cancelled')).toBe('__terminal:cancelled');
  });
});

// ── SELF sentinel: a shared handler that "stays put" without naming a state ──
describe('SELF (stay-in-current-state sentinel)', () => {
  // The SAME handler is reused across two states; `next: SELF` must resolve to
  // whichever state owns it — never the literal sentinel, never a hardcoded peer.
  type SelfEv = { type: 'noop' };
  const sdom = defineDomain<'a' | 'b', SelfEv, Ctx, { count: number }, never>();
  const stayPut = { decide: (ctx: Ctx) => ({ context: ctx, next: SELF }) };
  const a = sdom.transitions('a', { noop: stayPut });
  const b = sdom.transitions('b', { noop: stayPut });

  it('resolves SELF to the enclosing state for state a', async () => {
    const out = await a.fn({ count: 1 }, { kind: 'event', event: { type: 'noop' }, timestamp: 't' });
    expect(out.next).toBe('a');
  });

  it('resolves the same shared handler to state b when reused there', async () => {
    const out = await b.fn({ count: 1 }, { kind: 'event', event: { type: 'noop' }, timestamp: 't' });
    expect(out.next).toBe('b');
  });

  it('never lets the raw sentinel escape', async () => {
    const out = await a.fn({ count: 1 }, { kind: 'event', event: { type: 'noop' }, timestamp: 't' });
    expect(out.next).not.toBe(SELF);
  });
});

// ── onSignals: per-kind signal dispatch (signal-side analogue of TransitionMap) ──
type SigCtx = { count: number; stampedAt?: string };
type Sig =
  | { kind: 'go'; by: number }
  | { kind: 'stamp' }
  | { kind: 'commit'; tag: string };

// External sink so we can observe that a per-kind finalize actually fired.
const committed: string[] = [];

const sd = defineDomain<'idle' | 'running', { type: never }, SigCtx, { count: number }, Sig>();

const idle = sd.transitions(
  'idle',
  {},
  {
    onSignals: {
      go: {
        // prepare → decide threading, signal-side.
        async prepare(_ctx, sig) {
          return { validated: sig.by };
        },
        decide(ctx, _sig, _meta, prepared) {
          return { context: { ...ctx, count: ctx.count + prepared.validated }, next: 'running' };
        },
      },
      stamp: {
        // meta.timestamp passthrough (option (a)).
        decide(ctx, _sig, meta) {
          return { context: { ...ctx, stampedAt: meta.timestamp }, next: 'idle' };
        },
      },
      commit: {
        decide(ctx, sig) {
          return { context: ctx, next: terminal('done'), finalize: { tag: sig.tag } };
        },
        async finalize(_ctx, decision) {
          committed.push((decision.finalize as { tag: string }).tag);
        },
      },
    },
  },
);

describe('onSignals (per-kind signal dispatch)', () => {
  it('routes a signal to its kind handler and threads prepare → decide', async () => {
    const out = await idle.fn({ count: 10 }, { kind: 'signal', result: { kind: 'go', by: 5 }, timestamp: 't' });
    expect(out.next).toBe('running');
    expect(out.context.count).toBe(15);
  });

  it('passes the deterministic meta.timestamp into the kind handler', async () => {
    const out = await idle.fn({ count: 0 }, { kind: 'signal', result: { kind: 'stamp' }, timestamp: '2026-06-26T00:00:00.000Z' });
    expect(out.context.stampedAt).toBe('2026-06-26T00:00:00.000Z');
    expect(out.next).toBe('idle');
  });

  it('fires the per-kind finalize after the decision', async () => {
    committed.length = 0;
    const out = await idle.fn({ count: 0 }, { kind: 'signal', result: { kind: 'commit', tag: 'acct-42' }, timestamp: 't' });
    expect(out.next).toBe('__terminal:done');
    expect(committed).toEqual(['acct-42']);
  });

  it('stays in the current state for a signal kind with no entry', async () => {
    const out = await idle.fn({ count: 7 }, { kind: 'signal', result: { kind: 'unknown' } as never, timestamp: 't' });
    expect(out.next).toBe('idle');
    expect(out.context.count).toBe(7);
  });
});
