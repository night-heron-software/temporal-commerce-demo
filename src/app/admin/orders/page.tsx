'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { getAllOrders, type OrderSummary } from '../admin-order-actions';

export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualFulfillment, setManualFulfillment] = useState(false);
  const [isTogglingFlag, setIsTogglingFlag] = useState(false);

  const fetchOrders = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const result = await getAllOrders();
    if (result.success) {
      setOrders(result.data);
    } else {
      setError(result.error);
    }
    setIsLoading(false);
  }, []);

  // Load feature flags on mount
  useEffect(() => {
    fetch('/api/admin/feature-flags')
      .then(r => r.json())
      .then(flags => {
        setManualFulfillment(flags.MANUAL_FULFILLMENT ?? false);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const toggleFulfillmentMode = async () => {
    setIsTogglingFlag(true);
    const newValue = !manualFulfillment;
    try {
      const res = await fetch('/api/admin/feature-flags', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'MANUAL_FULFILLMENT', value: newValue }),
      });
      const data = await res.json();
      if (data.success) {
        setManualFulfillment(data.flags.MANUAL_FULFILLMENT);
      }
    } catch {
      // revert on error
    }
    setIsTogglingFlag(false);
  };

  const formatPrice = (amount: number, currency: string) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);

  const formatDate = (iso: string) => new Date(iso).toLocaleString();

  const getStatusClasses = (status: string) => {
    switch (status) {
      case 'delivered':
      case 'complete':
        return 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300';
      case 'shipped':
        return 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300';
      case 'processing':
      case 'ready_to_fulfill':
        return 'bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300';
      case 'cancelled':
        return 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300';
      default:
        return 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300';
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-8">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Orders
          </h1>
          <button
            onClick={fetchOrders}
            disabled={isLoading}
            className="px-3 py-1 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            {isLoading ? '↻' : '⟳'} Refresh
          </button>
        </div>
        <a
          href="http://localhost:8233/namespaces/default/workflows?query=WorkflowType%3D%22orderWorkflow%22"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-cyan-600 dark:text-cyan-400 hover:underline"
        >
          View in Temporal UI →
        </a>
      </div>

      {/* Fulfillment Mode Toggle */}
      <div className="mb-6 p-4 bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Fulfillment Mode
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {manualFulfillment
              ? 'Manual — orders wait for admin to advance each step'
              : 'Automatic — orders progress through fulfillment automatically (simulated delays)'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs font-medium ${!manualFulfillment ? 'text-green-600 dark:text-green-400' : 'text-zinc-400'}`}>
            Auto
          </span>
          <button
            onClick={toggleFulfillmentMode}
            disabled={isTogglingFlag}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 disabled:opacity-50 ${
              manualFulfillment
                ? 'bg-purple-600'
                : 'bg-green-500'
            }`}
            role="switch"
            aria-checked={manualFulfillment}
            aria-label="Toggle fulfillment mode"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                manualFulfillment ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
          <span className={`text-xs font-medium ${manualFulfillment ? 'text-purple-600 dark:text-purple-400' : 'text-zinc-400'}`}>
            Manual
          </span>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-100 dark:bg-red-900/30 rounded-lg mb-6 text-red-800 dark:text-red-300">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-16 text-zinc-500">Loading orders...</div>
      ) : orders.length === 0 ? (
        <div className="text-center py-16 bg-white dark:bg-zinc-800 rounded-lg text-zinc-500">
          <p className="text-lg mb-2">No orders yet</p>
          <p className="text-sm">
            Place an order from the{' '}
            <Link href="/shop" className="text-blue-600 dark:text-blue-400 hover:underline">
              storefront
            </Link>{' '}
            to see it here.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse bg-white dark:bg-zinc-800 rounded-lg overflow-hidden shadow">
            <thead>
              <tr className="bg-zinc-100 dark:bg-zinc-700 border-b-2 border-zinc-200 dark:border-zinc-600">
                <th className="px-4 py-3 text-left font-semibold text-zinc-700 dark:text-zinc-300">
                  Confirmation
                </th>
                <th className="px-4 py-3 text-left font-semibold text-zinc-700 dark:text-zinc-300">
                  Customer
                </th>
                <th className="px-4 py-3 text-left font-semibold text-zinc-700 dark:text-zinc-300">
                  Status
                </th>
                <th className="px-4 py-3 text-right font-semibold text-zinc-700 dark:text-zinc-300">
                  Total
                </th>
                <th className="px-4 py-3 text-left font-semibold text-zinc-700 dark:text-zinc-300">
                  Date
                </th>
                <th className="px-4 py-3 text-center font-semibold text-zinc-700 dark:text-zinc-300">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr
                  key={order.orderId}
                  className="border-b border-zinc-100 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-colors"
                >
                  <td className="px-4 py-3">
                    <code className="bg-zinc-100 dark:bg-zinc-700 px-2 py-1 rounded text-sm font-mono">
                      {order.confirmationNumber || order.orderId.substring(0, 8)}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400 text-sm">
                    {order.customerEmail || 'Guest'}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-medium capitalize ${getStatusClasses(order.status)}`}
                    >
                      {order.status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-zinc-900 dark:text-zinc-100">
                    {formatPrice(order.total, order.currency)}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 text-sm">{formatDate(order.createdAt)}</td>
                  <td className="px-4 py-3 text-center">
                    <Link
                      href={`/admin/orders/${order.orderId}`}
                      className="text-blue-600 dark:text-blue-400 hover:underline font-medium text-sm"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
