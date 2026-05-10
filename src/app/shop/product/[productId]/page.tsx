import { Suspense } from 'react';
import ShopProductPageClient from './ShopProductPageClient';

interface PageProps {
  params: Promise<{ productId: string }>;
}

export default async function ShopProductPage({ params }: PageProps) {
  const { productId } = await params;

  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-50 dark:bg-zinc-900 flex items-center justify-center">
        <div className="animate-pulse text-lg text-zinc-500">Loading...</div>
      </div>
    }>
      <ShopProductPageClient productId={productId} />
    </Suspense>
  );
}
