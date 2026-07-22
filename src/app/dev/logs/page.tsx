'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { RefreshButton } from '@/components/RefreshButton';
import type { LogHit, LogLevelName, SystemLogsResponse } from './logs-service';

const PAGE_SIZE = 50;

const LEVELS: { key: LogLevelName | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'debug', label: 'Debug' },
  { key: 'info', label: 'Info' },
  { key: 'warn', label: 'Warn' },
  { key: 'error', label: 'Error' },
  { key: 'fatal', label: 'Fatal' },
];

const SINCE_OPTIONS: { key: string; label: string }[] = [
  { key: '15m', label: 'Last 15 minutes' },
  { key: '1h', label: 'Last hour' },
  { key: '24h', label: 'Last 24 hours' },
  { key: '7d', label: 'Last 7 days' },
];

function levelBadgeStyle(level: LogLevelName): string {
  switch (level) {
    case 'fatal':
      return 'border-purple-700 bg-purple-900/50 text-purple-300';
    case 'error':
      return 'border-red-700 bg-red-900/50 text-red-300';
    case 'warn':
      return 'border-amber-700 bg-amber-900/50 text-amber-300';
    case 'info':
      return 'border-blue-700 bg-blue-900/50 text-blue-300';
    case 'debug':
      return 'border-emerald-700 bg-emerald-900/50 text-emerald-300';
    case 'trace':
    default:
      return 'border-gray-700 bg-gray-800 text-gray-400';
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function SystemLogsPage() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [level, setLevel] = useState<LogLevelName | 'all'>('all');
  const [service, setService] = useState('all');
  const [since, setSince] = useState('24h');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<SystemLogsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const changeLevel = useCallback((next: LogLevelName | 'all') => {
    setLevel(next);
    setPage(1);
  }, []);

  const changeService = useCallback((next: string) => {
    setService(next);
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

  const fetchLogs = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ since, page: String(page), pageSize: String(PAGE_SIZE) });
    if (service !== 'all') params.set('service', service);
    if (level !== 'all') params.set('level', level);
    if (debouncedQuery) params.set('q', debouncedQuery);

    try {
      const res = await fetch(`/api/dev/logs?${params}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      setData(body as SystemLogsResponse);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError((err as Error).message);
      setData(null);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [debouncedQuery, level, service, since, page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: loading/error reset before the async load is intentional
    void fetchLogs();
    return () => abortRef.current?.abort();
  }, [fetchLogs]);

  const hits = data?.hits ?? [];
  const total = data?.total ?? 0;
  const availableServices = data?.availableServices ?? [];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-3xl font-bold">System Logs</h1>
          <div className="flex items-center gap-3">
            <RefreshButton onRefresh={fetchLogs} variant="dev" />
            <Link href="/admin" className="text-blue-400 hover:underline text-sm">
              ← Admin and Dev Tools
            </Link>
          </div>
        </div>
        <p className="text-gray-400 mb-6">
          Live structured log lines from the storefront, workers, and scripts, parsed directly from
          the machine-readable log directory.
        </p>

        {/* Filter bar */}
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            {/* Level Selector */}
            <div className="flex gap-1.5 flex-wrap">
              {LEVELS.map((l) => (
                <button
                  key={l.key}
                  onClick={() => changeLevel(l.key)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                    level === l.key
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>

            {/* Service & Time drop-downs */}
            <div className="flex items-center gap-2">
              <select
                value={service}
                onChange={(e) => changeService(e.target.value)}
                className="px-3 py-1.5 rounded-lg bg-gray-950 border border-gray-700 text-xs text-gray-100 focus:outline-none focus:border-blue-500"
              >
                <option value="all">All Services</option>
                {availableServices.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>

              <select
                value={since}
                onChange={(e) => changeSince(e.target.value)}
                className="px-3 py-1.5 rounded-lg bg-gray-950 border border-gray-700 text-xs text-gray-100 focus:outline-none focus:border-blue-500"
              >
                {SINCE_OPTIONS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Search Input */}
          <div>
            <input
              value={query}
              onChange={(e) => changeQuery(e.target.value)}
              placeholder="Search message text, workflow IDs, or context fields…"
              className="w-full px-3 py-2 rounded-lg bg-gray-950 border border-gray-700 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 rounded-lg border border-red-700 bg-red-900/30 text-red-200 text-sm">
            <strong className="font-semibold">Query failed:</strong> {error}
          </div>
        )}

        <div className="flex items-center justify-between mb-3 text-sm text-gray-400">
          <span>
            {loading ? 'Loading…' : `${total} log line${total === 1 ? '' : 's'}`}
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
            No log lines found matching the selected filters.
          </div>
        )}

        <div className="space-y-2 font-mono text-xs">
          {hits.map((hit) => (
            <LogRow
              key={hit.id}
              hit={hit}
              expanded={expanded === hit.id}
              onToggle={() => setExpanded(expanded === hit.id ? null : hit.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function LogRow({
  hit,
  expanded,
  onToggle,
}: {
  hit: LogHit;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-850 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-3 px-4 py-2.5 text-left hover:bg-gray-800 transition-colors"
      >
        <span
          className={`shrink-0 mt-0.5 text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border ${levelBadgeStyle(hit.level)}`}
        >
          {hit.level}
        </span>

        <span className="shrink-0 mt-0.5 text-gray-400 w-44">{formatTime(hit.timestamp)}</span>

        <span className="shrink-0 mt-0.5 text-purple-400 font-semibold px-1.5 py-0.5 rounded bg-purple-950/60 border border-purple-800/60 text-[10px]">
          {hit.service}
        </span>

        {hit.taskQueue && (
          <span className="shrink-0 mt-0.5 text-amber-400 font-semibold px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-800/60 text-[10px]">
            {hit.taskQueue}
          </span>
        )}

        {hit.component && (
          <span className="shrink-0 mt-0.5 text-blue-400 w-28 truncate">{hit.component}</span>
        )}

        <span className="flex-1 text-gray-200 truncate">{hit.message}</span>
        <span className="shrink-0 text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-800 bg-gray-950 px-4 py-3 space-y-3">
          {(hit.taskQueue || hit.workflowType || hit.activityType) && (
            <div className="flex flex-wrap gap-4 text-xs font-mono bg-gray-900 p-2.5 rounded border border-gray-800 text-gray-300">
              {hit.taskQueue && (
                <div>
                  <span className="text-gray-500">Queue:</span>{' '}
                  <span className="text-amber-400 font-semibold">{hit.taskQueue}</span>
                </div>
              )}
              {hit.workflowType && (
                <div>
                  <span className="text-gray-500">Workflow:</span>{' '}
                  <span className="text-blue-400">{hit.workflowType}</span>
                </div>
              )}
              {hit.activityType && (
                <div>
                  <span className="text-gray-500">Activity:</span>{' '}
                  <span className="text-emerald-400">{hit.activityType}</span>
                </div>
              )}
            </div>
          )}

          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">
              Message
            </h3>
            <pre className="whitespace-pre-wrap break-words text-gray-200">{hit.message}</pre>
          </div>

          {hit.context && Object.keys(hit.context).length > 0 && (
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">
                Context Payload
              </h3>
              <pre className="whitespace-pre-wrap break-words text-gray-300 bg-gray-900 p-3 rounded border border-gray-800">
                {JSON.stringify(hit.context, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
