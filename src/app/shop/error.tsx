'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function ShopError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center p-8 bg-zinc-900 text-white">
      <div className="bg-zinc-800 p-8 rounded-xl max-w-md w-full text-center border border-red-900/50 shadow-lg">
        <h2 className="text-2xl font-bold text-red-400 mb-4">Oops! Something went wrong</h2>
        <p className="text-zinc-400 mb-8">
          We encountered an unexpected error while loading this page.
        </p>
        <div className="flex flex-col gap-3">
          <button
            onClick={() => reset()}
            className="w-full bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-xl font-medium transition-colors"
          >
            Try again
          </button>
          <Link
            href="/shop"
            className="w-full text-zinc-300 hover:text-white px-6 py-3 font-medium transition-colors text-center inline-block bg-zinc-700 hover:bg-zinc-600 rounded-xl"
          >
            Return to Shop
          </Link>
        </div>
      </div>
    </div>
  );
}
