'use client';

import { useCart } from '@/context/CartContext';
import { useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import { submitOrder, cancelCheckout, getCheckoutState } from '@/app/shop/cart-actions';
import Link from 'next/link';
import { CartChangedBanner } from '@/components/CartChangedBanner';
import type { Cart } from "@/temporal/contracts";

export default function ReviewPage() {
  const router = useRouter();
  const { cart, cartId, refreshCart, clearCart } = useCart();
  const [checkoutState, setCheckoutState] = useState<Cart.CheckoutState | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch full checkout state (includes shipping/payment details)
  useEffect(() => {
    if (cartId && cart?.status === 'checkout') {
      getCheckoutState(cartId).then((state) => {
        if (state) {
          setCheckoutState(state);
          // If not on review step, redirect to the correct step
          if (state.step !== 'review') {
            if (state.step === 'shipping') {
              router.replace('/shop/checkout/shipping');
            } else if (state.step === 'payment') {
              router.replace('/shop/checkout/payment');
            }
          }
        }
      });
    }
  }, [cartId, cart?.status, router]);

  // Redirect if not in checkout
  useEffect(() => {
    if (cart && cart.status !== 'checkout') {
      router.replace('/shop');
    }
  }, [cart, router]);

  const handlePlaceOrder = async () => {
    if (!cartId) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const finalState = await submitOrder(cartId);

      if (finalState?.step === 'complete' && finalState.order) {
        clearCart();
        router.push(`/shop/checkout/confirmation?order=${finalState.order.confirmationNumber}`);
      } else if (finalState?.error) {
        setError(finalState.error);
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
              <p>{shipping.firstName} {shipping.lastName}</p>
              <p>{shipping.address1}</p>
              {shipping.address2 && <p>{shipping.address2}</p>}
              <p>{shipping.city}, {shipping.state} {shipping.postalCode}</p>
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
                {payment.type === 'mock' ? 'Demo Payment' : payment.type === 'stripe' ? 'Credit Card' : 'Card'}
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
                  {item.variantId} × {item.quantity}
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
            {isSubmitting ? 'Processing...' : `Place Order — $${(cart.totalPrice / 100).toFixed(2)}`}
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
