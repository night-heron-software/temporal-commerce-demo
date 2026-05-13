'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { getOrdersByEmail, type CustomerOrder } from '../order-actions';
import { useShopper } from '@/context/ShopperContext';

export default function ShopOrdersPage() {
  const { shopper } = useShopper();
  const [email, setEmail] = useState('');
  const [loggedInEmail, setLoggedInEmail] = useState<string | null>(null);
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If signed in via ShopperContext, use that email automatically
  useEffect(() => {
    if (shopper?.email && !loggedInEmail) {
      setLoggedInEmail(shopper.email);
      setEmail(shopper.email);
    }
  }, [shopper, loggedInEmail]);

  // Fallback: check for saved email in sessionStorage
  useEffect(() => {
    if (loggedInEmail) return; // already set from ShopperContext
    const saved = sessionStorage.getItem('shopperEmail');
    if (saved) {
      setLoggedInEmail(saved);
      setEmail(saved);
    }
  }, [loggedInEmail]);

  const fetchOrders = useCallback(async (customerEmail: string) => {
    setIsLoading(true);
    setError(null);
    const result = await getOrdersByEmail(customerEmail);
    if (result.success) {
      setOrders(result.data);
    } else {
      setError(result.error ?? 'Failed to load orders');
    }
    setIsLoading(false);
  }, []);

  // Fetch orders when logged in
  useEffect(() => {
    if (loggedInEmail) {
      fetchOrders(loggedInEmail);
    }
  }, [loggedInEmail, fetchOrders]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    sessionStorage.setItem('shopperEmail', trimmed);
    setLoggedInEmail(trimmed);
  };

  const handleLogout = () => {
    sessionStorage.removeItem('shopperEmail');
    setLoggedInEmail(null);
    setOrders([]);
    setEmail('');
  };

  const formatPrice = (amount: number, currency: string) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);

  const formatDate = (iso: string) => {
    const date = new Date(iso);
    return {
      date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      time: date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    };
  };

  const getStatusConfig = (status: string) => {
    switch (status) {
      case 'delivered':
      case 'complete':
        return { classes: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300', icon: '✓', label: 'Delivered' };
      case 'shipped':
        return { classes: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300', icon: '🚚', label: 'Shipped' };
      case 'processing':
      case 'ready_to_fulfill':
        return { classes: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300', icon: '⏳', label: 'Processing' };
      case 'paid':
        return { classes: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300', icon: '💳', label: 'Paid' };
      case 'cancelled':
        return { classes: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300', icon: '✕', label: 'Cancelled' };
      default:
        return { classes: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300', icon: '•', label: status.replace(/_/g, ' ') };
    }
  };

  // ─── Login Screen ───
  if (!loggedInEmail) {
    return (
      <div className="min-h-screen bg-[var(--heron-cream-light)] dark:bg-[var(--heron-forest-dark)] flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="bg-white dark:bg-zinc-800 rounded-2xl border border-zinc-200 dark:border-zinc-700 shadow-xl p-8">
            <div className="text-center mb-6">
              <div className="text-4xl mb-3">📦</div>
              <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                View Your Orders
              </h1>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
                Enter the email you used at checkout.
              </p>
            </div>

            <form onSubmit={handleLogin}>
              <label htmlFor="email" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                autoFocus
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
              />
              <button
                type="submit"
                className="w-full mt-4 px-4 py-3 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 transition-colors"
              >
                View Orders
              </button>
            </form>

            <div className="mt-6 text-center">
              <Link
                href="/shop"
                className="text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                ← Back to shop
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Orders Screen ───
  return (
    <div className="min-h-screen bg-[var(--heron-cream-light)] dark:bg-[var(--heron-forest-dark)]">
      <div className="max-w-3xl mx-auto px-4 py-10">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              Your Orders
            </h1>
            <p className="text-zinc-500 dark:text-zinc-400 mt-1 text-sm">
              Showing orders for <span className="font-medium text-zinc-700 dark:text-zinc-300">{loggedInEmail}</span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => fetchOrders(loggedInEmail)}
              disabled={isLoading}
              className="px-3 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
            >
              {isLoading ? '↻' : '⟳'} Refresh
            </button>
            <button
              onClick={handleLogout}
              className="px-3 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:border-red-300 dark:hover:border-red-600 transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>

        {error && (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl mb-6 text-red-700 dark:text-red-300 text-sm">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="animate-pulse bg-white dark:bg-zinc-800 rounded-xl p-6 border border-zinc-200 dark:border-zinc-700">
                <div className="h-4 bg-zinc-200 dark:bg-zinc-700 rounded w-1/3 mb-3" />
                <div className="h-3 bg-zinc-200 dark:bg-zinc-700 rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : orders.length === 0 ? (
          <div className="text-center py-20 bg-white dark:bg-zinc-800/50 rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700">
            <div className="text-5xl mb-4">📭</div>
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
              No orders found
            </h2>
            <p className="text-zinc-500 dark:text-zinc-400 mb-6">
              No orders have been placed with <span className="font-medium">{loggedInEmail}</span> yet.
            </p>
            <Link
              href="/shop"
              className="inline-flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-colors"
            >
              ← Start Shopping
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {orders.map((order) => {
              const statusConfig = getStatusConfig(order.status);
              const { date, time } = formatDate(order.createdAt);

              return (
                <div
                  key={order.orderId}
                  className="bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600 transition-all hover:shadow-md overflow-hidden"
                >
                  <div className="p-5">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs text-zinc-400 dark:text-zinc-500 uppercase tracking-wider font-medium">
                            Order
                          </span>
                          <span className="font-mono font-semibold text-zinc-900 dark:text-zinc-100">
                            {order.confirmationNumber || order.orderId.substring(0, 8)}
                          </span>
                        </div>
                        <div className="text-xs text-zinc-400 dark:text-zinc-500">
                          {date} at {time}
                        </div>
                      </div>
                      <span className={`px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5 ${statusConfig.classes}`}>
                        <span>{statusConfig.icon}</span>
                        <span className="capitalize">{statusConfig.label}</span>
                      </span>
                    </div>

                    {/* Shipping Address */}
                    {order.shippingAddress && (
                      <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-700">
                        <div className="text-xs font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-1">
                          Ship to
                        </div>
                        <div className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
                          <span className="font-medium text-zinc-800 dark:text-zinc-200">
                            {order.shippingAddress.firstName} {order.shippingAddress.lastName}
                          </span>
                          <br />
                          {order.shippingAddress.address1}
                          {order.shippingAddress.address2 && (
                            <>, {order.shippingAddress.address2}</>
                          )}
                          <br />
                          {order.shippingAddress.city}, {order.shippingAddress.state} {order.shippingAddress.postalCode}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-3 border-t border-zinc-100 dark:border-zinc-700 mt-3">
                      <span className="text-sm text-zinc-500 dark:text-zinc-400">
                        {loggedInEmail}
                      </span>
                      <span className="text-lg font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">
                        {formatPrice(order.total, order.currency)}
                      </span>
                    </div>
                  </div>

                  <OrderProgressBar status={order.status} />
                </div>
              );
            })}

            <div className="text-center pt-4">
              <Link
                href="/shop"
                className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                ← Back to shop
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Progress Bar ───

const ORDER_STEPS = ['paid', 'processing', 'shipped', 'delivered'] as const;

function OrderProgressBar({ status }: { status: string }) {
  if (status === 'cancelled') {
    return <div className="h-1 bg-red-500" />;
  }

  const currentIndex = ORDER_STEPS.indexOf(status as typeof ORDER_STEPS[number]);
  const progress = currentIndex >= 0 ? ((currentIndex + 1) / ORDER_STEPS.length) * 100 : 10;

  return (
    <div className="h-1 bg-zinc-100 dark:bg-zinc-700">
      <div
        className="h-full bg-gradient-to-r from-indigo-500 to-emerald-500 transition-all duration-700"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}
