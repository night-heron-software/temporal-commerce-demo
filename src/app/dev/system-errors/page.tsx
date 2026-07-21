'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { RefreshButton } from '@/components/RefreshButton';
import type { ErrorLevel, SystemErrorHit, SystemErrorsResponse } from './errors-service';

const PAGE_SIZE = 50;

const LEVELS: { key: ErrorLevel | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'error', label: 'Error' },
  { key: 'fatal', label: 'Fatal' },
];

const SINCE_OPTIONS: { key: string; label: string }[] = [
  { key: '1h', label: 'Last hour' },
  { key: '24h', label: 'Last 24 hours' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
];

function levelClasses(level: ErrorLevel): string {
  return level === 'fatal'
    ? 'border-red-700 bg-red-900/40 text-red-300'
    : 'border-amber-700 bg-amber-900/40 text-amber-300';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function SystemErrorsPage() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [level, setLevel] = useState<ErrorLevel | 'all'>('all');
  const [since, setSince] = useState('24h');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<SystemErrorsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Debounce the free-text box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Filter changes reset paging at the source rather than in an effect, which would cascade.
  const changeLevel = useCallback((next: ErrorLevel | 'all') => {
    setLevel(next);
    setPage(1);
  }, []);

  const changeSince = useCallback((next: string) => {
    setSince(next);
    setPage(1);
  }, []);

  const changeQuery = useCallback((next: string) => {
    setQuery(next);
    setPage(1);
  }, []);

  const fetchErrors = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ since, page: String(page), pageSize: String(PAGE_SIZE) });
    if (debouncedQuery) params.set('q', debouncedQuery);
    if (level !== 'all') params.set('level', level);

    try {
      const res = await fetch(`/api/dev/system-errors?${params}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      setData(body as SystemErrorsResponse);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError((err as Error).message);
      setData(null);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [debouncedQuery, level, since, page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: loading/error reset before the async load is intentional
    void fetchErrors();
    return () => abortRef.current?.abort();
  }, [fetchErrors]);

  const clearAll = useCallback(async () => {
    if (!confirm('Delete every document in the system_errors index? This cannot be undone.')) {
      return;
    }
    try {
      const res = await fetch('/api/dev/system-errors', { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setExpanded(null);
      await fetchErrors();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [fetchErrors]);

  const hits = data?.hits ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-3xl font-bold">System Errors</h1>
          <div className="flex items-center gap-3">
            <RefreshButton onRefresh={fetchErrors} variant="dev" />
            <button
              onClick={clearAll}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-red-900/60 hover:bg-red-800 text-red-200 border border-red-700 transition-colors"
            >
              Clear all
            </button>
            <Link href="/admin" className="text-blue-400 hover:underline text-sm">
              ← Admin and Dev Tools
            </Link>
          </div>
        </div>
        <p className="text-gray-400 mb-6">
          Error and fatal log lines from the storefront and workers, forwarded to the{' '}
          <code className="text-gray-300">system_errors</code> index by the pino logger.
        </p>

        {/* Filter bar */}
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-6">
          <div className="flex gap-2 mb-3">
            {LEVELS.map((l) => (
              <button
                key={l.key}
                onClick={() => changeLevel(l.key)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  level === l.key
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => changeQuery(e.target.value)}
              placeholder="Search message text…"
              className="flex-1 px-3 py-2 rounded-lg bg-gray-950 border border-gray-700 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <select
              value={since}
              onChange={(e) => changeSince(e.target.value)}
              className="px-3 py-2 rounded-lg bg-gray-950 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
            >
              {SINCE_OPTIONS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 rounded-lg border border-red-700 bg-red-900/30 text-red-200 text-sm">
            <strong className="font-semibold">Query failed:</strong> {error}
            <p className="mt-1 text-red-300/80">
              The index is created by the first error logged — if nothing has failed yet, this is
              expected. Otherwise check that Elasticsearch is up.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between mb-3 text-sm text-gray-400">
          <span>
            {loading ? 'Loading…' : `${total} error${total === 1 ? '' : 's'}`}
            {total > 0 && ` — page ${page} of ${totalPages}`}
          </span>
          {totalPages > 1 && (
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-gray-200"
              >
                ← Prev
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-gray-200"
              >
                Next →
              </button>
            </div>
          )}
        </div>

        {!loading && !error && hits.length === 0 && (
          <div className="p-8 text-center text-gray-500 border border-gray-800 rounded-lg bg-gray-950">
            No errors in this window. That is the good outcome.
          </div>
        )}

        <div className="space-y-2">
          {hits.map((hit) => (
            <ErrorRow
              key={hit.errorId}
              hit={hit}
              expanded={expanded === hit.errorId}
              onToggle={() => setExpanded(expanded === hit.errorId ? null : hit.errorId)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ErrorRow({
  hit,
  expanded,
  onToggle,
}: {
  hit: SystemErrorHit;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-gray-750 transition-colors"
      >
        <span
          className={`shrink-0 mt-0.5 text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border ${levelClasses(hit.level)}`}
        >
          {hit.level}
        </span>
        <span className="shrink-0 mt-0.5 font-mono text-xs text-gray-500 w-40">
          {formatTime(hit.timestamp)}
        </span>
        {hit.component && (
          <span className="shrink-0 mt-0.5 font-mono text-xs text-blue-400 w-40 truncate">
            {hit.component}
          </span>
        )}
        <span className="flex-1 text-sm text-gray-200 truncate">{hit.message}</span>
        <span className="shrink-0 text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-700 bg-gray-950 px-4 py-3 space-y-3">
          <Detail label="Message">
            <pre className="whitespace-pre-wrap break-words">{hit.message}</pre>
          </Detail>

          {hit.stack && (
            <Detail label="Stack Trace">
              <pre className="whitespace-pre-wrap break-words">{hit.stack}</pre>
            </Detail>
          )}

          {hit.context && Object.keys(hit.context).length > 0 && (
            <Detail label="Context">
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(hit.context, null, 2)}
              </pre>
            </Detail>
          )}

          <p className="font-mono text-[11px] text-gray-600">Error ID: {hit.errorId}</p>
        </div>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">{label}</h3>
      <div className="font-mono text-xs text-gray-300 overflow-x-auto">{children}</div>
    </div>
  );
}
