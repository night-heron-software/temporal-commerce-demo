'use client';

import { useCart } from '@/context/CartContext';
import { useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import { submitOrder, cancelCheckout, getCheckoutState } from '@/app/shop/cart-actions';
import Link from 'next/link';
import { CartChangedBanner } from '@/components/CartChangedBanner';
import { cartLineLabel } from '@/app/shop/cart-line-display';
import type { Cart } from '@/temporal/contracts';

export default function ReviewPage() {
  const router = useRouter();
  const { cart, cartId, resolved, refreshCart, clearCart } = useCart();
  const [checkoutState, setCheckoutState] = useState<Cart.CheckoutState | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch full checkout state (includes shipping/payment details) and KEEP WATCHING it
  // (R3 / F5): a mid-checkout cart edit reverts the machine's step to 'payment' via the
  // recompute nudge, and a one-shot fetch would leave this page offering "Place Order"
  // for a step the machine no longer accepts until the shopper reloads. The watcher
  // routes to the machine's actual step the moment it changes; the payment page's
  // CartChangedBanner then explains what happened.
  useEffect(() => {
    if (!cartId || cart?.status !== 'checkout') return;
    let cancelled = false;

    const check = () =>
      getCheckoutState(cartId).then((state) => {
        if (!state || cancelled) return;
        setCheckoutState(state);
        if (state.step === 'shipping') {
          router.replace('/shop/checkout/shipping');
        } else if (state.step === 'payment') {
          router.replace('/shop/checkout/payment');
        }
      });

    check();
    const timer = setInterval(check, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cartId, cart?.status, router]);

  // Redirect a cart that LEFT checkout (back to active) — but only once resolution has
  // finished. Guarding on `cart` alone could never fire for the case that needs it most:
  // CartContext does not adopt a terminal cart, so `cart` is null exactly when the checkout
  // is over, and this page sat on its spinner forever (#12). "No cart" is handled in the
  // render below with an explanation rather than a silent bounce.
  useEffect(() => {
    if (resolved && cart && cart.status !== 'checkout') {
      router.replace('/shop');
    }
  }, [resolved, cart, router]);

  const handlePlaceOrder = async () => {
    // `cart` is required as well as `cartId`: the submit is guarded by the version this page
    // rendered, and there is no version without the cart it came from.
    if (!cartId || !cart) return;
    setIsSubmitting(true);
    setError(null);

    try {
      // Submit against the version THIS PAGE RENDERED (#17). `cart` is the object the summary
      // below is drawn from, so `cart.cartVersion` is by construction what the shopper reviewed.
      // Re-reading it inside the action would compare the live cart to itself and the guard
      // could never fire.
      const finalState = await submitOrder(cartId, cart.cartVersion);

      if (finalState?.step === 'complete' && finalState.order) {
        clearCart();
        router.push(`/shop/checkout/confirmation?order=${finalState.order.confirmationNumber}`);
      } else if (finalState?.error) {
        // CART_CHANGED is a machine code, not a sentence, and until #17 it could never reach a
        // shopper — the UI never armed the guard. Now that it can, give it words. Everything
        // else is already a domain sentence and renders verbatim (926a323).
        setError(
          finalState.error === 'CART_CHANGED'
            ? 'Your cart changed while you were reviewing. We refreshed the totals — please check them and place your order again.'
            : finalState.error,
        );
        setIsSubmitting(false);
        refreshCart();
      } else {
        setError('Order submission failed');
        setIsSubmitting(false);
      }
    } catch {
      setError('Failed to complete order processing');
      setIsSubmitting(false);
    }
  };

  const handleCancelCheckout = async () => {
    if (!cartId) return;
    setIsCancelling(true);

    try {
      await cancelCheckout(cartId);
      await refreshCart();
      router.push('/shop');
    } catch {
      setError('Failed to cancel checkout');
      setIsCancelling(false);
    }
  };

  // "There is no cart" is its OWN state, not a slow load (#12). Reached by pressing Back after
  // an order (the completed path deletes the cart cookie) or by the cart going terminal in
  // another tab. Before this split, both rendered the spinner below — forever, with no
  // redirect, because the redirect above needs a cart to fire.
  if (resolved && !cart) {
    return (
      <div className="min-h-screen bg-[var(--heron-cream-light)] dark:bg-[var(--heron-forest-dark)] text-[var(--heron-slate-dark)] dark:text-[var(--heron-cream)] flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold mb-2">This checkout is finished</h1>
          <p className="text-[var(--heron-slate)] dark:text-[var(--heron-slate-light)] mb-6">
            There is no cart in progress. If you just placed an order, it is on its way.
          </p>
          <div className="flex gap-3 justify-center">
            <Link
              href="/shop/orders"
              className="px-4 py-2 rounded-lg bg-[var(--heron-forest)] text-[var(--heron-cream)] hover:opacity-90"
            >
              View your orders
            </Link>
            <Link
              href="/shop"
              className="px-4 py-2 rounded-lg border border-[var(--heron-slate)] hover:bg-[var(--heron-cream)] dark:hover:bg-[var(--heron-forest)]"
            >
              Continue shopping
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!cart || !checkoutState) {
    return (
      <div className="min-h-screen bg-[var(--heron-cream-light)] dark:bg-[var(--heron-forest-dark)] text-[var(--heron-slate-dark)] dark:text-[var(--heron-cream)] flex items-center justify-center">
        <div className="animate-pulse text-lg">Loading review...</div>
      </div>
    );
  }

  const shipping = checkoutState.shippingAddress;
  const payment = checkoutState.paymentMethod;

  return (
    <div className="min-h-screen bg-[var(--heron-cream-light)] dark:bg-[var(--heron-forest-dark)] text-[var(--heron-slate-dark)] dark:text-[var(--heron-cream)] p-8">
      <div className="max-w-2xl mx-auto">
        <Link
          href="/shop/checkout/payment"
          className="text-[var(--heron-slate)] dark:text-[var(--heron-slate-light)] hover:underline mb-4 inline-block"
        >
          ← Back to Payment
        </Link>
        <h1 className="text-3xl font-bold mb-6">Review Your Order</h1>

        {error && (
          <div className="bg-[var(--heron-ruby)]/20 border border-[var(--heron-ruby)] text-[var(--heron-ruby)] dark:text-[var(--heron-ruby-light)] p-4 rounded-lg mb-6">
            {error}
          </div>
        )}

        <CartChangedBanner />

        {/* Shipping Address */}
        <div className="bg-white dark:bg-[var(--heron-forest)] rounded-xl p-6 mb-4 border border-[var(--heron-cream-dark)] dark:border-[var(--heron-slate-dark)]">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-lg font-semibold">Shipping Address</h2>
            <Link
              href="/shop/checkout/shipping"
              className="text-sm text-[var(--heron-slate)] dark:text-[var(--heron-slate-light)] hover:underline"
            >
              Edit
            </Link>
          </div>
          {shipping && (
            <div className="text-sm text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)] space-y-1">
              <p>
                {shipping.firstName} {shipping.lastName}
              </p>
              <p>{shipping.address1}</p>
              {shipping.address2 && <p>{shipping.address2}</p>}
              <p>
                {shipping.city}, {shipping.state} {shipping.postalCode}
              </p>
              <p>{shipping.email}</p>
              {shipping.phone && <p>{shipping.phone}</p>}
            </div>
          )}
        </div>

        {/* Payment Method */}
        <div className="bg-white dark:bg-[var(--heron-forest)] rounded-xl p-6 mb-4 border border-[var(--heron-cream-dark)] dark:border-[var(--heron-slate-dark)]">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-lg font-semibold">Payment Method</h2>
            <Link
              href="/shop/checkout/payment"
              className="text-sm text-[var(--heron-slate)] dark:text-[var(--heron-slate-light)] hover:underline"
            >
              Edit
            </Link>
          </div>
          {payment && (
            <div className="text-sm text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)]">
              <p>
                {payment.type === 'mock' ? 'Demo Payment' : 'Credit Card'}
                {payment.last4 && <span> ending in {payment.last4}</span>}
              </p>
            </div>
          )}
        </div>

        {/* Order Summary */}
        <div className="bg-white dark:bg-[var(--heron-forest)] rounded-xl p-6 mb-6 border border-[var(--heron-cream-dark)] dark:border-[var(--heron-slate-dark)]">
          <h2 className="text-lg font-semibold mb-4">Order Summary</h2>
          <div className="space-y-2 text-sm">
            {cart.items.map((item) => (
              <div key={item.lineItemId} className="flex justify-between">
                <span className="text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)]">
                  {/* One fallback rule for line identity (cart-line-display.ts): a line
                      without a snapshot shows `Variant <id>`, never the bare UUID this
                      surface used to render (mono #252 Phase 5a). */}
                  {cartLineLabel(item)} × {item.quantity}
                </span>
                <span>${((item.price * item.quantity) / 100).toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-[var(--heron-cream-dark)] dark:border-[var(--heron-slate-dark)] mt-4 pt-4 space-y-2 text-sm">
            <div className="flex justify-between text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)]">
              <span>Subtotal</span>
              <span>${(cart.subtotalPrice / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)]">
              <span>Shipping</span>
              <span>${(checkoutState.shippingCost / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)]">
              <span>Tax</span>
              <span>${(checkoutState.tax / 100).toFixed(2)}</span>
            </div>
            {cart.totalDiscounts > 0 && (
              <div className="flex justify-between text-[var(--success)]">
                <span>Discount</span>
                <span>-${(cart.totalDiscounts / 100).toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-xl pt-2 border-t border-[var(--heron-cream-dark)] dark:border-[var(--heron-slate-dark)]">
              <span>Total</span>
              <span>${(cart.totalPrice / 100).toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="space-y-3">
          <button
            onClick={handlePlaceOrder}
            disabled={isSubmitting || isCancelling}
            className="w-full bg-[var(--success)] hover:bg-[var(--success)]/90 text-white py-4 rounded-xl font-semibold transition-colors disabled:opacity-50"
          >
            {isSubmitting
              ? 'Processing...'
              : `Place Order — $${(cart.totalPrice / 100).toFixed(2)}`}
          </button>

          <button
            onClick={handleCancelCheckout}
            disabled={isSubmitting || isCancelling}
            className="w-full bg-transparent border border-[var(--heron-gray)] text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)] hover:bg-[var(--heron-cream-dark)] dark:hover:bg-[var(--heron-slate-dark)] py-3 rounded-xl font-medium transition-colors disabled:opacity-50"
          >
            {isCancelling ? 'Cancelling...' : 'Cancel Checkout'}
          </button>
        </div>
      </div>
    </div>
  );
}
