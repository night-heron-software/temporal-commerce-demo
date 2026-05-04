'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCart } from '@/context/CartContext';

interface ShopNavBarProps {
  onCartClick: () => void;
}

export function ShopNavBar({ onCartClick }: ShopNavBarProps) {
  const pathname = usePathname();
  const { cart } = useCart();

  // Hide nav on checkout pages
  const isCheckoutPage = pathname?.startsWith('/shop/checkout');
  const itemCount = cart ? cart.items.reduce((acc, item) => acc + item.quantity, 0) : 0;

  if (isCheckoutPage) return null;

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md border-b border-zinc-200 dark:border-zinc-800">
      <div className="max-w-7xl mx-auto px-4 py-3">
        <div className="flex items-center justify-between">
          {/* Logo */}
          <Link
            href="/shop"
            className="text-xl font-bold tracking-tight text-indigo-600 dark:text-indigo-400"
          >
            Temporal Commerce
          </Link>

          {/* Right side */}
          <div className="flex items-center gap-3">
            {/* Admin Panel */}
            <Link
              href="/admin"
              className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors hidden sm:block"
            >
              ⚙️ Admin
            </Link>

            {/* Temporal UI Link */}
            <a
              href="http://localhost:8233"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors hidden sm:block"
              title="Open Temporal UI"
            >
              ⚡ Temporal UI
            </a>

            {/* Cart */}
            <button
              onClick={onCartClick}
              className="relative p-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors flex items-center gap-2"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-5 h-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z"
                />
              </svg>
              <span className="text-sm font-medium">{itemCount}</span>
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}
