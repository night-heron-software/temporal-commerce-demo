import { describe, it, expect } from 'vitest';
import { computeGanttWindow, diffSnapshots } from './history-decode';

describe('diffSnapshots', () => {
  it('reports changed, added, and removed leaves', () => {
    expect(diffSnapshots({ status: 'processing' }, { status: 'shipped' })).toEqual([
      { path: 'status', kind: 'changed', before: 'processing', after: 'shipped' },
    ]);
    expect(diffSnapshots({}, { note: 'hi' })).toEqual([
      { path: 'note', kind: 'added', after: 'hi' },
    ]);
    expect(diffSnapshots({ note: 'hi' }, {})).toEqual([
      { path: 'note', kind: 'removed', before: 'hi' },
    ]);
  });

  it('recurses into nested objects and arrays with path notation', () => {
    expect(diffSnapshots({ order: { status: 'a' } }, { order: { status: 'b' } })).toEqual([
      { path: 'order.status', kind: 'changed', before: 'a', after: 'b' },
    ]);
    expect(diffSnapshots({ items: [{ q: 1 }] }, { items: [{ q: 2 }, { q: 9 }] })).toEqual([
      { path: 'items[0].q', kind: 'changed', before: 1, after: 2 },
      { path: 'items[1]', kind: 'added', after: { q: 9 } },
    ]);
  });

  it('returns nothing for structurally equal snapshots and honors maxChanges', () => {
    expect(diffSnapshots({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toEqual([]);
    const big = diffSnapshots({}, { a: 1, b: 2, c: 3 }, 2);
    expect(big).toHaveLength(2);
  });
});

describe('computeGanttWindow', () => {
  const T0 = Date.parse('2026-07-22T12:00:00Z');
  const sec = (n: number) => new Date(T0 + n * 1000).toISOString();
  const NOW = T0 + 3600_000; // an hour later — the order workflow is still running

  it('fits the default window to non-OMS workflows, not the long-running order', () => {
    const win = computeGanttWindow(
      [
        { domain: 'cart', startTime: sec(0), closeTime: sec(20) },
        { domain: 'checkout', startTime: sec(5), closeTime: sec(15) },
        { domain: 'oms', startTime: sec(14), closeTime: null }, // running for an hour
        { domain: 'fulfillment', startTime: sec(16), closeTime: sec(40) },
      ],
      NOW,
    )!;

    // Window ends just past the last non-OMS activity (40s), nowhere near NOW.
    expect(win.end).toBeLessThan(T0 + 60_000);
    expect(win.end).toBeGreaterThanOrEqual(T0 + 40_000);
    expect(win.start).toBeLessThanOrEqual(T0);
    // Full extent still reaches the running order's now-anchored edge.
    expect(win.fullEnd).toBe(NOW);
  });

  it("uses a running workflow's last transition, not now (parked cart must not stretch the axis)", () => {
    const win = computeGanttWindow(
      [
        {
          domain: 'cart',
          startTime: sec(0),
          closeTime: null,
          transitions: [{ at: sec(3) }, { at: sec(12) }],
        },
        { domain: 'checkout', startTime: sec(5), closeTime: sec(15) },
      ],
      NOW,
    )!;
    expect(win.end).toBeLessThan(T0 + 30_000);
  });

  it('falls back to all nodes when only the order exists', () => {
    const win = computeGanttWindow([{ domain: 'oms', startTime: sec(0), closeTime: null }], NOW)!;
    expect(win.end).toBeGreaterThan(T0);
    expect(win.fullEnd).toBe(NOW);
  });

  it('returns null with no timed nodes', () => {
    expect(computeGanttWindow([{ domain: 'cart' }], NOW)).toBeNull();
  });
});

describe('computeGanttWindow', () => {
  const T0 = Date.parse('2026-07-22T12:00:00Z');
  const sec = (n: number) => new Date(T0 + n * 1000).toISOString();
  const NOW = T0 + 3600_000; // an hour later — the order workflow is still running

  it('fits the default window to non-OMS workflows, not the long-running order', () => {
    const win = computeGanttWindow(
      [
        { domain: 'cart', startTime: sec(0), closeTime: sec(20) },
        { domain: 'checkout', startTime: sec(5), closeTime: sec(15) },
        { domain: 'oms', startTime: sec(14), closeTime: null }, // running for an hour
        { domain: 'fulfillment', startTime: sec(16), closeTime: sec(40) },
      ],
      NOW,
    )!;

    // Window ends just past the last non-OMS activity (40s), nowhere near NOW.
    expect(win.end).toBeLessThan(T0 + 60_000);
    expect(win.end).toBeGreaterThanOrEqual(T0 + 40_000);
    expect(win.start).toBeLessThanOrEqual(T0);
    // Full extent still reaches the running order's now-anchored edge.
    expect(win.fullEnd).toBe(NOW);
  });

  it("uses a running workflow's last transition, not now (parked cart must not stretch the axis)", () => {
    const win = computeGanttWindow(
      [
        {
          domain: 'cart',
          startTime: sec(0),
          closeTime: null,
          transitions: [{ at: sec(3) }, { at: sec(12) }],
        },
        { domain: 'checkout', startTime: sec(5), closeTime: sec(15) },
      ],
      NOW,
    )!;
    expect(win.end).toBeLessThan(T0 + 30_000);
  });

  it('falls back to all nodes when only the order exists', () => {
    const win = computeGanttWindow([{ domain: 'oms', startTime: sec(0), closeTime: null }], NOW)!;
    expect(win.end).toBeGreaterThan(T0);
    expect(win.fullEnd).toBe(NOW);
  });

  it('returns null with no timed nodes', () => {
    expect(computeGanttWindow([{ domain: 'cart' }], NOW)).toBeNull();
  });
});
