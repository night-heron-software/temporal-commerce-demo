'use client';

import { useCart } from '@/context/CartContext';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { beginCheckout } from '@/app/shop/cart-actions';
import Link from 'next/link';

export default function CheckoutPage() {
  const router = useRouter();
  const { cart, cartId, loading } = useCart();
  const [isProcessing, setIsProcessing] = useState(false);
  const hasStartedCheckout = useRef(false);

  useEffect(() => {
    // Only process once, when we have a cart that's still active
    if (
      cartId &&
      cart?.status === 'active' &&
      cart?.items?.length > 0 &&
      !isProcessing &&
      !hasStartedCheckout.current
    ) {
      hasStartedCheckout.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time checkout initiation on mount with loading state
      setIsProcessing(true);

      beginCheckout(cartId)
        .then((updatedCart) => {
          if (updatedCart?.checkout?.step === 'shipping') {
            router.replace('/shop/checkout/shipping');
          } else if (updatedCart?.checkout?.error) {
            setIsProcessing(false);
            hasStartedCheckout.current = false;
          }
        })
        .catch(() => {
          setIsProcessing(false);
          hasStartedCheckout.current = false;
        });
    }
  }, [cartId, cart?.status, cart?.items?.length, isProcessing, router]);

  // If already in checkout mode, redirect to appropriate step
  useEffect(() => {
    if (cart?.status === 'checkout' && cart?.checkout?.step) {
      const step = cart.checkout.step;
      if (step === 'shipping') {
        router.replace('/shop/checkout/shipping');
      } else if (step === 'payment') {
        router.replace('/shop/checkout/payment');
      } else if (step === 'review') {
        router.replace('/shop/checkout/review');
      }
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
                  {item.variantId} × {item.quantity}
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

        <div className="text-center text-zinc-400 animate-pulse">
          {isProcessing ? 'Validating inventory...' : 'Preparing checkout...'}
        </div>
      </div>
    </div>
  );
}
