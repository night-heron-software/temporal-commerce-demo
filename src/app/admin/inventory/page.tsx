'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  getInventoryStock,
  getInventoryReservations,
  getInventoryStats,
  type StockSummaryRow,
  type ReservationRow,
  type InventoryStats,
} from '../admin-inventory-actions';

type Tab = 'stock' | 'reservations';

export default function AdminInventoryPage() {
  const [tab, setTab] = useState<Tab>('stock');
  const [stock, setStock] = useState<StockSummaryRow[]>([]);
  const [reservations, setReservations] = useState<ReservationRow[]>([]);
  const [stats, setStats] = useState<InventoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stockFilter, setStockFilter] = useState<'all' | 'reserved' | 'low'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const [stockResult, reservationResult, statsResult] = await Promise.all([
      getInventoryStock(),
      getInventoryReservations(),
      getInventoryStats(),
    ]);

    if (stockResult.success) setStock(stockResult.data);
    if (reservationResult.success) setReservations(reservationResult.data);
    if (statsResult.success) setStats(statsResult.data);

    if (!stockResult.success) setError(stockResult.error ?? 'Failed to load stock');
    if (!reservationResult.success) setError(reservationResult.error ?? 'Failed to load reservations');

    setIsLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const LOW_STOCK_THRESHOLD = 10;

  const filteredStock = stock.filter(row => {
    if (stockFilter === 'reserved' && row.reservedStock === 0) return false;
    if (stockFilter === 'low' && row.availableStock >= LOW_STOCK_THRESHOLD) return false;
    if (searchQuery && !row.blankSku.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const filteredReservations = reservations.filter(row => {
    if (searchQuery && !row.blankSku.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !row.cartId.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !row.reservationId.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const formatDate = (iso: string) => new Date(iso).toLocaleString();

  const getStatusClasses = (status: string) => {
    switch (status) {
      case 'TEMPORARY':
        return 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300';
      case 'CONFIRMED':
        return 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300';
      case 'RELEASED':
        return 'bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400';
      case 'CANCELLED':
        return 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300';
      default:
        return 'bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400';
    }
  };

  const getStockBarColor = (available: number, total: number) => {
    if (total === 0) return 'bg-zinc-300 dark:bg-zinc-600';
    const pct = available / total;
    if (pct < 0.1) return 'bg-red-500';
    if (pct < 0.3) return 'bg-amber-500';
    return 'bg-emerald-500';
  };

  return (
    <div className="max-w-7xl mx-auto p-8">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Inventory
          </h1>
          <button
            onClick={fetchData}
            disabled={isLoading}
            className="px-3 py-1 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            {isLoading ? '↻' : '⟳'} Refresh
          </button>
        </div>
        <a
          href="http://localhost:8233/namespaces/default/workflows?query=WorkflowType%3D%22inventoryServiceWorkflow%22"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-cyan-600 dark:text-cyan-400 hover:underline"
        >
          View in Temporal UI →
        </a>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          <StatCard label="SKUs" value={stats.totalSkus.toLocaleString()} />
          <StatCard label="Total Stock" value={stats.totalStock.toLocaleString()} />
          <StatCard label="Reserved" value={stats.totalReserved.toLocaleString()} accent={stats.totalReserved > 0 ? 'amber' : undefined} />
          <StatCard label="Available" value={stats.totalAvailable.toLocaleString()} accent="emerald" />
          <StatCard label="Active Reservations" value={stats.activeReservations.toLocaleString()} accent={stats.activeReservations > 0 ? 'blue' : undefined} />
          <StatCard label="Low Stock" value={stats.lowStockSkus.toLocaleString()} accent={stats.lowStockSkus > 0 ? 'red' : undefined} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 bg-zinc-100 dark:bg-zinc-800 p-1 rounded-lg w-fit">
        <TabButton active={tab === 'stock'} onClick={() => setTab('stock')}>
          Stock ({filteredStock.length})
        </TabButton>
        <TabButton active={tab === 'reservations'} onClick={() => setTab('reservations')}>
          Reservations ({filteredReservations.length})
        </TabButton>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <input
          type="text"
          placeholder={tab === 'stock' ? 'Filter by SKU...' : 'Filter by SKU, cart, or reservation ID...'}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="flex-1 max-w-sm px-3 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {tab === 'stock' && (
          <div className="flex gap-1">
            <FilterPill active={stockFilter === 'all'} onClick={() => setStockFilter('all')}>All</FilterPill>
            <FilterPill active={stockFilter === 'reserved'} onClick={() => setStockFilter('reserved')}>Reserved</FilterPill>
            <FilterPill active={stockFilter === 'low'} onClick={() => setStockFilter('low')}>Low Stock</FilterPill>
          </div>
        )}
      </div>

      {error && (
        <div className="p-4 bg-red-100 dark:bg-red-900/30 rounded-lg mb-6 text-red-800 dark:text-red-300">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-16 text-zinc-500">Loading inventory data...</div>
      ) : tab === 'stock' ? (
        /* ─── Stock Table ─── */
        filteredStock.length === 0 ? (
          <div className="text-center py-16 bg-white dark:bg-zinc-800 rounded-lg text-zinc-500">
            {stock.length === 0 ? 'No inventory stock data. Run seed-inventory first.' : 'No SKUs match the current filter.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse bg-white dark:bg-zinc-800 rounded-lg overflow-hidden shadow">
              <thead>
                <tr className="bg-zinc-100 dark:bg-zinc-700 border-b-2 border-zinc-200 dark:border-zinc-600">
                  <th className="px-4 py-3 text-left font-semibold text-zinc-700 dark:text-zinc-300 text-sm">Blank SKU</th>
                  <th className="px-4 py-3 text-left font-semibold text-zinc-700 dark:text-zinc-300 text-sm">Supplier</th>
                  <th className="px-4 py-3 text-right font-semibold text-zinc-700 dark:text-zinc-300 text-sm">Total</th>
                  <th className="px-4 py-3 text-right font-semibold text-zinc-700 dark:text-zinc-300 text-sm">Reserved</th>
                  <th className="px-4 py-3 text-right font-semibold text-zinc-700 dark:text-zinc-300 text-sm">Available</th>
                  <th className="px-4 py-3 text-left font-semibold text-zinc-700 dark:text-zinc-300 text-sm w-32">Utilization</th>
                </tr>
              </thead>
              <tbody>
                {filteredStock.map((row) => {
                  const pct = row.totalStock > 0 ? ((row.totalStock - row.availableStock) / row.totalStock) * 100 : 0;
                  return (
                    <tr
                      key={`${row.blankSku}-${row.supplierId}`}
                      className="border-b border-zinc-100 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <code className="text-sm font-mono text-zinc-800 dark:text-zinc-200">{row.blankSku}</code>
                      </td>
                      <td className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">{row.supplierName}</td>
                      <td className="px-4 py-3 text-right font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">{row.totalStock}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span className={row.reservedStock > 0 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-zinc-400'}>
                          {row.reservedStock}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span className={row.availableStock < LOW_STOCK_THRESHOLD ? 'font-medium text-red-600 dark:text-red-400' : 'text-zinc-900 dark:text-zinc-100'}>
                          {row.availableStock}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-zinc-200 dark:bg-zinc-600 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${getStockBarColor(row.availableStock, row.totalStock)}`}
                              style={{ width: `${Math.max(100 - pct, 0)}%` }}
                            />
                          </div>
                          <span className="text-xs text-zinc-400 tabular-nums w-8 text-right">{Math.round(pct)}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : (
        /* ─── Reservations Table ─── */
        filteredReservations.length === 0 ? (
          <div className="text-center py-16 bg-white dark:bg-zinc-800 rounded-lg text-zinc-500">
            {reservations.length === 0 ? 'No reservations. Add an item to a cart to create one.' : 'No reservations match the current filter.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse bg-white dark:bg-zinc-800 rounded-lg overflow-hidden shadow">
              <thead>
                <tr className="bg-zinc-100 dark:bg-zinc-700 border-b-2 border-zinc-200 dark:border-zinc-600">
                  <th className="px-4 py-3 text-left font-semibold text-zinc-700 dark:text-zinc-300 text-sm">Reservation ID</th>
                  <th className="px-4 py-3 text-left font-semibold text-zinc-700 dark:text-zinc-300 text-sm">Status</th>
                  <th className="px-4 py-3 text-left font-semibold text-zinc-700 dark:text-zinc-300 text-sm">Blank SKU</th>
                  <th className="px-4 py-3 text-left font-semibold text-zinc-700 dark:text-zinc-300 text-sm">Cart ID</th>
                  <th className="px-4 py-3 text-right font-semibold text-zinc-700 dark:text-zinc-300 text-sm">Qty</th>
                  <th className="px-4 py-3 text-left font-semibold text-zinc-700 dark:text-zinc-300 text-sm">Created</th>
                  <th className="px-4 py-3 text-left font-semibold text-zinc-700 dark:text-zinc-300 text-sm">Expires</th>
                </tr>
              </thead>
              <tbody>
                {filteredReservations.map((row) => (
                  <tr
                    key={row.reservationId}
                    className="border-b border-zinc-100 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <code className="text-xs font-mono text-zinc-600 dark:text-zinc-400 break-all">{row.reservationId}</code>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusClasses(row.status)}`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-sm font-mono text-zinc-800 dark:text-zinc-200">{row.blankSku}</code>
                    </td>
                    <td className="px-4 py-3">
                      <a
                        href={`/admin/carts#cart-${row.cartId}`}
                        className="text-xs font-mono text-cyan-600 dark:text-cyan-400 hover:underline"
                      >
                        {row.cartId.substring(0, 8)}…
                      </a>
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">{row.quantity}</td>
                    <td className="px-4 py-3 text-zinc-500 text-xs">{formatDate(row.createdAt)}</td>
                    <td className="px-4 py-3 text-xs">
                      {row.expiresAt ? (
                        <span className={new Date(row.expiresAt) < new Date() ? 'text-red-500 font-medium' : 'text-zinc-500'}>
                          {formatDate(row.expiresAt)}
                        </span>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

// ─── Sub-components ───

function StatCard({ label, value, accent }: { label: string; value: string; accent?: 'amber' | 'emerald' | 'red' | 'blue' }) {
  const accentClasses: Record<string, string> = {
    amber: 'text-amber-600 dark:text-amber-400',
    emerald: 'text-emerald-600 dark:text-emerald-400',
    red: 'text-red-600 dark:text-red-400',
    blue: 'text-blue-600 dark:text-blue-400',
  };

  return (
    <div className="p-4 bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700">
      <div className="text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${accent ? accentClasses[accent] : 'text-zinc-900 dark:text-zinc-100'}`}>
        {value}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
        active
          ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm'
          : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300'
      }`}
    >
      {children}
    </button>
  );
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
        active
          ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
          : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-300 dark:hover:bg-zinc-600'
      }`}
    >
      {children}
    </button>
  );
}
