'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';

const steps = [
  { key: 'shipping', label: 'Shipping', path: '/shop/checkout/shipping' },
  { key: 'payment', label: 'Payment', path: '/shop/checkout/payment' },
  { key: 'review', label: 'Review', path: '/shop/checkout/review' }
];

export function CheckoutProgress() {
  const pathname = usePathname();

  // Don't show on the checkout entry page
  if (pathname === '/shop/checkout') {
    return null;
  }

  const currentIndex = steps.findIndex((s) => pathname?.startsWith(s.path));

  return (
    <div className="w-full max-w-2xl mx-auto mb-8">
      <div className="flex items-center justify-between">
        {steps.map((step, i) => {
          const isActive = i === currentIndex;
          const isCompleted = i < currentIndex;
          const isClickable = isCompleted; // Only completed steps are clickable

          const circleContent = (
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-300 ${
                  isActive
                    ? 'bg-[var(--heron-slate)] dark:bg-[var(--heron-cream)] text-white dark:text-[var(--heron-slate-dark)] ring-4 ring-[var(--heron-slate)]/20 dark:ring-[var(--heron-cream)]/20'
                    : isCompleted
                      ? 'bg-[var(--success)] text-white'
                      : 'bg-[var(--heron-cream-dark)] dark:bg-[var(--heron-slate-dark)] text-[var(--heron-gray)]'
                }`}
              >
                {isCompleted ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2.5}
                    stroke="currentColor"
                    className="w-4 h-4"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={`text-xs font-medium transition-colors ${
                  isActive
                    ? 'text-[var(--heron-slate-dark)] dark:text-[var(--heron-cream)]'
                    : isCompleted
                      ? 'text-[var(--success)]'
                      : 'text-[var(--heron-gray)]'
                }`}
              >
                {step.label}
              </span>
            </div>
          );

          return (
            <div key={step.key} className="flex items-center flex-1 last:flex-initial">
              {isClickable ? (
                <Link href={step.path} className="hover:opacity-80 transition-opacity">
                  {circleContent}
                </Link>
              ) : (
                circleContent
              )}

              {/* Connector line */}
              {i < steps.length - 1 && (
                <div className="flex-1 mx-3 mt-[-1.25rem]">
                  <div
                    className={`h-0.5 rounded-full transition-colors duration-300 ${
                      i < currentIndex
                        ? 'bg-[var(--success)]'
                        : 'bg-[var(--heron-cream-dark)] dark:bg-[var(--heron-slate-dark)]'
                    }`}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
