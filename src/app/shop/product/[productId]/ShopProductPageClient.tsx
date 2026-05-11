'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import ProductImageGallery from './ProductImageGallery';
import ShopVariantSelector from './ShopVariantSelector';
import { useCart } from '@/context/CartContext';
import type { Catalog } from '@/temporal/contracts';

// Extended product context with collections from API
interface ProductWithCollections extends Catalog.ProductContext {
  collectionIds?: string[];
  collectionNames?: string[];
}

// Helper to get display text from option (handles both Cassandra flat format and OptionSelection format)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getOptionDisplayValue(option: any): string {
  // Cassandra flat format: { option_type, label, attributes }
  if (typeof option?.label === 'string') return option.label;
  // OptionSelection format: { optionType, value: { label | name } }
  const value = option?.value;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.label === 'string') return v.label;
    if (typeof v.name === 'string') return v.name;
  }
  return 'N/A';
}

// Extended variant with full images
interface VariantWithImages extends Catalog.RelatedVariant {
  images?: Catalog.ImageMap;
}

interface ProductDetailResponse {
  product: ProductWithCollections;
  variants: VariantWithImages[];
  defaultVariant: VariantWithImages | null;
}

interface ShopProductPageClientProps {
  productId: string;
}

async function getProductDetail(productId: string): Promise<ProductDetailResponse | null> {
  try {
    const res = await fetch(`/api/product/${productId}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    console.error(e);
    return null;
  }
}

export default function ShopProductPageClient({ productId }: ShopProductPageClientProps) {
  const [data, setData] = useState<ProductDetailResponse | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<VariantWithImages | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { addItem, loading: cartLoading } = useCart();

  const handleAddToCart = async () => {
    if (!selectedVariant) return;
    await addItem(selectedVariant.id, 1, selectedVariant.price.amount);
  };

  const searchParams = useSearchParams();
  const requestedVariantId = searchParams.get('variantId');

  useEffect(() => {
    getProductDetail(productId).then((result) => {
      setData(result);
      if (result) {
        // If a specific variant was requested (e.g. from shop page color filter),
        // select it instead of the default
        const targetVariant = requestedVariantId
          ? result.variants.find((v) => v.id === requestedVariantId)
          : null;
        setSelectedVariant(targetVariant || result.defaultVariant);
      }
      setIsLoading(false);
    });
  }, [productId, requestedVariantId]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 font-sans flex items-center justify-center">
        <div className="animate-pulse text-lg">Loading...</div>
      </div>
    );
  }

  if (!data || !selectedVariant) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 font-sans flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">Product Not Found</h1>
          <Link href="/shop" className="text-purple-600 hover:underline">
            ← Back to Shop
          </Link>
        </div>
      </div>
    );
  }

  const { product, variants } = data;

  // Build variant options for display - handle both formats
  const variantDescription = selectedVariant.options
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ?.map((o: any) => getOptionDisplayValue(o))
    .join(' / ');

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 font-sans">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md border-b border-zinc-200 dark:border-zinc-800">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Link
              href="/shop"
              className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
            >
              ← Back to Shop
            </Link>
            <span className="text-2xl font-bold tracking-tight">{product.name}</span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="grid lg:grid-cols-2 gap-12">
          {/* Product Images - uses selected variant's images */}
          <div className="space-y-4">
            <ProductImageGallery
              key={selectedVariant.id}
              images={getVariantImages(selectedVariant)}
              productName={product.name}
            />
          </div>

          {/* Product Details */}
          <div className="space-y-6">
            <div>
              <span className="text-sm px-3 py-1 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded-full">
                {product.type}
              </span>
              {/* Collection Tags */}
              {product.collectionNames && product.collectionNames.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {product.collectionNames.map((name: string, i: number) => (
                    <Link
                      key={i}
                      href={`/shop?collection=${encodeURIComponent(name)}`}
                      className="text-xs px-2 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                    >
                      {name}
                    </Link>
                  ))}
                </div>
              )}
              <h1 className="text-3xl font-bold mt-4">{product.name}</h1>
              {product.brand && product.model && (
                <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
                  {product.brand} {product.model}
                </p>
              )}
              {variantDescription && (
                <p className="text-lg text-zinc-600 dark:text-zinc-400 mt-2">
                  {variantDescription}
                </p>
              )}
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1 font-mono">
                SKU: {selectedVariant.blankSku}
              </p>
            </div>

            {/* Price & Availability */}
            <div className="bg-white dark:bg-zinc-950 p-6 rounded-xl border border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <p className="text-4xl font-bold text-green-600 dark:text-green-400">
                  ${(selectedVariant.price.amount / 100).toFixed(2)}
                  <span className="text-base font-normal text-zinc-500 ml-2">
                    {selectedVariant.price.currency}
                  </span>
                </p>
                <span
                  className={`px-4 py-2 rounded-full text-sm font-medium ${
                    selectedVariant.available
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                      : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                  }`}
                >
                  {selectedVariant.available ? 'In Stock' : 'Out of Stock'}
                </span>
              </div>
            </div>

            {/* Variant Selector */}
            <ShopVariantSelector
              currentVariantId={selectedVariant.id}
              currentOptions={selectedVariant.options ?? []}
              relatedVariants={variants}
              productId={productId}
              onVariantChange={(v) => setSelectedVariant(v as VariantWithImages)}
            />

            {/* Add to Cart Button */}
            <button
              className="w-full py-4 bg-purple-600 hover:bg-purple-700 text-white font-semibold rounded-xl transition-colors text-lg disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={!selectedVariant.available || cartLoading}
              onClick={handleAddToCart}
            >
              {cartLoading
                ? 'Adding...'
                : selectedVariant.available
                  ? 'Add to Cart'
                  : 'Out of Stock'}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

// Helper to extract images from variant
function getVariantImages(variant: VariantWithImages): Record<string, string> {
  // Use full images map if available, otherwise fallback to variantImageUrl
  if (variant.images && Object.keys(variant.images).length > 0) {
    return variant.images;
  }
  if (variant.variantImageUrl) {
    return { front: variant.variantImageUrl };
  }
  return {};
}
