import Link from 'next/link';

export default function ShopNotFound() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center p-8 bg-zinc-900 text-white">
      <div className="bg-zinc-800 p-8 rounded-xl max-w-md w-full text-center border border-zinc-700 shadow-lg">
        <div className="text-6xl mb-4">🔍</div>
        <h2 className="text-2xl font-bold text-white mb-4">Page Not Found</h2>
        <p className="text-zinc-400 mb-8">
          We couldn&apos;t find the page you&apos;re looking for.
        </p>
        <Link
          href="/shop"
          className="inline-block w-full bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-xl font-medium transition-colors"
        >
          Return to Shop
        </Link>
      </div>
    </div>
  );
}
