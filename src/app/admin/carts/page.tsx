'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  getActiveCarts,
  getCartDetails,
  type CartSummary,
} from '../admin-cart-actions';
import type { CartDetails } from '@/app/shop/cart-actions';

export default function AdminCartsPage() {
  const [carts, setCarts] = useState<CartSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedCart, setExpandedCart] = useState<string | null>(null);
  const [cartDetails, setCartDetails] = useState<Record<string, CartDetails>>({});
  const [loadingDetails, setLoadingDetails] = useState<string | null>(null);

  const fetchCarts = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const result = await getActiveCarts();
    if (result.success) {
      setCarts(result.data);
    } else {
      setError(result.error);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    fetchCarts();
  }, [fetchCarts]);

  const toggleCartDetails = async (cartId: string) => {
    if (expandedCart === cartId) {
      setExpandedCart(null);
      return;
    }
    setExpandedCart(cartId);

    if (!cartDetails[cartId]) {
      setLoadingDetails(cartId);
      const result = await getCartDetails(cartId);
      if (result.success) {
        setCartDetails(prev => ({ ...prev, [cartId]: result.data as CartDetails }));
      }
      setLoadingDetails(null);
    }
  };

  const formatPrice = (amount: number, currency: string) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);

  const formatDate = (iso: string) => new Date(iso).toLocaleString();

  const getStatusClasses = (status: string) => {
    switch (status) {
      case 'active':
        return 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300';
      case 'checkout':
      case 'processing':
        return 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300';
      case 'completed':
        return 'bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300';
      case 'abandoned':
        return 'bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400';
      default:
        return 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300';
    }
  };

  const getCheckoutStepClasses = (step: string) => {
    switch (step) {
      case 'complete':
        return 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300';
      case 'failed':
      case 'cancelled':
        return 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300';
      default:
        return 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-800 dark:text-cyan-300';
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-8">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Active Carts
          </h1>
          <button
            onClick={fetchCarts}
            disabled={isLoading}
            className="px-3 py-1 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            {isLoading ? '↻' : '⟳'} Refresh
          </button>
        </div>
        <a
          href="http://localhost:8233/namespaces/default/workflows?query=WorkflowType%3D%22cartWorkflow%22"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-cyan-600 dark:text-cyan-400 hover:underline"
        >
          View in Temporal UI →
        </a>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="p-4 bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700">
          <div className="text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-1">Active Carts</div>
          <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">
            {carts.filter(c => c.status === 'active').length}
          </div>
        </div>
        <div className="p-4 bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700">
          <div className="text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-1">In Checkout</div>
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400 tabular-nums">
            {carts.filter(c => c.status === 'checkout' || c.status === 'processing').length}
          </div>
        </div>
        <div className="p-4 bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700">
          <div className="text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-1">Total Items</div>
          <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">
            {carts.reduce((sum, c) => sum + c.itemCount, 0)}
          </div>
        </div>
        <div className="p-4 bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700">
          <div className="text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-1">Total Value</div>
          <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
            {formatPrice(carts.reduce((sum, c) => sum + c.totalPrice, 0), 'USD')}
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-100 dark:bg-red-900/30 rounded-lg mb-6 text-red-800 dark:text-red-300">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-16 text-zinc-500">Loading active carts...</div>
      ) : carts.length === 0 ? (
        <div className="text-center py-16 bg-white dark:bg-zinc-800 rounded-lg text-zinc-500">
          <p className="text-lg mb-2">No active carts</p>
          <p className="text-sm">
            Add an item from the storefront to create a cart workflow.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {carts.map((cart) => (
            <div
              key={cart.cartId}
              className="bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden shadow-sm"
            >
              {/* Cart Row */}
              <button
                onClick={() => toggleCartDetails(cart.cartId)}
                className="w-full px-5 py-4 flex items-center gap-4 hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-colors text-left"
              >
                {/* Expand indicator */}
                <span className="text-zinc-400 text-sm w-4 flex-shrink-0">
                  {expandedCart === cart.cartId ? '▼' : '▶'}
                </span>

                {/* Cart ID */}
                <div className="min-w-0 flex-1">
                  <code className="text-sm font-mono text-zinc-800 dark:text-zinc-200">
                    {cart.cartId.substring(0, 8)}…
                  </code>
                  {cart.userId && (
                    <span className="ml-2 text-xs text-zinc-400">
                      👤 {cart.userId}
                    </span>
                  )}
                </div>

                {/* Status */}
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusClasses(cart.status)}`}>
                  {cart.status}
                </span>

                {/* Checkout step */}
                {cart.checkout && (
                  <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${getCheckoutStepClasses(cart.checkout.step)}`}>
                    {cart.checkout.step}
                  </span>
                )}

                {/* Items */}
                <div className="text-sm text-zinc-500 dark:text-zinc-400 w-16 text-right tabular-nums">
                  {cart.itemCount} {cart.itemCount === 1 ? 'item' : 'items'}
                </div>

                {/* Total */}
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 w-20 text-right tabular-nums">
                  {formatPrice(cart.totalPrice, cart.currency)}
                </div>

                {/* Updated */}
                <div className="text-xs text-zinc-400 w-40 text-right hidden md:block">
                  {formatDate(cart.updatedAt)}
                </div>

                {/* Temporal link */}
                <a
                  href={`http://localhost:8233/namespaces/default/workflows/${cart.workflowId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-cyan-600 dark:text-cyan-400 hover:underline flex-shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  ⚡
                </a>
              </button>

              {/* Expanded Details */}
              {expandedCart === cart.cartId && (
                <div className="border-t border-zinc-200 dark:border-zinc-700 px-5 py-4 bg-zinc-50 dark:bg-zinc-850">
                  {loadingDetails === cart.cartId ? (
                    <div className="text-sm text-zinc-400 py-2">Loading cart details...</div>
                  ) : cartDetails[cart.cartId] ? (
                    <div className="space-y-4">
                      {/* Items table */}
                      <div>
                        <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-2">
                          Items
                        </h3>
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-zinc-500 dark:text-zinc-400">
                              <th className="text-left font-medium pb-1">Variant ID</th>
                              <th className="text-right font-medium pb-1">Qty</th>
                              <th className="text-right font-medium pb-1">Price</th>
                              <th className="text-right font-medium pb-1">Subtotal</th>
                            </tr>
                          </thead>
                          <tbody>
                            {cartDetails[cart.cartId].items.map((item) => (
                              <tr key={item.lineItemId} className="border-t border-zinc-200 dark:border-zinc-700">
                                <td className="py-2">
                                  <code className="text-xs font-mono text-zinc-600 dark:text-zinc-400">
                                    {item.variantId.substring(0, 8)}…
                                  </code>
                                </td>
                                <td className="py-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">{item.quantity}</td>
                                <td className="py-2 text-right tabular-nums text-zinc-500">{formatPrice(item.price, cart.currency)}</td>
                                <td className="py-2 text-right tabular-nums font-medium text-zinc-900 dark:text-zinc-100">
                                  {formatPrice(item.price * item.quantity, cart.currency)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Cart summary */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                        <div>
                          <span className="text-zinc-400">Subtotal</span>
                          <div className="font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">
                            {formatPrice(cartDetails[cart.cartId].subtotalPrice, cart.currency)}
                          </div>
                        </div>
                        <div>
                          <span className="text-zinc-400">Tax</span>
                          <div className="font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">
                            {formatPrice(cartDetails[cart.cartId].totalTax, cart.currency)}
                          </div>
                        </div>
                        <div>
                          <span className="text-zinc-400">Shipping</span>
                          <div className="font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">
                            {formatPrice(cartDetails[cart.cartId].shippingCost, cart.currency)}
                          </div>
                        </div>
                        <div>
                          <span className="text-zinc-400">Version</span>
                          <div className="font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">
                            {cartDetails[cart.cartId].cartVersion}
                          </div>
                        </div>
                      </div>

                      {/* Coupons */}
                      {cartDetails[cart.cartId].appliedCoupons.length > 0 && (
                        <div className="text-sm">
                          <span className="text-zinc-400">Coupons:</span>{' '}
                          {cartDetails[cart.cartId].appliedCoupons.map(c => (
                            <span key={c} className="ml-1 px-2 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded text-xs font-mono">
                              {c}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Workflow link */}
                      <div className="pt-2 border-t border-zinc-200 dark:border-zinc-700 flex items-center gap-4 text-sm">
                        <a
                          href={`http://localhost:8233/namespaces/default/workflows/${cart.workflowId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-cyan-600 dark:text-cyan-400 hover:underline flex items-center gap-1"
                        >
                          ⚡ View Cart Workflow in Temporal UI →
                        </a>
                        {cart.checkout?.workflowId && (
                          <a
                            href={`http://localhost:8233/namespaces/default/workflows/${cart.checkout.workflowId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-cyan-600 dark:text-cyan-400 hover:underline flex items-center gap-1"
                          >
                            ⚡ Checkout Workflow →
                          </a>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-zinc-400 py-2">Unable to load details</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
