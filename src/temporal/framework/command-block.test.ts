import { describe, it, expect } from 'vitest';

import { deriveRoutes, assembleEvolve } from './command-block';
import type { RouteMap, EvolveMap } from './command-block';
import { terminal } from './authoring';
import { SELF } from './types';

// A miniature machine, standing in for a domain: two live states, two terminals.
type St = 'active' | 'checkout';
type Ev = { type: 'Entered' } | { type: 'Abandoned' } | { type: 'Completed' } | { type: 'Touched' };
type Ctx = { count: number; note: string };

const routes = (r: RouteMap<St, Ev>) => ({ routes: r });

describe('deriveRoutes — the three laws', () => {
  it('merges shared routed events when every emitter declares the same destination', () => {
    // Value-equal duplicates are the premise, not an exception: an event's destination is a
    // machine-global fact, so three blocks may all declare it.
    expect(
      deriveRoutes<St, Ev>('test', {
        a: routes({ Abandoned: terminal('abandoned') }),
        b: routes({ Abandoned: terminal('abandoned') }),
        c: routes({ Abandoned: terminal('abandoned'), Entered: 'checkout' }),
      }),
    ).toEqual({ Abandoned: terminal('abandoned'), Entered: 'checkout' });
  });

  it('carries the wildcard and an explicit weaken-to-SELF through extras', () => {
    expect(
      deriveRoutes<St, Ev>(
        'test',
        { a: routes({ Entered: 'checkout' }) },
        { Entered: SELF, '*': SELF },
      ),
    ).toEqual({ Entered: SELF, '*': SELF });
  });

  it('leaves an undeclared event out of the table entirely (absence means "stays")', () => {
    const table = deriveRoutes<St, Ev>('test', { a: routes({ Entered: 'checkout' }) });
    expect(table).toEqual({ Entered: 'checkout' });
    expect('Touched' in table).toBe(false);
  });

  it('law 1 — throws when two blocks give one event different destinations', () => {
    expect(() =>
      deriveRoutes<St, Ev>('test', {
        a: routes({ Entered: 'checkout' }),
        b: routes({ Entered: 'active' }),
      }),
    ).toThrow(/two destinations in one state/);
  });

  it('law 2 — throws when extras REDIRECT rather than weaken to SELF', () => {
    expect(() =>
      deriveRoutes<St, Ev>('test', { a: routes({ Entered: 'checkout' }) }, { Entered: 'active' }),
    ).toThrow(/may only weaken to SELF/);
  });

  it('law 3 — throws when a state with commands derives an empty table', () => {
    expect(() => deriveRoutes<St, Ev>('test', { a: {} })).toThrow(/empty route table/);
  });

  it('derives an empty table without throwing when there are no commands at all', () => {
    expect(deriveRoutes<St, Ev>('test', {})).toEqual({});
  });

  it('names the domain in every throw, so a violation says which machine it came from', () => {
    const of = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('expected a throw');
    };
    expect(of(() => deriveRoutes<St, Ev>('oms', { a: {} }))).toMatch(/^oms route assembly:/);
    expect(
      of(() =>
        deriveRoutes<St, Ev>('oms', {
          a: routes({ Entered: 'checkout' }),
          b: routes({ Entered: 'active' }),
        }),
      ),
    ).toMatch(/^oms route assembly:/);
    expect(
      of(() =>
        deriveRoutes<St, Ev>('oms', { a: routes({ Entered: 'checkout' }) }, { Entered: 'active' }),
      ),
    ).toMatch(/^oms route extras:/);
  });
});

describe('assembleEvolve', () => {
  const bump = (ctx: Ctx) => ({ ...ctx, count: ctx.count + 1 });
  const note = (ctx: Ctx) => ({ ...ctx, note: 'x' });

  it('merges every block’s evolve map into one event → entry table', () => {
    const merged = assembleEvolve<Ev, Ctx>('test', [
      { evolve: { Entered: bump } },
      { evolve: { Completed: note } },
      {},
    ]);
    expect(Object.keys(merged).sort()).toEqual(['Completed', 'Entered']);
    expect(merged.Entered).toBe(bump);
  });

  it('accepts a duplicate key when both blocks share ONE named function', () => {
    const merged = assembleEvolve<Ev, Ctx>('test', [
      { evolve: { Abandoned: bump } },
      { evolve: { Abandoned: bump } },
    ]);
    expect(merged.Abandoned).toBe(bump);
  });

  it('throws when two blocks inline different code for one event', () => {
    expect(() =>
      assembleEvolve<Ev, Ctx>('test', [
        { evolve: { Abandoned: bump } },
        { evolve: { Abandoned: (ctx: Ctx) => ({ ...ctx, count: 0 }) } },
      ]),
    ).toThrow(/two different evolve entries/);
  });

  it('names the domain in the throw', () => {
    try {
      assembleEvolve<Ev, Ctx>('cart', [
        { evolve: { Abandoned: bump } },
        { evolve: { Abandoned: note } },
      ]);
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).toMatch(/^cart evolve assembly:/);
    }
  });

  it('is a no-op for blocks with no evolve entries', () => {
    const empty: EvolveMap<Ev, Ctx> = assembleEvolve<Ev, Ctx>('test', [{}, {}]);
    expect(empty).toEqual({});
  });
});
