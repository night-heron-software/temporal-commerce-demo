'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useCart } from '@/context/CartContext';
import { setPaymentMethod, getCheckoutState } from '@/app/shop/cart-actions';

/**
 * Mock Payment Page — Demo version
 * Simulates payment collection.
 */
export default function PaymentPage() {
  const router = useRouter();
  const { cartId, refreshCart } = useCart();
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Redirect if no cart
  useEffect(() => {
    if (!cartId) router.push('/shop');
  }, [cartId, router]);

  const handleMockPayment = async () => {
    if (!cartId) return;
    setIsProcessing(true);
    setError(null);

    try {
      const state = await setPaymentMethod(cartId, {
        type: 'mock',
        last4: '4242',
        token: 'mock_token_' + Date.now()
      });

      if (state?.step === 'review') {
        router.push('/shop/checkout/review');
      } else {
        setError('Failed to process payment information');
      }
    } catch (err) {
      setError('An error occurred. Please try again.');
      console.error(err);
    } finally {
      setIsProcessing(false);
    }
  };

  if (!cartId) return null;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="mt-8 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-xl font-semibold mb-6">Payment</h2>

        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-6">
          <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="font-medium">Demo Mode</span>
          </div>
          <p className="mt-1 text-sm text-blue-600 dark:text-blue-400">
            Payment is simulated. No real charges will be made. Click below to proceed.
          </p>
        </div>

        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-8 bg-gradient-to-r from-indigo-500 to-purple-600 rounded flex items-center justify-center">
              <span className="text-white text-xs font-bold">DEMO</span>
            </div>
            <div>
              <p className="font-medium">Mock Credit Card</p>
              <p className="text-sm text-gray-500">**** **** **** 4242</p>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300 text-sm">
            {error}
          </div>
        )}

        <button
          onClick={handleMockPayment}
          disabled={isProcessing}
          className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium rounded-lg transition-colors"
        >
          {isProcessing ? 'Processing...' : 'Continue with Mock Payment'}
        </button>
      </div>
    </div>
  );
}
