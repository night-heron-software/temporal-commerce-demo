'use client';

import { useCart } from '@/context/CartContext';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { beginCheckout, getCheckoutState } from '@/app/shop/cart-actions';
import Link from 'next/link';

/** How long to wait for the checkout workflow to reach an actionable step. */
const CHECKOUT_READY_TIMEOUT_MS =
  Number(process.env.NEXT_PUBLIC_CHECKOUT_READY_TIMEOUT_MS) || 30_000;
const POLL_INTERVAL_MS = 1_000;

/** Route for each actionable checkout step; terminal steps handled separately. */
function routeForStep(step: string | undefined): string | null {
  if (step === 'shipping') return '/shop/checkout/shipping';
  if (step === 'payment') return '/shop/checkout/payment';
  if (step === 'review') return '/shop/checkout/review';
  return null;
}

export default function CheckoutPage() {
  const router = useRouter();
  const { cart, cartId, loading } = useCart();
  const [isProcessing, setIsProcessing] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const hasStartedCheckout = useRef(false);

  useEffect(() => {
    // Only process once, when we have a cart that's still active
    if (
      cartId &&
      cart?.status === 'active' &&
      cart?.items?.length > 0 &&
      !isProcessing &&
      !checkoutError &&
      !hasStartedCheckout.current
    ) {
      hasStartedCheckout.current = true;
      setIsProcessing(true);

      // Kick off checkout, then poll (bounded) until the workflow leaves 'validating' —
      // previously a step that never reached 'shipping' left the spinner up forever.
      const run = async () => {
        const updatedCart = await beginCheckout(cartId);
        if (updatedCart?.checkout?.error) {
          throw new Error(updatedCart.checkout.error);
        }

        const deadline = Date.now() + CHECKOUT_READY_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const state =
            updatedCart?.checkout?.step && routeForStep(updatedCart.checkout.step)
              ? updatedCart.checkout
              : await getCheckoutState(cartId);

          const route = routeForStep(state?.step);
          if (route) {
            router.replace(route);
            return;
          }
          if (state?.step === 'complete' && state.order) {
            router.replace(`/shop/checkout/confirmation?order=${state.order.confirmationNumber}`);
            return;
          }
          if (state?.step === 'failed' || state?.step === 'cancelled') {
            throw new Error(state.error || `Checkout ${state.step}. Please try again.`);
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        throw new Error('Checkout is taking longer than expected. Please try again.');
      };

      run().catch((e) => {
        setIsProcessing(false);
        hasStartedCheckout.current = false;
        setCheckoutError(e instanceof Error ? e.message : 'Unable to start checkout.');
      });
    }
  }, [cartId, cart?.status, cart?.items?.length, isProcessing, checkoutError, router]);

  // If already in checkout mode, redirect to appropriate step
  useEffect(() => {
    if (cart?.status === 'checkout' && cart?.checkout?.step) {
      const route = routeForStep(cart.checkout.step);
      if (route) router.replace(route);
    }
  }, [cart?.status, cart?.checkout?.step, router]);

  if (loading || !cart) {
    return (
      <div className="min-h-screen bg-zinc-900 text-white flex items-center justify-center">
        <div className="animate-pulse text-lg">Loading checkout...</div>
      </div>
    );
  }

  if (cart.items.length === 0) {
    return (
      <div className="min-h-screen bg-zinc-900 text-white flex flex-col items-center justify-center">
        <h1 className="text-2xl font-bold mb-4">Your cart is empty</h1>
        <Link href="/shop" className="text-purple-400 hover:underline">
          Continue Shopping
        </Link>
      </div>
    );
  }

  // Show cart review while processing
  return (
    <div className="min-h-screen bg-zinc-900 text-white p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">Checkout</h1>

        <div className="bg-zinc-800 rounded-xl p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">Order Summary</h2>
          <div className="space-y-4">
            {cart.items.map((item) => (
              <div key={item.lineItemId} className="flex justify-between">
                <span className="text-zinc-300">
                  {item.productTitle ?? item.variantId}
                  {item.variantTitle ? ` — ${item.variantTitle}` : ''} × {item.quantity}
                </span>
                <span>${((item.price * item.quantity) / 100).toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-zinc-700 mt-4 pt-4 space-y-2">
            <div className="flex justify-between text-zinc-400">
              <span>Subtotal</span>
              <span>${(cart.subtotalPrice / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-xl font-bold">
              <span>Total</span>
              <span>${(cart.totalPrice / 100).toFixed(2)}</span>
            </div>
          </div>
        </div>

        {checkoutError ? (
          <div className="text-center space-y-4">
            <p className="text-red-400">{checkoutError}</p>
            <div className="flex justify-center gap-6">
              <button
                onClick={() => setCheckoutError(null)}
                className="text-purple-400 hover:underline"
              >
                Try again
              </button>
              <Link href="/shop" className="text-zinc-400 hover:underline">
                Return to shop
              </Link>
            </div>
          </div>
        ) : (
          <div className="text-center text-zinc-400 animate-pulse">
            {isProcessing ? 'Validating inventory...' : 'Preparing checkout...'}
          </div>
        )}
      </div>
    </div>
  );
}
