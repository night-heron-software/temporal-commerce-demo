'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function ConfirmationContent() {
  const searchParams = useSearchParams();
  const orderNumber = searchParams.get('order');

  return (
    <div className="min-h-screen bg-[var(--heron-cream-light)] dark:bg-[var(--heron-forest-dark)] text-[var(--heron-slate-dark)] dark:text-[var(--heron-cream)] flex items-center justify-center p-8">
      <div className="max-w-lg text-center">
        <div className="w-20 h-20 bg-[var(--success)]/20 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            className="w-10 h-10 text-[var(--success)]"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>

        <h1 className="text-3xl font-bold mb-2">Thank You!</h1>
        <p className="text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)] mb-6">
          Your order has been placed successfully.
        </p>

        {orderNumber && (
          <div className="bg-white dark:bg-[var(--heron-forest)] rounded-xl p-6 mb-8 border border-[var(--heron-cream-dark)] dark:border-[var(--heron-slate-dark)]">
            <p className="text-sm text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)] mb-1">
              Order Confirmation
            </p>
            <p className="text-2xl font-mono font-bold text-[var(--heron-slate)] dark:text-[var(--heron-slate-light)]">
              {orderNumber}
            </p>
          </div>
        )}

        <p className="text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)] text-sm mb-8">
          A confirmation email has been sent to your email address.
        </p>

        <Link
          href="/shop"
          className="inline-block bg-[var(--heron-slate)] hover:bg-[var(--heron-slate-dark)] text-white px-8 py-3 rounded-xl font-semibold transition-colors"
        >
          Continue Shopping
        </Link>
      </div>
    </div>
  );
}

export default function ConfirmationPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[var(--heron-cream-light)] dark:bg-[var(--heron-forest-dark)] text-[var(--heron-slate-dark)] dark:text-[var(--heron-cream)] flex items-center justify-center">
          <div className="animate-pulse text-lg">Loading...</div>
        </div>
      }
    >
      <ConfirmationContent />
    </Suspense>
  );
}
