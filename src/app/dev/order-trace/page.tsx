'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { RefreshButton } from '@/components/RefreshButton';
import {
  deriveTransitions,
  diffSnapshots,
  type SnapshotChange,
  type TransitionKind,
  type TransitionStep,
} from './history-decode';
import type {
  OrderTrace,
  TraceNode,
  TraceTransition,
  TraceActivityCall,
  OrderCandidate,
  TraceDomain,
  TraceStatusHistoryRow,
} from './trace-service';

// ─────────────────────────────────────────────────────────────────────────────
// Constants & Types
// ─────────────────────────────────────────────────────────────────────────────

type LookupMode = 'orderId' | 'confirmation' | 'email';

const MODES: { key: LookupMode; label: string; placeholder: string }[] = [
  { key: 'orderId', label: 'Order ID', placeholder: 'e.g. 7c9e6679-7425-40de-944b-e07fc1f90ae7' },
  { key: 'confirmation', label: 'Confirmation #', placeholder: 'e.g. M5XCXU2Y' },
  { key: 'email', label: 'Customer Email', placeholder: 'e.g. shopper@example.com' },
];

const DOMAIN_LABELS: Record<TraceDomain, string> = {
  cart: 'Cart',
  checkout: 'Checkout',
  oms: 'Order (OMS)',
  fulfillment: 'Fulfillment',
  'fulfiller-order': 'Fulfiller Order',
};

const DOMAIN_ACCENT: Record<TraceDomain, { border: string; badge: string; bar: string }> = {
  cart: {
    border: 'border-violet-700',
    badge: 'bg-violet-900 text-violet-200 border-violet-700',
    bar: 'bg-violet-600',
  },
  checkout: {
    border: 'border-blue-700',
    badge: 'bg-blue-900 text-blue-200 border-blue-700',
    bar: 'bg-blue-600',
  },
  oms: {
    border: 'border-cyan-700',
    badge: 'bg-cyan-900 text-cyan-200 border-cyan-700',
    bar: 'bg-cyan-600',
  },
  fulfillment: {
    border: 'border-amber-700',
    badge: 'bg-amber-900 text-amber-200 border-amber-700',
    bar: 'bg-amber-500',
  },
  'fulfiller-order': {
    border: 'border-orange-700',
    badge: 'bg-orange-900 text-orange-200 border-orange-700',
    bar: 'bg-orange-500',
  },
};

const STATUS_AUDIT_ACCENT = {
  border: 'border-emerald-700',
  badge: 'bg-emerald-900 text-emerald-200 border-emerald-700',
};

type TraceTab = 'event-history' | 'state-machines' | 'status-history';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmt(ts?: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function fmtTime(ts?: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function statusBadge(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('running')) return 'bg-blue-900 text-blue-200 border border-blue-700';
  if (s.includes('completed')) return 'bg-green-900 text-green-200 border border-green-700';
  if (s.includes('failed') || s.includes('terminated') || s.includes('timedout'))
    return 'bg-red-900 text-red-200 border border-red-700';
  if (s.includes('canceled') || s.includes('cancelled'))
    return 'bg-amber-900 text-amber-200 border border-amber-700';
  return 'bg-gray-700 text-gray-200 border border-gray-600';
}

/**
 * A stable "now" used as the end-time for still-running workflows. The clock is read in a
 * lazy `useState` initializer — the sanctioned place for an impure read — so render stays
 * pure (calling `Date.now()` directly in render is flagged by react-hooks/purity). Captured
 * once when the component mounts, which is ample for a point-in-time trace view.
 */
function useRenderNow(): number {
  return useState(() => Date.now())[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Parallelism detection
// ─────────────────────────────────────────────────────────────────────────────

/** Returns a map from workflowId → list of workflowIds that ran concurrently. */
function detectParallel(nodes: TraceNode[]): Map<string, TraceNode[]> {
  const now = Date.now();
  const result = new Map<string, TraceNode[]>();

  for (const a of nodes) {
    const aStart = a.startTime ? new Date(a.startTime).getTime() : now;
    const aEnd = a.closeTime ? new Date(a.closeTime).getTime() : now;
    const peers: TraceNode[] = [];

    for (const b of nodes) {
      if (a.workflowId === b.workflowId) continue;
      const bStart = b.startTime ? new Date(b.startTime).getTime() : now;
      const bEnd = b.closeTime ? new Date(b.closeTime).getTime() : now;
      // Overlap: a starts before b ends AND a ends after b starts
      if (aStart < bEnd && aEnd > bStart) peers.push(b);
    }
    result.set(a.workflowId, peers);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gantt timeline
// ─────────────────────────────────────────────────────────────────────────────

function GanttChart({ nodes }: { nodes: TraceNode[] }) {
  const now = useRenderNow();

  const times = nodes
    .flatMap((n) => [
      n.startTime ? new Date(n.startTime).getTime() : null,
      n.closeTime ? new Date(n.closeTime).getTime() : null,
    ])
    .filter((t): t is number => t !== null);

  if (times.length === 0) return null;

  const minT = Math.min(...times);
  // Cap the right edge: running workflows use "now", but don't stretch the axis too far
  const maxT = Math.max(...times.map((t) => t), now);
  const span = maxT - minT || 1;

  return (
    <div className="px-4 py-3 border-b border-gray-700 bg-gray-900/40">
      <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-3 font-semibold">
        Timeline · parallelism view
      </div>

      <div className="space-y-2">
        {nodes.map((node) => {
          const start = node.startTime ? new Date(node.startTime).getTime() : minT;
          const end = node.closeTime ? new Date(node.closeTime).getTime() : now;
          const leftPct = ((start - minT) / span) * 100;
          const widPct = Math.max(((end - start) / span) * 100, 0.4);
          const duration = end - start;
          const accent = DOMAIN_ACCENT[node.domain];
          const isRunning = !node.closeTime;

          return (
            <div key={node.workflowId} className="flex items-center gap-2 min-w-0">
              {/* Label */}
              <div className="w-28 shrink-0 text-xs text-right text-gray-400 truncate pr-1">
                {DOMAIN_LABELS[node.domain]}
              </div>

              {/* Bar track */}
              <div className="flex-1 relative h-5 bg-gray-950 rounded overflow-hidden">
                <div
                  className={`absolute top-0 h-full rounded ${accent.bar} ${isRunning ? 'opacity-80' : 'opacity-60'}`}
                  style={{ left: `${leftPct}%`, width: `${widPct}%` }}
                />
                {/* Running pulse stripe */}
                {isRunning && (
                  <div
                    className={`absolute top-0 h-full rounded ${accent.bar} animate-pulse opacity-30`}
                    style={{ left: `${leftPct}%`, width: `${widPct}%` }}
                  />
                )}
              </div>

              {/* Duration */}
              <div className="w-16 shrink-0 text-[10px] text-gray-500 text-left font-mono">
                {fmtDuration(duration)}
                {isRunning ? ' ⟳' : ''}
              </div>
            </div>
          );
        })}
      </div>

      {/* Time axis */}
      <div className="flex items-center gap-2 mt-2 text-[10px] text-gray-700 font-mono">
        <div className="w-28 shrink-0" />
        <div className="flex-1 flex justify-between">
          <span>{fmtTime(new Date(minT).toISOString())}</span>
          <span>{fmtTime(new Date(maxT).toISOString())}</span>
        </div>
        <div className="w-16 shrink-0" />
      </div>

      {/* Legend note */}
      <div className="text-[10px] text-gray-600 mt-1 pl-[8.5rem]">
        Overlapping bars run concurrently. ⟳ = still running.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// State Machines Tab
// ─────────────────────────────────────────────────────────────────────────────

function StateRow({
  node,
  forceOpen,
  full,
  parallelPeers,
}: {
  node: TraceNode;
  forceOpen: boolean;
  full: boolean;
  parallelPeers: TraceNode[];
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = forceOpen || localOpen;

  return (
    <>
      <tr
        className="border-t border-gray-800 hover:bg-gray-800/50 cursor-pointer select-none"
        onClick={() => setLocalOpen((v) => !v)}
      >
        <td className="px-3 py-2 w-5 text-gray-500 text-xs">{open ? '▾' : '▸'}</td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`inline-block px-2 py-0.5 rounded-full border text-xs font-mono ${DOMAIN_ACCENT[node.domain].badge}`}
            >
              {DOMAIN_LABELS[node.domain]}
            </span>
            {parallelPeers.length > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] text-yellow-500 bg-yellow-950/60 border border-yellow-800/50 rounded-full px-2 py-0.5 font-sans">
                ⟷ parallel with {parallelPeers.map((p) => DOMAIN_LABELS[p.domain]).join(', ')}
              </span>
            )}
          </div>
        </td>
        <td className="px-3 py-2">
          <span
            className={`inline-block px-2 py-0.5 rounded-full text-xs ${statusBadge(node.status)}`}
          >
            {node.status}
          </span>
        </td>
        <td
          className="px-3 py-2 font-mono text-xs text-gray-400 max-w-[240px]"
          onClick={(e) => e.stopPropagation()}
        >
          <ExpandableCell text={node.workflowId} />
        </td>
        <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
          {fmtTime(node.startTime)}
        </td>
        <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
          {fmtTime(node.closeTime)}
        </td>
        <td className="px-3 py-2 text-xs text-gray-500">{node.historyLength ?? '—'}</td>
        <td className="px-3 py-2 text-xs">
          <a
            href={node.temporalUiUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline whitespace-nowrap"
            onClick={(e) => e.stopPropagation()}
          >
            Temporal UI →
          </a>
        </td>
      </tr>
      {open && (
        <tr className="border-t border-gray-800 bg-gray-950">
          <td colSpan={8} className="px-4 py-3">
            <div className="text-xs text-gray-400 mb-2 font-medium uppercase tracking-wide">
              State transitions
            </div>
            <TransitionsTimeline node={node} forceOpen={forceOpen} full={full} />

            <div className="text-xs text-gray-400 mt-4 mb-1 font-medium uppercase tracking-wide">
              Live workflow state
              {node.state == null && (
                <span className="ml-2 text-gray-600 normal-case">(unavailable)</span>
              )}
            </div>
            <CodeBlock
              text={node.state == null ? 'null' : JSON.stringify(node.state, null, 2)}
              className="text-xs text-gray-300 max-h-80 leading-relaxed"
            />
          </td>
        </tr>
      )}
    </>
  );
}

// Domain workflows that expose a real state-name history in their queried state.
function extractStateHistory(
  state: unknown,
): { status: string; timestamp?: string; note?: string | null }[] | undefined {
  const sh = (state as { statusHistory?: unknown } | null)?.statusHistory;
  if (!Array.isArray(sh)) return undefined;
  return sh.filter(
    (e): e is { status: string; timestamp?: string; note?: string | null } =>
      Boolean(e) && typeof (e as { status?: unknown }).status === 'string',
  );
}

const TRANSITION_STYLE: Record<TransitionKind, { dot: string; tag: string; label: string }> = {
  start: { dot: 'bg-gray-400', tag: 'text-gray-400', label: 'start' },
  state: { dot: 'bg-cyan-400', tag: 'text-cyan-300', label: 'state' },
  update: { dot: 'bg-blue-400', tag: 'text-blue-300', label: 'update' },
  signal: { dot: 'bg-amber-400', tag: 'text-amber-300', label: 'signal' },
  child: { dot: 'bg-orange-400', tag: 'text-orange-300', label: 'child' },
  terminal: { dot: 'bg-emerald-400', tag: 'text-emerald-300', label: 'end' },
};

function TransitionRow({ step }: { step: TransitionStep }) {
  const [showPayload, setShowPayload] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const style = TRANSITION_STYLE[step.kind];
  const hasPayload = step.payload !== undefined && step.payload !== null;
  const hasResult = step.result !== undefined && step.result !== null;

  return (
    <li className="relative pl-4">
      <span
        className={`absolute -left-[5px] top-1.5 w-2 h-2 rounded-full ${style.dot} ring-2 ring-gray-950`}
      />
      <div className="flex items-baseline gap-2 flex-wrap">
        <span
          className={`text-[10px] uppercase tracking-wide font-semibold w-12 shrink-0 ${style.tag}`}
        >
          {style.label}
        </span>
        <span className="text-xs font-mono text-gray-200">
          {step.kind === 'state' ? (step.delta ?? `→ ${step.label}`) : step.label}
        </span>
        <span className="text-[10px] text-gray-600 font-mono">{fmtTime(step.at)}</span>
        {step.kind === 'state' && step.cause && (
          <span className="text-[10px] text-gray-500">
            caused by <span className="text-gray-400 font-mono">{step.cause}</span>
          </span>
        )}
        {step.note && <span className="text-[10px] text-gray-500">· {step.note}</span>}
        {hasPayload && (
          <button
            onClick={() => setShowPayload((v) => !v)}
            className="text-[10px] text-blue-400 hover:underline"
          >
            {showPayload ? '▾ payload' : '▸ payload'}
          </button>
        )}
        {hasResult && (
          <button
            onClick={() => setShowResult((v) => !v)}
            className="text-[10px] text-emerald-400 hover:underline"
          >
            {showResult ? '▾ result' : '▸ result'}
          </button>
        )}
      </div>
      {hasPayload && showPayload && (
        <div className="mt-1 mb-1">
          <CodeBlock
            text={JSON.stringify(step.payload, null, 2)}
            className="text-[11px] text-gray-300 max-h-64"
          />
        </div>
      )}
      {hasResult && showResult && (
        <div className="mt-1 mb-1">
          <CodeBlock
            text={JSON.stringify(step.result, null, 2)}
            className="text-[11px] text-emerald-300 max-h-64"
          />
        </div>
      )}
    </li>
  );
}

const TRIGGER_STYLE: Record<string, { dot: string; tag: string }> = {
  start: { dot: 'bg-gray-400', tag: 'text-gray-400' },
  update: { dot: 'bg-blue-400', tag: 'text-blue-300' },
  signal: { dot: 'bg-amber-400', tag: 'text-amber-300' },
  timeout: { dot: 'bg-cyan-400', tag: 'text-cyan-300' },
};

const CHANGE_STYLE: Record<SnapshotChange['kind'], string> = {
  added: 'text-green-400',
  removed: 'text-red-400',
  changed: 'text-amber-300',
};

/** Full, unabbreviated string form of a value — used for both copy and expand. */
function fullStr(v: unknown): string {
  if (v === undefined) return '∅';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Copy-to-clipboard button. Always copies the full, unabbreviated text it is given. */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy full content"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      className={`text-[10px] leading-none px-1 py-0.5 rounded border bg-gray-900/80 ${
        copied
          ? 'text-emerald-400 border-emerald-700'
          : 'text-gray-500 border-gray-700 hover:text-gray-200'
      } ${className ?? ''}`}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

/** A scrollable code box with a copy button in the corner that always yields the full text. */
function CodeBlock({ text, className }: { text: string; className?: string }) {
  return (
    <div className="relative">
      <CopyButton text={text} className="absolute top-1 right-1 z-10" />
      <pre
        className={`font-mono overflow-x-auto whitespace-pre-wrap break-words p-2 pr-10 bg-black/50 rounded border border-gray-800 ${className ?? ''}`}
      >
        {text}
      </pre>
    </div>
  );
}

function JsonBlock({ value, emptyLabel }: { value: unknown; emptyLabel?: string }) {
  const text = value === undefined ? (emptyLabel ?? '∅ (none)') : JSON.stringify(value, null, 2);
  return (
    <div className="mt-0.5 mb-1">
      <CodeBlock text={text} className="text-[11px] text-gray-300 max-h-72" />
    </div>
  );
}

/**
 * A diff value that may be abbreviated. Long values (>80 chars) render truncated with a `…`;
 * click to expand to the full, unabbreviated value (and again to collapse).
 */
function DiffValue({ value, color }: { value: unknown; color: string }) {
  const [open, setOpen] = useState(false);
  const full = fullStr(value);
  const long = full.length > 80;
  if (!long) return <span className={color}>{full}</span>;
  return (
    <span
      className={`${color} cursor-pointer hover:opacity-80`}
      title={open ? 'Click to collapse' : 'Click to show full value'}
      onClick={() => setOpen((v) => !v)}
    >
      {open ? full : full.slice(0, 80) + '…'}
    </span>
  );
}

/**
 * An id / detail string in a table cell. Truncated to the cell width by default; click to expand
 * to the full value (and collapse again). Copies the full value via the adjacent copy button.
 */
function ExpandableCell({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <span className="flex items-start gap-1 min-w-0">
      <span
        className={`min-w-0 cursor-pointer hover:text-gray-200 ${open ? 'break-all whitespace-pre-wrap' : 'truncate'}`}
        title="Click to expand / collapse"
        onClick={() => setOpen((v) => !v)}
      >
        {text}
      </span>
      <CopyButton text={text} className="shrink-0" />
    </span>
  );
}

/**
 * An activity arg / result value. Compact single-line JSON by default (truncated past 100 chars or
 * when it contains newlines); click to expand to pretty-printed JSON. Always copies the full value.
 */
function ActivityValue({ value, color }: { value: unknown; color: string }) {
  const [open, setOpen] = useState(false);
  const compact = JSON.stringify(value) ?? 'undefined';
  const pretty = JSON.stringify(value, null, 2) ?? 'undefined';
  const long = compact.length > 100 || pretty.includes('\n');
  return (
    <span className="inline-flex items-start gap-1 align-top">
      {open ? (
        <span className={`${color} whitespace-pre-wrap break-words`}>{pretty}</span>
      ) : (
        <span
          className={`${color} break-words ${long ? 'cursor-pointer hover:opacity-80' : ''}`}
          title={long ? 'Click to expand' : undefined}
          onClick={long ? () => setOpen(true) : undefined}
        >
          {long && compact.length > 100 ? compact.slice(0, 100) + '…' : compact}
        </span>
      )}
      {open && (
        <button
          type="button"
          className="text-[10px] text-blue-400 hover:underline shrink-0"
          onClick={() => setOpen(false)}
        >
          collapse
        </button>
      )}
      <CopyButton text={pretty} className="shrink-0" />
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">
      {children}
    </div>
  );
}

function DiffLines({ changes }: { changes: SnapshotChange[] }) {
  const copyText = changes
    .map((c) => {
      const sym = c.kind === 'changed' ? '~' : c.kind === 'added' ? '+' : '-';
      if (c.kind === 'changed')
        return `${sym} ${c.path}: ${fullStr(c.before)} → ${fullStr(c.after)}`;
      if (c.kind === 'added') return `${sym} ${c.path}: ${fullStr(c.after)}`;
      return `${sym} ${c.path}: ${fullStr(c.before)}`;
    })
    .join('\n');
  return (
    <div className="relative mt-0.5 text-[11px] font-mono bg-black/50 rounded border border-gray-800 p-2 pr-10 overflow-x-auto">
      <CopyButton text={copyText} className="absolute top-1 right-1 z-10" />
      {changes.map((c, i) => (
        <div key={i} className="whitespace-pre-wrap break-words">
          <span className={CHANGE_STYLE[c.kind]}>
            {c.kind === 'changed' ? '~' : c.kind === 'added' ? '+' : '-'}
          </span>{' '}
          <span className="text-gray-400">{c.path}</span>
          {c.kind === 'changed' && (
            <span className="text-gray-300">
              {': '}
              <DiffValue value={c.before} color="text-red-300" /> →{' '}
              <DiffValue value={c.after} color="text-green-300" />
            </span>
          )}
          {c.kind === 'added' && (
            <>
              {': '}
              <DiffValue value={c.after} color="text-green-300" />
            </>
          )}
          {c.kind === 'removed' && (
            <>
              {': '}
              <DiffValue value={c.before} color="text-red-300" />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function ActivityList({
  label,
  calls,
  accent,
}: {
  label: string;
  calls: TraceActivityCall[];
  accent: string;
}) {
  if (calls.length === 0) return null;
  return (
    <div className="mt-1">
      <div className="text-[10px] text-gray-500">
        {label} ({calls.length})
      </div>
      <ol className="mt-0.5 space-y-1 border-l border-gray-800 pl-2">
        {calls.map((c, i) => (
          <li key={i} className="text-[11px] font-mono">
            <span className={accent}>{c.name}</span>
            {c.args !== undefined && (
              <div className="pl-3 text-gray-500 whitespace-pre-wrap break-words">
                args: <ActivityValue value={c.args} color="text-gray-400" />
              </div>
            )}
            {c.error !== undefined ? (
              <div className="pl-3 text-red-300 whitespace-pre-wrap break-words">
                ✗ error: {c.error} <CopyButton text={c.error} className="ml-1" />
              </div>
            ) : c.result !== undefined ? (
              <div className="pl-3 text-gray-400 whitespace-pre-wrap break-words">
                → <ActivityValue value={c.result} color="text-emerald-300" />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * One persisted transition (ADR-0010), in Chassaing vocabulary. Collapsed → a one-line summary.
 * Expanded (level 1) → the Command (signal/update + payload) and the resulting State change, read
 * top-to-bottom as "this command changed that". `full` (level 2) additionally shows the state
 * before/after and the activities run in the `decide` (pre-decision) and `evolve` (post-decision
 * effect) phases with their args + results — a complete "what happened and why" for the transition.
 */
function PersistedTransitionRow({
  txn,
  prev,
  open,
  full,
  onToggle,
}: {
  txn: TraceTransition;
  prev?: TraceTransition;
  open: boolean;
  full: boolean;
  onToggle: () => void;
}) {
  const style = TRIGGER_STYLE[txn.triggerKind] ?? TRIGGER_STYLE.timeout;
  const hasPayload = txn.triggerPayload !== undefined && txn.triggerPayload !== null;
  const hasResult = txn.updateResult !== undefined && txn.updateResult !== null;
  const initial = prev?.contextSnapshot; // context entering this state = previous step's final
  const changes = useMemo(
    () => diffSnapshots(initial, txn.contextSnapshot),
    [initial, txn.contextSnapshot],
  );
  const nActs = txn.prepareActivities.length + txn.finalizeActivities.length;

  return (
    <li className="relative pl-4">
      <span
        className={`absolute -left-[5px] top-1.5 w-2 h-2 rounded-full ${style.dot} ring-2 ring-gray-950`}
      />
      <button
        onClick={onToggle}
        className="w-full text-left flex items-baseline gap-2 flex-wrap hover:bg-gray-800/40 rounded px-1 -mx-1"
      >
        <span className="text-gray-500 text-[10px] w-3 shrink-0">{open ? '▾' : '▸'}</span>
        <span className={`text-[10px] uppercase tracking-wide font-semibold ${style.tag}`}>
          {txn.triggerKind}
        </span>
        <span className="text-xs font-mono text-gray-200">
          {txn.fromState || '∅'} → {txn.toState}
        </span>
        {txn.triggerName && (
          <span className="text-[10px] text-gray-500">
            via <span className="text-gray-400 font-mono">{txn.triggerName}</span>
          </span>
        )}
        <span className="text-[10px] text-gray-600 font-mono">{fmtTime(txn.at)}</span>
        {changes.length > 0 && (
          <span className="text-[10px] text-amber-400/80">Δ{changes.length}</span>
        )}
        {nActs > 0 && <span className="text-[10px] text-gray-600">⚙ {nActs}</span>}
      </button>

      {open && (
        <div className="mt-1 mb-1 ml-3 pl-3 border-l border-gray-800 space-y-2">
          {/* Level 1: the command processed, and how state evolved */}
          <div>
            <SectionLabel>
              Command — {txn.triggerKind}
              {txn.triggerName ? ` · ${txn.triggerName}` : ''}
            </SectionLabel>
            {hasPayload ? (
              <JsonBlock value={txn.triggerPayload} />
            ) : (
              <div className="text-[11px] text-gray-600 italic mt-0.5">
                no command payload ({txn.triggerKind})
              </div>
            )}
          </div>
          <div>
            <SectionLabel>State change ({changes.length})</SectionLabel>
            {changes.length > 0 ? (
              <DiffLines changes={changes} />
            ) : (
              <div className="text-[11px] text-gray-600 italic mt-0.5">no state change</div>
            )}
          </div>

          {/* Activities run for this transition (decide → evolve), with args + results. Always
              shown on expand so the "what ran" is never hidden behind a toggle. */}
          <div>
            <SectionLabel>Activities ({nActs})</SectionLabel>
            {nActs === 0 ? (
              <div className="text-[11px] text-gray-600 italic mt-0.5">none</div>
            ) : (
              <>
                <ActivityList label="decide" calls={txn.prepareActivities} accent="text-cyan-300" />
                <ActivityList
                  label="evolve"
                  calls={txn.finalizeActivities}
                  accent="text-orange-300"
                />
              </>
            )}
          </div>

          {hasResult && (
            <div>
              <SectionLabel>
                Result — <span className="text-emerald-400">{txn.triggerName}</span>
              </SectionLabel>
              <JsonBlock value={txn.updateResult} />
            </div>
          )}

          {/* Full detail: the complete before/after context snapshots. */}
          {full && (
            <>
              <div>
                <SectionLabel>State before — {txn.fromState || '∅'}</SectionLabel>
                <JsonBlock value={initial} emptyLabel="∅ (no prior state)" />
              </div>
              <div>
                <SectionLabel>State after — {txn.toState}</SectionLabel>
                <JsonBlock value={txn.contextSnapshot} />
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Renders a workflow's transitions. Expand/collapse and "full detail" are driven from the tab-level
 * controls (via `forceOpen`/`full`) so one "Expand all" opens every state machine; individual rows
 * can still be toggled on top of the forced default.
 */
function PersistedTimeline({
  transitions,
  forceOpen,
  full,
}: {
  transitions: TraceTransition[];
  forceOpen: boolean;
  full: boolean;
}) {
  const [openMap, setOpenMap] = useState<Record<number, boolean>>({});
  const isOpen = (i: number) => openMap[i] ?? forceOpen;
  const toggle = (i: number) => setOpenMap((prev) => ({ ...prev, [i]: !isOpen(i) }));

  return (
    <ol className="relative border-l border-gray-800 ml-1.5 space-y-1.5">
      {transitions.map((txn, i) => (
        <PersistedTransitionRow
          key={`${txn.at}-${txn.seq}`}
          txn={txn}
          prev={transitions[i - 1]}
          open={isOpen(i)}
          full={full}
          onToggle={() => toggle(i)}
        />
      ))}
    </ol>
  );
}

function TransitionsTimeline({
  node,
  forceOpen,
  full,
}: {
  node: TraceNode;
  forceOpen: boolean;
  full: boolean;
}) {
  // Prefer the persisted projection (real from→to + snapshot diffs, ADR-0010); fall back to the
  // Temporal-history-derived timeline for workflows recorded before the projection existed.
  if (node.transitions.length > 0) {
    // Re-key on forceOpen so a tab-level Expand/Collapse-all resets any per-row overrides.
    return (
      <PersistedTimeline
        key={forceOpen ? 'all-open' : 'all-closed'}
        transitions={node.transitions}
        forceOpen={forceOpen}
        full={full}
      />
    );
  }

  const steps: TransitionStep[] = deriveTransitions(node.events, extractStateHistory(node.state));
  if (steps.length === 0) {
    return (
      <div className="text-xs text-gray-600 italic">
        No transitions recorded (no history events for this workflow).
      </div>
    );
  }
  return (
    <ol className="relative border-l border-gray-800 ml-1.5 space-y-1.5">
      {steps.map((s, i) => (
        <TransitionRow key={i} step={s} />
      ))}
    </ol>
  );
}

function StateMachinesTab({ trace }: { trace: OrderTrace }) {
  const [expandAll, setExpandAll] = useState(false);
  const [full, setFull] = useState(false);
  const parallelMap = useMemo(() => detectParallel(trace.nodes), [trace.nodes]);

  return (
    <div>
      {/* Gantt */}
      <GanttChart nodes={trace.nodes} />

      {/* Table toolbar — controls apply to every state machine's transitions at once */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-gray-700 bg-gray-800/30">
        <button
          onClick={() => setExpandAll(true)}
          className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
        >
          Expand all
        </button>
        <button
          onClick={() => setExpandAll(false)}
          className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
        >
          Collapse all
        </button>
        <label className="flex items-center gap-1 text-xs text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={full}
            onChange={(e) => setFull(e.target.checked)}
            className="accent-blue-500"
          />
          Full detail (before/after context snapshots)
        </label>
        <span className="text-xs text-gray-600 ml-auto">{trace.nodes.length} workflows</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead>
            <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-gray-700">
              <th className="px-3 py-2 w-5" />
              <th className="px-3 py-2">Domain</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Workflow ID</th>
              <th className="px-3 py-2">Started</th>
              <th className="px-3 py-2">Closed</th>
              <th className="px-3 py-2">Events</th>
              <th className="px-3 py-2">Links</th>
            </tr>
          </thead>
          <tbody>
            {trace.nodes.map((node) => (
              <StateRow
                key={node.workflowId}
                node={node}
                forceOpen={expandAll}
                full={full}
                parallelPeers={parallelMap.get(node.workflowId) ?? []}
              />
            ))}
          </tbody>
        </table>
        {trace.nodes.length === 0 && (
          <p className="text-gray-400 text-sm py-8 text-center">No workflows found.</p>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Event History Tab — grouped by workflow, each collapsible
// ─────────────────────────────────────────────────────────────────────────────

function WorkflowEventTable({ node }: { node: TraceNode }) {
  if (node.events.length === 0) {
    return <div className="px-4 py-2 text-xs text-gray-600 italic">No history events fetched.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-gray-600 uppercase text-[10px] tracking-wide font-sans border-b border-gray-800">
            <th className="px-3 py-1.5 text-left w-10">#</th>
            <th className="px-3 py-1.5 text-left whitespace-nowrap">Time</th>
            <th className="px-3 py-1.5 text-left">Event Type</th>
            <th className="px-3 py-1.5 text-left">Detail</th>
          </tr>
        </thead>
        <tbody>
          {node.events.map((ev, i) => (
            <tr
              key={`${ev.eventId}-${i}`}
              className="border-t border-gray-800/60 hover:bg-gray-800/30"
            >
              <td className="px-3 py-1 text-gray-600">{ev.eventId}</td>
              <td className="px-3 py-1 text-gray-500 whitespace-nowrap">{fmtTime(ev.timestamp)}</td>
              <td className="px-3 py-1 text-gray-200">{ev.eventType}</td>
              <td className="px-3 py-1 text-gray-400 max-w-sm">
                <ExpandableCell text={ev.detail ?? ''} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusAuditTable({ rows }: { rows: TraceStatusHistoryRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="px-4 py-2 text-xs text-gray-600 italic">No status history in Cassandra.</div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-gray-600 uppercase text-[10px] tracking-wide font-sans border-b border-gray-800">
            <th className="px-3 py-1.5 text-left whitespace-nowrap">Time</th>
            <th className="px-3 py-1.5 text-left">Status</th>
            <th className="px-3 py-1.5 text-left">Updated By</th>
            <th className="px-3 py-1.5 text-left">Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((h, i) => (
            <tr key={i} className="border-t border-gray-800/60 hover:bg-gray-800/30">
              <td className="px-3 py-1 text-gray-500 whitespace-nowrap">{fmt(h.eventTime)}</td>
              <td className="px-3 py-1">
                <span
                  className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] ${statusBadge(h.status)}`}
                >
                  {h.status}
                </span>
              </td>
              <td className="px-3 py-1 text-gray-400">{h.updatedBy}</td>
              <td className="px-3 py-1 text-gray-400">{h.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Group header for a workflow — shows parallel peers prominently
function WorkflowGroupHeader({
  node,
  open,
  onToggle,
  parallelPeers,
}: {
  node: TraceNode;
  open: boolean;
  onToggle: () => void;
  parallelPeers: TraceNode[];
}) {
  const accent = DOMAIN_ACCENT[node.domain];
  const now = useRenderNow();
  const start = node.startTime ? new Date(node.startTime).getTime() : now;
  const end = node.closeTime ? new Date(node.closeTime).getTime() : now;

  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-gray-800/50 text-left select-none"
    >
      <span className="text-gray-400 text-xs w-4 shrink-0">{open ? '▾' : '▸'}</span>

      <span
        className={`inline-block px-2 py-0.5 rounded-full border text-xs shrink-0 ${accent.badge}`}
      >
        {DOMAIN_LABELS[node.domain]}
      </span>

      <span
        className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] shrink-0 ${statusBadge(node.status)}`}
      >
        {node.status}
      </span>

      {/* Parallel indicator */}
      {parallelPeers.length > 0 && (
        <span className="inline-flex items-center gap-1 text-[10px] text-yellow-400 bg-yellow-950/50 border border-yellow-800/50 rounded-full px-2 py-0.5 shrink-0">
          ⟷ concurrent with {parallelPeers.map((p) => DOMAIN_LABELS[p.domain]).join(' + ')}
        </span>
      )}

      <code className="text-[10px] text-gray-600 truncate hidden sm:inline min-w-0">
        {node.workflowId}
      </code>

      <span className="ml-auto text-[10px] text-gray-600 shrink-0 whitespace-nowrap font-mono">
        {fmtDuration(end - start)} · {node.events.length} events
      </span>

      <a
        href={node.temporalUiUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-500 hover:text-blue-400 text-[11px] ml-2 shrink-0 whitespace-nowrap"
        onClick={(e) => e.stopPropagation()}
      >
        Temporal UI →
      </a>
    </button>
  );
}

function EventHistoryTab({ trace }: { trace: OrderTrace }) {
  const parallelMap = useMemo(() => detectParallel(trace.nodes), [trace.nodes]);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const [globalOpen, setGlobalOpen] = useState(true);

  const isOpen = (id: string) => openMap[id] ?? globalOpen;
  const toggle = (id: string) => setOpenMap((prev) => ({ ...prev, [id]: !isOpen(id) }));
  const expandAll = () => {
    setGlobalOpen(true);
    setOpenMap({});
  };
  const collapseAll = () => {
    setGlobalOpen(false);
    setOpenMap({});
  };

  const totalEvents = trace.nodes.reduce((s, n) => s + n.events.length, 0);

  return (
    <div>
      {/* Gantt mini-view */}
      <GanttChart nodes={trace.nodes} />

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-gray-700 bg-gray-800/30">
        <button
          onClick={expandAll}
          className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
        >
          Expand All
        </button>
        <span className="text-gray-700 text-xs">|</span>
        <button
          onClick={collapseAll}
          className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
        >
          Collapse All
        </button>
        <span className="ml-auto text-xs text-gray-600">
          {totalEvents} Temporal events · {trace.statusHistory.length} audit entries ·{' '}
          {trace.nodes.length} workflows
        </span>
      </div>

      {/* Workflow sections */}
      <div className="divide-y divide-gray-800">
        {trace.nodes.map((node) => (
          <div key={node.workflowId} className={`border-l-2 ${DOMAIN_ACCENT[node.domain].border}`}>
            <WorkflowGroupHeader
              node={node}
              open={isOpen(node.workflowId)}
              onToggle={() => toggle(node.workflowId)}
              parallelPeers={parallelMap.get(node.workflowId) ?? []}
            />
            {isOpen(node.workflowId) && <WorkflowEventTable node={node} />}
          </div>
        ))}

        {/* OMS Audit Trail */}
        {trace.statusHistory.length > 0 && (
          <div className={`border-l-2 ${STATUS_AUDIT_ACCENT.border}`}>
            <button
              onClick={() => toggle('__audit__')}
              className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-gray-800/50 text-left select-none"
            >
              <span className="text-gray-400 text-xs w-4 shrink-0">
                {isOpen('__audit__') ? '▾' : '▸'}
              </span>
              <span
                className={`inline-block px-2 py-0.5 rounded-full border text-xs shrink-0 ${STATUS_AUDIT_ACCENT.badge}`}
              >
                OMS Audit
              </span>
              <span className="text-xs text-gray-500 ml-2">Cassandra status history</span>
              <span className="ml-auto text-[10px] text-gray-600 shrink-0">
                {trace.statusHistory.length} entries
              </span>
            </button>
            {isOpen('__audit__') && <StatusAuditTable rows={trace.statusHistory} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Status History Tab
// ─────────────────────────────────────────────────────────────────────────────

function StatusHistoryTab({ trace }: { trace: OrderTrace }) {
  if (trace.statusHistory.length === 0) {
    return (
      <p className="text-gray-400 text-sm py-8 text-center">
        No OMS status history found in Cassandra.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-gray-700">
            <th className="px-3 py-2">Time</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Updated By</th>
            <th className="px-3 py-2">Note</th>
          </tr>
        </thead>
        <tbody>
          {trace.statusHistory.map((h, i) => (
            <tr key={i} className="border-t border-gray-800 hover:bg-gray-800/40">
              <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{fmt(h.eventTime)}</td>
              <td className="px-3 py-2">
                <span
                  className={`inline-block px-2 py-0.5 rounded-full text-xs ${statusBadge(h.status)}`}
                >
                  {h.status}
                </span>
              </td>
              <td className="px-3 py-2 text-gray-400 font-mono text-xs">{h.updatedBy}</td>
              <td className="px-3 py-2 text-gray-400">{h.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabbed trace view
// ─────────────────────────────────────────────────────────────────────────────

function TraceTabs({ trace }: { trace: OrderTrace }) {
  const [tab, setTab] = useState<TraceTab>('state-machines');
  const totalEvents = trace.nodes.reduce((s, n) => s + n.events.length, 0);

  const tabs: { key: TraceTab; label: string; count?: number }[] = [
    { key: 'state-machines', label: 'State Machines', count: trace.nodes.length },
    {
      key: 'event-history',
      label: 'Event History',
      count: totalEvents + trace.statusHistory.length,
    },
    { key: 'status-history', label: 'Status History', count: trace.statusHistory.length },
  ];

  return (
    <div>
      {/* Order metadata */}
      <div className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-400">
        <span className="inline-flex items-center gap-1">
          <span className="text-gray-500 mr-1">Order</span>
          <code className="text-gray-200">{trace.orderId}</code>
          <CopyButton text={trace.orderId} />
        </span>
        {trace.cartId && (
          <span
            className="inline-flex items-center gap-1"
            title="CorrelationId (= cartId, ADR-0011)"
          >
            <span className="text-gray-500 mr-1">Correlation</span>
            <code className="text-violet-300">{trace.cartId}</code>
            <CopyButton text={trace.cartId} />
          </span>
        )}
        {trace.confirmationNumber && (
          <span className="inline-flex items-center gap-1">
            <span className="text-gray-500 mr-1">Confirmation</span>
            <code className="text-gray-200">{trace.confirmationNumber}</code>
            <CopyButton text={trace.confirmationNumber} />
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <span className="text-gray-500 mr-1">Store</span>
          <code className="text-gray-200">{trace.storeId}</code>
          <CopyButton text={trace.storeId} />
        </span>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-700">
        {tabs.map((t) => (
          <button
            key={t.key}
            id={`tab-${t.key}`}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg border border-b-0 transition-colors ${
              tab === t.key
                ? 'bg-gray-800 border-gray-700 text-white'
                : 'bg-transparent border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span
                className={`ml-2 text-xs px-1.5 py-0.5 rounded-full ${tab === t.key ? 'bg-gray-700 text-gray-300' : 'bg-gray-800 text-gray-500'}`}
              >
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Panel */}
      <div className="bg-gray-800 rounded-b-lg rounded-tr-lg border border-gray-700 border-t-0 min-h-[300px] overflow-hidden">
        {tab === 'event-history' && <EventHistoryTab trace={trace} />}
        {tab === 'state-machines' && <StateMachinesTab trace={trace} />}
        {tab === 'status-history' && <StatusHistoryTab trace={trace} />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page root
// ─────────────────────────────────────────────────────────────────────────────

export default function OrderTracePage() {
  const [mode, setMode] = useState<LookupMode>('orderId');
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<OrderTrace | null>(null);
  const [candidates, setCandidates] = useState<OrderCandidate[] | null>(null);

  const fetchTrace = useCallback(async (params: Record<string, string>) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams(params).toString();
      const res = await fetch(`/api/dev/order-trace?${qs}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || `Request failed (${res.status})`);
        setTrace(null);
        setCandidates(null);
        return;
      }
      if (data.candidates) {
        setCandidates(data.candidates as OrderCandidate[]);
        setTrace(null);
      } else {
        setTrace(data.trace as OrderTrace);
        setCandidates(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unexpected error');
    } finally {
      setLoading(false);
    }
  }, []);

  const doLookup = useCallback(() => {
    const v = value.trim();
    if (!v) return;
    fetchTrace({ [mode]: v });
  }, [fetchTrace, mode, value]);

  // Deep-link support: /dev/order-trace?orderId=… (or confirmation= / email=) pre-fills the
  // lookup and runs it on mount, so admin order entries can link straight to a trace.
  // Read from window.location instead of useSearchParams to avoid the Suspense-boundary
  // requirement; the mount-only setState is deliberate (a lazy useState initializer would
  // read window during SSR and cause a hydration mismatch on the input value).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    for (const m of MODES) {
      const v = params.get(m.key)?.trim();
      if (v) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot deep-link init
        setMode(m.key);
        setValue(v);
        fetchTrace({ [m.key]: v });
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only deep-link read
  }, []);

  const refresh = useCallback(async () => {
    if (trace) await fetchTrace({ orderId: trace.orderId });
    else if (value.trim()) await fetchTrace({ [mode]: value.trim() });
  }, [fetchTrace, mode, trace, value]);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-3xl font-bold">Order Trace</h1>
          <div className="flex items-center gap-3">
            {(trace || candidates) && <RefreshButton onRefresh={refresh} variant="dev" />}
            <Link href="/admin" className="text-blue-400 hover:underline text-sm">
              ← Admin and Dev Tools
            </Link>
          </div>
        </div>
        <p className="text-gray-400 mb-6">
          Full cross-domain lifecycle: cart → checkout → OMS → fulfillment → fulfiller orders.
        </p>

        {/* Lookup bar */}
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-6">
          <div className="flex gap-2 mb-3">
            {MODES.map((m) => (
              <button
                key={m.key}
                id={`lookup-mode-${m.key}`}
                onClick={() => setMode(m.key)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  mode === m.key
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              id="lookup-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doLookup()}
              placeholder={MODES.find((m) => m.key === mode)?.placeholder}
              className="flex-1 px-3 py-2 rounded-lg bg-gray-950 border border-gray-700 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <button
              id="lookup-submit"
              onClick={doLookup}
              disabled={loading || !value.trim()}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50"
            >
              {loading ? 'Tracing…' : 'Trace'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-3 bg-red-950 border border-red-800 rounded-lg text-red-200 text-sm">
            {error}
          </div>
        )}

        {candidates && (
          <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-6">
            <h2 className="text-lg font-semibold mb-3">
              {candidates.length} orders found — pick one
            </h2>
            {candidates.length === 0 ? (
              <p className="text-gray-400 text-sm">No orders for that email.</p>
            ) : (
              <ul className="divide-y divide-gray-700">
                {candidates.map((c) => (
                  <li key={c.orderId}>
                    <button
                      onClick={() => fetchTrace({ orderId: c.orderId })}
                      className="w-full text-left py-2 flex flex-wrap justify-between gap-2 hover:bg-gray-700 px-2 rounded"
                    >
                      <span className="text-blue-400">{c.confirmationNumber || c.orderId}</span>
                      <span className="text-gray-400 text-sm">
                        {c.status} · {(c.total / 100).toFixed(2)} {c.currency} · {fmt(c.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {trace && <TraceTabs trace={trace} />}
      </div>
    </div>
  );
}
