/**
 * Pure helpers for the order-trace UI: snapshot diffing for the persisted transition
 * projection (ADR-0010) and Gantt window computation. No I/O and no server imports, so
 * they are safe to unit-test in isolation and to import from client components. Raw
 * Temporal execution history is not decoded here — each trace node deep-links to the
 * Temporal Web UI for that.
 */

// ============================================================================
// Snapshot diffing (persisted transitions, ADR-0010)
// ============================================================================

export interface SnapshotChange {
  /** Dotted/indexed path to the changed value, e.g. `order.status` or `items[1].quantity`. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Compute the field-level difference between two full context snapshots (the real before→after
 * delta enabled by ADR-0010's persisted snapshots). Recurses through objects and arrays; a
 * type mismatch or primitive change is reported as a single `changed` leaf. Bounded by
 * `maxChanges` so a huge divergence can't blow up the UI.
 */
export function diffSnapshots(prev: unknown, next: unknown, maxChanges = 200): SnapshotChange[] {
  const changes: SnapshotChange[] = [];

  const walk = (path: string, a: unknown, b: unknown): void => {
    if (changes.length >= maxChanges || a === b) return;

    if (isPlainObject(a) && isPlainObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (changes.length >= maxChanges) return;
        const p = path ? `${path}.${key}` : key;
        if (!(key in a)) changes.push({ path: p, kind: 'added', after: b[key] });
        else if (!(key in b)) changes.push({ path: p, kind: 'removed', before: a[key] });
        else walk(p, a[key], b[key]);
      }
      return;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) {
        if (changes.length >= maxChanges) return;
        const p = `${path}[${i}]`;
        if (i >= a.length) changes.push({ path: p, kind: 'added', after: b[i] });
        else if (i >= b.length) changes.push({ path: p, kind: 'removed', before: a[i] });
        else walk(p, a[i], b[i]);
      }
      return;
    }

    changes.push({ path: path || '(root)', kind: 'changed', before: a, after: b });
  };

  walk('', prev, next);
  return changes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gantt window computation
// ─────────────────────────────────────────────────────────────────────────────

export interface GanttWindow {
  /** Default view window (fits every non-OMS workflow's activity, padded). */
  start: number;
  end: number;
  /** Full data extent (all workflows; running ones extend to `now`). */
  fullStart: number;
  fullEnd: number;
}

interface GanttNodeLike {
  domain: string;
  startTime?: string | null;
  closeTime?: string | null;
  transitions?: Array<{ at: string }>;
}

/**
 * Compute the Gantt chart's default time window.
 *
 * The OMS order workflow stays Running for the order's whole life (365-day execution timeout),
 * so including its `now`-anchored end squashes the seconds-scale cart→fulfillment journey into
 * a sliver. The default window instead fits every workflow EXCEPT the order, and running
 * workflows contribute their last recorded transition (their last real activity) rather than
 * `now` — a still-open cart parked for hours must not stretch the axis either. The full extent
 * is retained for zoom-out clamping and clip indicators.
 */
export function computeGanttWindow(nodes: GanttNodeLike[], now: number): GanttWindow | null {
  const starts = nodes
    .map((n) => (n.startTime ? new Date(n.startTime).getTime() : null))
    .filter((t): t is number => t !== null && Number.isFinite(t));
  if (starts.length === 0) return null;

  const fullStart = Math.min(...starts);
  const fullEnd = Math.max(
    ...nodes.map((n) => (n.closeTime ? new Date(n.closeTime).getTime() : now)),
    fullStart + 1,
  );

  const lastActivity = (n: GanttNodeLike): number => {
    if (n.closeTime) return new Date(n.closeTime).getTime();
    const lastTransition = n.transitions?.length
      ? new Date(n.transitions[n.transitions.length - 1].at).getTime()
      : NaN;
    if (Number.isFinite(lastTransition)) return lastTransition;
    return n.startTime ? new Date(n.startTime).getTime() : fullStart;
  };

  const windowNodes = nodes.some((n) => n.domain !== 'oms')
    ? nodes.filter((n) => n.domain !== 'oms')
    : nodes;
  const rawEnd = Math.max(...windowNodes.map(lastActivity), fullStart + 1);

  // 5% padding on each side so bars don't touch the frame.
  const pad = Math.max((rawEnd - fullStart) * 0.05, 250);
  return {
    start: fullStart - pad,
    end: Math.min(rawEnd + pad, fullEnd),
    fullStart,
    fullEnd,
  };
}
