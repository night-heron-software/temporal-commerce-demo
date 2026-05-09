'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  searchElasticsearch,
  getIndexStats,
  type SearchResult,
  type SearchableIndex,
  type IndexStats
} from '../admin-search-actions';

const ALL_INDICES: { key: SearchableIndex; label: string; icon: string }[] = [
  { key: 'products', label: 'Products', icon: '📦' },
  { key: 'collections', label: 'Collections', icon: '📂' },
  { key: 'orders', label: 'Orders', icon: '🧾' },
  { key: 'customers', label: 'Customers', icon: '👤' },
  { key: 'suppliers', label: 'Suppliers', icon: '🏭' },
  { key: 'inventory', label: 'Inventory', icon: '📊' },
  { key: 'supplier_orders', label: 'Supplier Orders', icon: '🚚' },
  { key: 'carts', label: 'Carts', icon: '🛒' },
  { key: 'reservations', label: 'Reservations', icon: '🔒' },
  { key: 'fulfillments', label: 'Fulfillments', icon: '✅' },
  { key: 'shipments', label: 'Shipments', icon: '📬' },
];

export default function AdminSearchPage() {
  const [query, setQuery] = useState('');
  const [selectedIndices, setSelectedIndices] = useState<Set<SearchableIndex>>(
    new Set(ALL_INDICES.map(i => i.key))
  );
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [took, setTook] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedResult, setExpandedResult] = useState<string | null>(null);
  const [stats, setStats] = useState<IndexStats[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);

  // Load index stats on mount
  useEffect(() => {
    let active = true;
    getIndexStats().then(result => {
      if (!active) return;
      if (result.success) setStats(result.stats);
      setStatsLoading(false);
    });
    return () => { active = false; };
  }, []);

  const toggleIndex = (index: SearchableIndex) => {
    setSelectedIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const selectAll = () => setSelectedIndices(new Set(ALL_INDICES.map(i => i.key)));
  const selectNone = () => setSelectedIndices(new Set());

  const executeSearch = useCallback(async () => {
    if (selectedIndices.size === 0) {
      setError('Select at least one index to search.');
      return;
    }

    setIsSearching(true);
    setError(null);
    setHasSearched(true);
    setExpandedResult(null);

    const response = await searchElasticsearch(
      query,
      Array.from(selectedIndices),
      50
    );

    if (response.success) {
      setResults(response.results);
      setTotal(response.total);
      setTook(response.took);
    } else {
      setError(response.error || 'Search failed');
      setResults([]);
    }
    setIsSearching(false);
  }, [query, selectedIndices]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') executeSearch();
  };

  const toggleExpand = (key: string) => {
    setExpandedResult(prev => prev === key ? null : key);
  };

  const getDocCount = (index: string): number => {
    return stats.find(s => s.index === index)?.docCount ?? 0;
  };

  // Group results by index
  const groupedResults = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    if (!acc[r.index]) acc[r.index] = [];
    acc[r.index].push(r);
    return acc;
  }, {});

  const getResultSummary = (result: SearchResult): string => {
    const s = result.source;
    switch (result.index) {
      case 'products':
        return s.name || s.id;
      case 'collections':
        return s.name || s.id;
      case 'orders':
        return `${s.confirmationNumber || s.orderId} — ${s.customerEmail || ''} — ${s.status || ''}`;
      case 'customers':
        return `${s.email} — ${s.orderCount ?? 0} orders — $${((s.totalSpent ?? 0) / 100).toFixed(2)}`;
      case 'suppliers':
        return `${s.name || s.supplierId} — ${(s.locations ?? []).length} location(s)`;
      case 'inventory':
        return `${s.variantId} — ${s.availableStock ?? 0} available / ${s.totalStock ?? 0} total`;
      case 'supplier_orders':
        return `${s.supplierOrderId} → ${s.supplierName || s.supplierId} — ${s.status || ''}`;
      case 'carts':
        return `${s.cartId} — ${s.itemCount ?? 0} items — ${s.status || ''}`;
      case 'reservations':
        return `${s.reservationId} — cart ${s.cartId} — ${s.status || ''}`;
      case 'fulfillments':
        return `Order ${s.orderId} — ${s.status || ''}`;
      case 'shipments':
        return `${s.carrier || '?'} ${s.trackingNumber || ''} — Order ${s.orderId}`;
      default:
        return result.id;
    }
  };

  const getIndexMeta = (index: string) =>
    ALL_INDICES.find(i => i.key === index) ?? { key: index, label: index, icon: '📄' };

  return (
    <div className="max-w-7xl mx-auto p-6">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-1">
        🔍 Elasticsearch Explorer
      </h1>
      <p className="text-zinc-500 dark:text-zinc-400 text-sm mb-6">
        Query all domain indices — products, orders, inventory, carts, and more.
      </p>

      {/* Index chips */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
            Indices
          </span>
          <button
            onClick={selectAll}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            All
          </button>
          <button
            onClick={selectNone}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            None
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {ALL_INDICES.map(({ key, label, icon }) => {
            const selected = selectedIndices.has(key);
            const count = getDocCount(key);
            return (
              <button
                key={key}
                onClick={() => toggleIndex(key)}
                className={`
                  inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium
                  border transition-all duration-150
                  ${selected
                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                    : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-500'
                  }
                `}
              >
                <span>{icon}</span>
                <span>{label}</span>
                {!statsLoading && (
                  <span className={`
                    ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold
                    ${selected
                      ? 'bg-blue-500/30 text-blue-100'
                      : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400'
                    }
                  `}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Search bar */}
      <div className="flex gap-2 mb-6">
        <div className="relative flex-1">
          <input
            id="search-input"
            type="text"
            placeholder="Search across all selected indices (IDs, names, emails, statuses…)"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="
              w-full px-4 py-3 pl-10 rounded-lg border border-zinc-200 dark:border-zinc-700
              bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100
              placeholder:text-zinc-400 dark:placeholder:text-zinc-500
              focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500
              transition-all text-sm
            "
          />
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">🔎</span>
        </div>
        <button
          id="search-button"
          onClick={executeSearch}
          disabled={isSearching}
          className="
            px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm
            disabled:opacity-50 disabled:cursor-not-allowed transition-colors
            flex items-center gap-2
          "
        >
          {isSearching ? (
            <>
              <span className="animate-spin">⏳</span> Searching…
            </>
          ) : (
            'Search'
          )}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Results meta */}
      {hasSearched && !error && (
        <div className="mb-4 text-sm text-zinc-500 dark:text-zinc-400 flex items-center gap-3">
          <span>
            <strong className="text-zinc-900 dark:text-zinc-100">{total.toLocaleString()}</strong>{' '}
            result{total !== 1 ? 's' : ''}
          </span>
          <span className="text-zinc-300 dark:text-zinc-600">•</span>
          <span>{took}ms</span>
          <span className="text-zinc-300 dark:text-zinc-600">•</span>
          <span>
            {Object.keys(groupedResults).length} {Object.keys(groupedResults).length === 1 ? 'index' : 'indices'}
          </span>
        </div>
      )}

      {/* Grouped results */}
      {Object.entries(groupedResults).map(([index, hits]) => {
        const meta = getIndexMeta(index);
        return (
          <div key={index} className="mb-6">
            <div className="flex items-center gap-2 mb-2 sticky top-14 bg-zinc-50 dark:bg-zinc-900 py-2 z-10">
              <span className="text-lg">{meta.icon}</span>
              <h2 className="text-sm font-bold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider">
                {meta.label}
              </h2>
              <span className="text-xs text-zinc-400 dark:text-zinc-500 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-full">
                {hits.length} hit{hits.length !== 1 ? 's' : ''}
              </span>
            </div>

            <div className="space-y-1">
              {hits.map((hit) => {
                const key = `${hit.index}:${hit.id}`;
                const isExpanded = expandedResult === key;
                return (
                  <div
                    key={key}
                    className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden transition-shadow hover:shadow-sm"
                  >
                    <button
                      onClick={() => toggleExpand(key)}
                      className="w-full text-left px-4 py-3 flex items-center gap-3"
                    >
                      <span className={`
                        text-xs transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}
                      `}>
                        ▶
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-zinc-900 dark:text-zinc-100 truncate font-medium">
                          {getResultSummary(hit)}
                        </div>
                        <div className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono mt-0.5">
                          {hit.id}
                        </div>
                      </div>
                      <span className="text-[10px] text-zinc-400 dark:text-zinc-600 font-mono whitespace-nowrap">
                        score: {hit.score.toFixed(2)}
                      </span>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-zinc-100 dark:border-zinc-700 px-4 py-3 bg-zinc-50 dark:bg-zinc-900/50">
                        <pre className="text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words font-mono leading-relaxed max-h-96 overflow-auto">
                          {JSON.stringify(hit.source, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Empty state */}
      {hasSearched && !error && results.length === 0 && !isSearching && (
        <div className="text-center py-16">
          <div className="text-4xl mb-3">🔍</div>
          <p className="text-zinc-500 dark:text-zinc-400">
            No results found{query ? ` for "${query}"` : ''}.
          </p>
          <p className="text-zinc-400 dark:text-zinc-500 text-sm mt-1">
            Try a different query or select more indices.
          </p>
        </div>
      )}

      {/* Pre-search state */}
      {!hasSearched && !statsLoading && (
        <div className="text-center py-16">
          <div className="text-5xl mb-4">🗂️</div>
          <p className="text-zinc-600 dark:text-zinc-400 font-medium">
            {stats.reduce((sum, s) => sum + s.docCount, 0).toLocaleString()} documents across {stats.filter(s => s.docCount > 0).length} indices
          </p>
          <p className="text-zinc-400 dark:text-zinc-500 text-sm mt-1">
            Enter a query above or press Search to browse all documents.
          </p>
        </div>
      )}
    </div>
  );
}
