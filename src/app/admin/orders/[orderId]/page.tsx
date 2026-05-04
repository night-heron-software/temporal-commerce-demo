'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { getOrderState, updateOrderStatus, cancelOrder } from '../../admin-order-actions';
import type { OrderState } from '@/temporal/oms/types';

export default function AdminOrderDetailPage() {
  const params = useParams();
  const orderId = params.orderId as string;

  const [orderState, setOrderState] = useState<OrderState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

  const loadOrder = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await getOrderState(orderId);
    if (result.success) {
      setOrderState(result.data);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, [orderId]);

  useEffect(() => {
    loadOrder();
  }, [loadOrder]);

  async function handleStatusUpdate(status: string, note?: string) {
    setIsUpdating(true);
    setMessage(null);
    setError(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateOrderStatus(orderId, status as any, note);
    if (result.success) {
      setOrderState(result.data);
      setMessage(`Status updated to "${status.replace(/_/g, ' ')}"`);
    } else {
      setError(result.error);
    }
    setIsUpdating(false);
  }

  async function handleCancel() {
    setIsUpdating(true);
    setMessage(null);
    setError(null);
    const result = await cancelOrder(orderId, 'Cancelled by admin');
    if (result.success) {
      setOrderState(result.data);
      setMessage('Order cancelled');
    } else {
      setError(result.error);
    }
    setIsUpdating(false);
  }

  const formatPrice = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const formatDate = (iso: string) => new Date(iso).toLocaleString();

  const getStatusClasses = (status: string) => {
    switch (status) {
      case 'delivered':
      case 'complete':
        return 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300';
      case 'shipped':
        return 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300';
      case 'processing':
      case 'awaiting_tracking':
        return 'bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300';
      case 'ready_to_fulfill':
        return 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-300';
      case 'cancelled':
        return 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300';
      default:
        return 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300';
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-zinc-500">Loading order...</div>;
  }

  if (error && !orderState) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <Link href="/admin/orders" className="text-blue-600 dark:text-blue-400 hover:underline mb-4 block">
          ← Back to Orders
        </Link>
        <div className="p-8 bg-red-100 dark:bg-red-900/30 rounded-lg text-red-800 dark:text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (!orderState) return null;

  const { order, status, statusHistory, supplierOrders = [], assignments = [] } = orderState;

  // Determine which fulfillment step buttons to show
  const isTerminal = ['cancelled', 'refunded', 'complete', 'delivered'].includes(status);
  const canProgress = !isTerminal && !isUpdating;

  return (
    <div className="max-w-5xl mx-auto p-8">
      <Link href="/admin/orders" className="text-blue-600 dark:text-blue-400 hover:underline mb-4 block text-sm">
        ← Back to Orders
      </Link>

      {/* Header */}
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Order #{order.confirmationNumber}
          </h1>
          <p className="text-zinc-500 text-sm mt-1 font-mono">{order.orderId}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`px-4 py-2 rounded-full font-semibold text-sm ${getStatusClasses(status)}`}>
            {status.replace(/_/g, ' ').toUpperCase()}
          </span>
          <button
            onClick={loadOrder}
            className="px-3 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            ⟳
          </button>
        </div>
      </div>

      {/* Messages */}
      {message && (
        <div className="p-4 bg-green-100 dark:bg-green-900/30 rounded-lg mb-4 text-green-800 dark:text-green-300 flex justify-between items-center">
          {message}
          <button onClick={() => setMessage(null)} className="text-green-600 hover:text-green-800 text-lg">×</button>
        </div>
      )}
      {error && (
        <div className="p-4 bg-red-100 dark:bg-red-900/30 rounded-lg mb-4 text-red-800 dark:text-red-300 flex justify-between items-center">
          {error}
          <button onClick={() => setError(null)} className="text-red-600 hover:text-red-800 text-lg">×</button>
        </div>
      )}

      {/* Temporal UI Link */}
      <div className="p-3 bg-cyan-50 dark:bg-cyan-950/30 border border-cyan-200 dark:border-cyan-800 rounded-lg mb-6 text-sm">
        <a
          href={`http://localhost:8233/namespaces/default/workflows/${encodeURIComponent(`${order.storeId}-order-${order.orderId}`)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan-700 dark:text-cyan-400 hover:underline"
        >
          🔗 View this order workflow in Temporal UI →
        </a>
      </div>

      <div className="grid md:grid-cols-2 gap-6 mb-8">
        {/* Order Details */}
        <div className="p-6 bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700">
          <h2 className="text-lg font-semibold mb-4 text-zinc-900 dark:text-zinc-100">Order Details</h2>
          <div className="space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
            <p><strong>Created:</strong> {formatDate(order.createdAt)}</p>
            <p><strong>Customer:</strong> {order.shippingAddress?.email || order.customerEmail || 'Guest'}</p>
            <p><strong>Subtotal:</strong> {formatPrice(order.subtotal)}</p>
            <p><strong>Shipping:</strong> {formatPrice(order.shippingCost)}</p>
            <p><strong>Tax:</strong> {formatPrice(order.tax)}</p>
            <hr className="border-zinc-200 dark:border-zinc-700 my-2" />
            <p className="text-base font-semibold"><strong>Total:</strong> {formatPrice(order.total)}</p>
          </div>
        </div>

        {/* Shipping Address */}
        <div className="p-6 bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700">
          <h2 className="text-lg font-semibold mb-4 text-zinc-900 dark:text-zinc-100">Shipping Address</h2>
          {order.shippingAddress ? (
            <div className="space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
              <p>{order.shippingAddress.firstName} {order.shippingAddress.lastName}</p>
              <p>{order.shippingAddress.address1}</p>
              {order.shippingAddress.address2 && <p>{order.shippingAddress.address2}</p>}
              <p>{order.shippingAddress.city}, {order.shippingAddress.state} {order.shippingAddress.postalCode}</p>
              <p>{order.shippingAddress.country}</p>
            </div>
          ) : (
            <p className="text-zinc-500 text-sm">No shipping address</p>
          )}
        </div>
      </div>

      {/* Line Items */}
      <div className="p-6 bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 mb-8">
        <h2 className="text-lg font-semibold mb-4 text-zinc-900 dark:text-zinc-100">
          Line Items ({order.items.length})
        </h2>
        <div className="space-y-3">
          {order.items.map((item) => {
            const itemAssignments = assignments.filter((a) => a.lineItemId === item.lineItemId);
            return (
              <div key={item.lineItemId} className="p-3 bg-zinc-50 dark:bg-zinc-750 rounded-lg border border-zinc-100 dark:border-zinc-700">
                <div className="flex justify-between items-center">
                  <div>
                    <span className="font-mono text-sm text-zinc-600 dark:text-zinc-400">
                      {item.variantId.substring(0, 12)}...
                    </span>
                    <span className="ml-2 text-zinc-500">× {item.quantity}</span>
                  </div>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {formatPrice(item.price * item.quantity)}
                  </span>
                </div>
                {itemAssignments.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {itemAssignments.map((asg) => (
                      <div key={asg.assignmentId} className="flex items-center gap-2 text-xs">
                        <span className="text-zinc-500">→ {asg.supplierName}</span>
                        <span className={`px-2 py-0.5 rounded ${getStatusClasses(asg.status)}`}>
                          {asg.status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Supplier Orders */}
      {supplierOrders.length > 0 && (
        <div className="p-6 bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 mb-8">
          <h2 className="text-lg font-semibold mb-4 text-zinc-900 dark:text-zinc-100">
            Supplier Orders
          </h2>
          <div className="space-y-3">
            {supplierOrders.map((so) => (
              <div key={so.supplierOrderId} className="p-4 bg-zinc-50 dark:bg-zinc-750 rounded-lg border border-zinc-100 dark:border-zinc-700">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <span className="font-semibold text-zinc-900 dark:text-zinc-100">{so.supplierName}</span>
                    <span className="ml-2 text-xs text-zinc-500 font-mono">{so.supplierOrderId}</span>
                  </div>
                  <span className={`px-3 py-1 rounded-full text-xs font-medium ${getStatusClasses(so.status)}`}>
                    {so.status.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="text-sm text-zinc-500">
                  {so.items.length} item(s) • {so.items.reduce((sum, i) => sum + i.quantity, 0)} units
                </div>
                {so.carrier && (
                  <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                    <strong>Carrier:</strong> {so.carrier}
                    {so.trackingNumber && <span> • Tracking: {so.trackingNumber}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ========== MANUAL FULFILLMENT CONTROLS ========== */}
      <div className="p-6 bg-gradient-to-r from-purple-50 to-blue-50 dark:from-purple-950/20 dark:to-blue-950/20 rounded-lg border-2 border-purple-200 dark:border-purple-800 mb-8">
        <h2 className="text-lg font-semibold mb-2 text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          🎛️ Manual Fulfillment Controls
        </h2>
        <p className="text-sm text-zinc-500 mb-4">
          Step through the order lifecycle manually. Each button sends a Temporal Update to the order workflow.
        </p>

        {isTerminal ? (
          <p className="text-sm text-zinc-500 italic">
            This order is in a terminal state ({status}). No further actions available.
          </p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {status === 'pending_assignment' && (
              <button
                onClick={() => handleStatusUpdate('ready_to_fulfill', 'Marked ready by admin')}
                disabled={!canProgress}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                → Ready to Fulfill
              </button>
            )}

            {status === 'ready_to_fulfill' && (
              <button
                onClick={() => handleStatusUpdate('processing', 'Processing started by admin')}
                disabled={!canProgress}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                → Processing
              </button>
            )}

            {status === 'processing' && (
              <button
                onClick={() => handleStatusUpdate('shipped', 'Shipped by admin')}
                disabled={!canProgress}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                → Shipped
              </button>
            )}

            {status === 'shipped' && (
              <button
                onClick={() => handleStatusUpdate('delivered', 'Delivered confirmed by admin')}
                disabled={!canProgress}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                → Delivered
              </button>
            )}

            {!isTerminal && (
              <button
                onClick={handleCancel}
                disabled={!canProgress}
                className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                ✕ Cancel Order
              </button>
            )}
          </div>
        )}

        {/* Visual Pipeline */}
        <div className="mt-6 flex items-center gap-1 text-xs overflow-x-auto">
          {['pending_assignment', 'ready_to_fulfill', 'processing', 'shipped', 'delivered'].map(
            (step, idx) => {
              const isActive = status === step;
              const isPast =
                ['pending_assignment', 'ready_to_fulfill', 'processing', 'shipped', 'delivered'].indexOf(status) > idx;
              return (
                <div key={step} className="flex items-center gap-1">
                  {idx > 0 && (
                    <div className={`w-8 h-0.5 ${isPast ? 'bg-green-400' : 'bg-zinc-300 dark:bg-zinc-600'}`} />
                  )}
                  <div
                    className={`px-2 py-1 rounded-md whitespace-nowrap font-medium ${
                      isActive
                        ? 'bg-purple-600 text-white'
                        : isPast
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                          : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-500'
                    }`}
                  >
                    {step.replace(/_/g, ' ')}
                  </div>
                </div>
              );
            }
          )}
        </div>
      </div>

      {/* Status History */}
      <div className="p-6 bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700">
        <h2 className="text-lg font-semibold mb-4 text-zinc-900 dark:text-zinc-100">Status History</h2>
        {statusHistory && statusHistory.length > 0 ? (
          <div className="space-y-2">
            {statusHistory.map((entry, idx) => (
              <div key={idx} className="flex items-center gap-4 p-3 bg-zinc-50 dark:bg-zinc-750 rounded">
                <span className="w-36 font-medium capitalize text-sm text-zinc-700 dark:text-zinc-300">
                  {entry.status.replace(/_/g, ' ')}
                </span>
                <span className="text-zinc-500 text-sm">{formatDate(entry.timestamp)}</span>
                <span className="text-xs px-2 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400">
                  {entry.updatedBy}
                </span>
                {entry.note && (
                  <span className="text-zinc-500 text-sm italic">{entry.note}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-zinc-500 text-sm">No history entries</p>
        )}
      </div>
    </div>
  );
}
