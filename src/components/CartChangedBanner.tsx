'use client';

import { useCart } from '@/context/CartContext';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { acknowledgeCartChange } from '@/app/shop/cart-actions';

/**
 * Banner shown during checkout when the cart has been modified since checkout started.
 * Compares cart.cartVersion against checkout.cartVersionAcknowledged.
 */
export function CartChangedBanner() {
  const { cart, cartId, refreshCart } = useCart();
  const router = useRouter();
  const [dismissing, setDismissing] = useState(false);

  // Only show if in checkout and cart version has changed
  if (
    !cart ||
    !cartId ||
    cart.status !== 'checkout' ||
    !cart.checkout ||
    cart.checkout.cartVersionAcknowledged === undefined
  ) {
    return null;
  }

  const currentVersion = cart.cartVersion ?? 0;
  const acknowledgedVersion = cart.checkout.cartVersionAcknowledged ?? 0;

  if (currentVersion <= acknowledgedVersion) {
    return null;
  }

  async function handleDismiss() {
    if (!cartId) return;
    setDismissing(true);
    try {
      await acknowledgeCartChange(cartId, currentVersion);
      await refreshCart();
    } catch {
      // Non-blocking
    } finally {
      setDismissing(false);
    }
  }

  function handleReturnToCart() {
    router.push('/shop');
  }

  return (
    <div className="bg-[var(--heron-gold)]/20 border border-[var(--heron-gold)] rounded-xl p-4 mb-6 flex items-start gap-3">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
        className="w-6 h-6 text-[var(--heron-gold-dark)] flex-shrink-0 mt-0.5"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
        />
      </svg>
      <div className="flex-1">
        <p className="text-sm font-semibold text-[var(--heron-slate-dark)] dark:text-[var(--heron-cream)]">
          Your cart has been updated
        </p>
        <p className="text-xs text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)] mt-1">
          Items in your cart have changed since you started checkout. Please review before continuing.
        </p>
        <div className="flex gap-2 mt-3">
          <button
            onClick={handleReturnToCart}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-[var(--heron-slate)] text-white hover:bg-[var(--heron-slate-dark)] transition-colors"
          >
            Review Cart
          </button>
          <button
            onClick={handleDismiss}
            disabled={dismissing}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-transparent border border-[var(--heron-gray)] text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)] hover:bg-[var(--heron-cream-dark)] dark:hover:bg-[var(--heron-slate-dark)] transition-colors disabled:opacity-50"
          >
            {dismissing ? 'Dismissing...' : 'Continue Anyway'}
          </button>
        </div>
      </div>
    </div>
  );
}
