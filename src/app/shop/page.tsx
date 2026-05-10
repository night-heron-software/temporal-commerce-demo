'use client';

import { Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';

// Types
interface Product {
  id: string;
  name: string;
  description?: string;
  type: string;
  price: { amount: number; currency: string };
  collectionId?: string;
  collectionName?: string;
  defaultVariantId?: string;
  defaultVariantImageUrl?: string;
  /** Variant whose image is being displayed (e.g. from color filter match) */
  displayVariantId?: string;
}

interface Facets {
  collections: { name: string; count: number }[];
  types: { name: string; count: number }[];
  priceRanges: { label: string; min: number; max: number; count: number }[];
  colors: { name: string; hex?: string; count: number }[];
  sizes: { name: string; count: number }[];
}

interface SearchResponse {
  hits: Product[];
  total: number;
  page: number;
  pageSize: number;
  facets: Facets;
}

function ShopPageContent() {
  // Read URL search params for initial state
  const searchParams = useSearchParams();
  const initialCollection = searchParams.get('collection');
  const initialQuery = searchParams.get('q') || '';
  const initialType = searchParams.get('type');
  const initialSize = searchParams.get('size');

  // Search state
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(1);
  const pageSize = 24;

  // Filter state - initialize from URL params
  const [selectedCollection, setSelectedCollection] = useState<string | null>(initialCollection);
  const [selectedType, setSelectedType] = useState<string | null>(initialType);
  const [selectedColor, setSelectedColor] = useState<string | null>(null);
  const [selectedSize, setSelectedSize] = useState<string | null>(initialSize);
  const [selectedPriceRange, setSelectedPriceRange] = useState<{
    min?: number;
    max?: number;
  } | null>(null);

  // Debounce search and reset page when query changes
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
      setPage(1); // Reset page when search changes
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Sync filter state to URL (enables bookmarking and sharing)
  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQuery) params.set('q', debouncedQuery);
    if (selectedCollection) params.set('collection', selectedCollection);
    if (selectedType) params.set('type', selectedType);
    if (selectedColor) params.set('color', selectedColor);
    if (selectedSize) params.set('size', selectedSize);
    if (selectedPriceRange?.min !== undefined)
      params.set('priceMin', String(selectedPriceRange.min));
    if (selectedPriceRange?.max !== undefined)
      params.set('priceMax', String(selectedPriceRange.max));

    const queryString = params.toString();
    const newUrl = queryString ? `/shop?${queryString}` : '/shop';

    // Use replaceState to avoid cluttering browser history
    window.history.replaceState(null, '', newUrl);
  }, [debouncedQuery, selectedCollection, selectedType, selectedColor, selectedSize, selectedPriceRange]);

  // Build search URL
  const buildSearchUrl = useCallback(() => {
    const params = new URLSearchParams();
    if (debouncedQuery) params.set('q', debouncedQuery);
    if (selectedCollection) params.set('collection', selectedCollection);
    if (selectedType) params.set('type', selectedType);
    if (selectedColor) params.set('color', selectedColor);
    if (selectedSize) params.set('size', selectedSize);
    if (selectedPriceRange?.min !== undefined)
      params.set('priceMin', String(selectedPriceRange.min));
    if (selectedPriceRange?.max !== undefined)
      params.set('priceMax', String(selectedPriceRange.max));
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    return `/api/search?${params.toString()}`;
  }, [
    debouncedQuery,
    selectedCollection,
    selectedType,
    selectedColor,
    selectedSize,
    selectedPriceRange,
    page,
    pageSize
  ]);

  // Track if this is the initial load
  const isInitialLoad = useRef(true);

  // Fetch products
  useEffect(() => {
    // Only show loading spinner after initial load (async callback handles it)
    let isCurrent = true;
    const controller = new AbortController();

    // Set loading state via callback wrapper
    const fetchProducts = async () => {
      // Mark as loading only if not initial (initial starts with isLoading=true)
      if (!isInitialLoad.current) {
        setIsLoading(true);
      }
      isInitialLoad.current = false;

      try {
        const res = await fetch(buildSearchUrl(), { signal: controller.signal });
        const data: SearchResponse = await res.json();
        if (isCurrent) {
          setProducts(data.hits);
          setTotal(data.total);
          setFacets(data.facets);
          setIsLoading(false);
        }
      } catch (err) {
        if (isCurrent && (err as Error).name !== 'AbortError') {
          console.error(err);
          setIsLoading(false);
        }
      }
    };

    fetchProducts();

    return () => {
      isCurrent = false;
      controller.abort();
    };
  }, [buildSearchUrl]);

  // Filter change handlers that also reset page
  const handleCollectionChange = useCallback((name: string | null) => {
    setSelectedCollection(name);
    setPage(1);
  }, []);

  const handleTypeChange = useCallback((name: string | null) => {
    setSelectedType(name);
    setPage(1);
  }, []);

  const handleColorChange = useCallback((name: string | null) => {
    setSelectedColor(name);
    setPage(1);
  }, []);

  const handleSizeChange = useCallback((name: string | null) => {
    setSelectedSize(name);
    setPage(1);
  }, []);

  const handlePriceRangeChange = useCallback((range: { min?: number; max?: number } | null) => {
    setSelectedPriceRange(range);
    setPage(1);
  }, []);

  const clearFilters = () => {
    setSelectedCollection(null);
    setSelectedType(null);
    setSelectedColor(null);
    setSelectedSize(null);
    setSelectedPriceRange(null);
    setSearchQuery('');
  };

  const hasActiveFilters =
    selectedCollection || selectedType || selectedColor || selectedSize || selectedPriceRange || searchQuery;

  // Format price
  const formatPrice = (amount: number) => `$${(amount / 100).toFixed(2)}`;

  // Colors for display - from search response (contextual to current results)
  const topColors = useMemo(() => facets?.colors || [], [facets]);
  const topSizes = useMemo(() => facets?.sizes || [], [facets]);

  return (
    <div className="min-h-screen bg-[var(--heron-cream-light)] dark:bg-[var(--heron-forest-dark)] text-[var(--heron-slate-dark)] dark:text-[var(--heron-cream)] font-sans">
      {/* Search Bar */}
      <div className="bg-white dark:bg-[var(--heron-forest-dark)] border-b border-[var(--heron-cream-dark)] dark:border-[var(--heron-slate-dark)]">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex-1 max-w-xl">
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search products..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full px-4 py-2 pl-10 rounded-lg border border-[var(--heron-cream-dark)] dark:border-[var(--heron-slate-dark)] bg-white dark:bg-[var(--heron-forest)] focus:ring-2 focus:ring-[var(--heron-slate)] outline-none transition-all"
                />
                <svg
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--heron-gray)]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex gap-8">
          {/* Faceted Search Sidebar */}
          <aside className="hidden lg:block w-64 flex-shrink-0">
            <div className="sticky top-24 bg-white dark:bg-[var(--heron-forest)] rounded-xl border border-[var(--heron-cream-dark)] dark:border-[var(--heron-slate-dark)] p-4 space-y-6">
              <h3 className="font-semibold text-lg">Filters</h3>

              {/* Collection Filter */}
              {facets && facets.collections.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)]">
                    Collection
                  </h4>
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {facets.collections.map((c) => (
                      <button
                        key={c.name}
                        onClick={() =>
                          handleCollectionChange(selectedCollection === c.name ? null : c.name)
                        }
                        className={`w-full text-left px-2 py-1 text-sm rounded hover:bg-[var(--heron-cream)] dark:hover:bg-[var(--heron-slate-dark)] transition-colors ${
                          selectedCollection === c.name ? 'bg-[var(--heron-slate)] text-white' : ''
                        }`}
                      >
                        {c.name} <span className="text-[var(--heron-gray)]">({c.count})</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Type Filter */}
              {facets && facets.types.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)]">
                    Type
                  </h4>
                  <div className="space-y-1">
                    {facets.types.map((t) => (
                      <button
                        key={t.name}
                        onClick={() => handleTypeChange(selectedType === t.name ? null : t.name)}
                        className={`w-full text-left px-2 py-1 text-sm rounded hover:bg-[var(--heron-cream)] dark:hover:bg-[var(--heron-slate-dark)] transition-colors ${
                          selectedType === t.name ? 'bg-[var(--heron-slate)] text-white' : ''
                        }`}
                      >
                        {t.name} <span className="text-[var(--heron-gray)]">({t.count})</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Price Filter */}
              {facets && facets.priceRanges.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)]">
                    Price Range
                  </h4>
                  <div className="space-y-1">
                    {facets.priceRanges
                      .filter((p) => p.count > 0)
                      .map((p) => (
                        <button
                          key={p.label}
                          onClick={() =>
                            handlePriceRangeChange(
                              selectedPriceRange?.min === p.min
                                ? null
                                : { min: p.min, max: p.max === Infinity ? undefined : p.max }
                            )
                          }
                          className={`w-full text-left px-2 py-1 text-sm rounded hover:bg-[var(--heron-cream)] dark:hover:bg-[var(--heron-slate-dark)] transition-colors ${
                            selectedPriceRange?.min === p.min
                              ? 'bg-[var(--heron-slate)] text-white'
                              : ''
                          }`}
                        >
                          {p.label} <span className="text-[var(--heron-gray)]">({p.count})</span>
                        </button>
                      ))}
                  </div>
                </div>
              )}

              {/* Color Filter (from variants) */}
              {topColors.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)]">
                    Colors {selectedColor && <span className="text-xs">({selectedColor})</span>}
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {topColors.map((c) => (
                      <button
                        key={c.name}
                        onClick={() => handleColorChange(selectedColor === c.name ? null : c.name)}
                        className={`w-6 h-6 rounded-full border-2 transition-colors ${
                          selectedColor === c.name
                            ? 'ring-2 ring-offset-2 ring-[var(--heron-slate)] border-[var(--heron-slate)]'
                            : 'border-[var(--heron-cream-dark)] hover:border-[var(--heron-slate)]'
                        }`}
                        style={{ backgroundColor: c.hex || '#ccc' }}
                        title={`${c.name} (${c.count})`}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Size Filter (from variants) */}
              {topSizes.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)]">
                    Sizes {selectedSize && <span className="text-xs">({selectedSize})</span>}
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {topSizes.map((s) => (
                      <button
                        key={s.name}
                        onClick={() => handleSizeChange(selectedSize === s.name ? null : s.name)}
                        className={`px-3 py-1 text-sm border rounded hover:border-[var(--heron-slate)] transition-colors ${
                          selectedSize === s.name
                            ? 'bg-[var(--heron-slate)] text-white border-[var(--heron-slate)]'
                            : 'border-[var(--heron-cream-dark)] dark:border-[var(--heron-slate-dark)] bg-white dark:bg-[var(--heron-forest)]'
                        }`}
                        title={`${s.name} (${s.count})`}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="w-full py-2 text-sm text-[var(--heron-slate)] dark:text-[var(--heron-slate-light)] hover:underline"
                >
                  Clear all filters
                </button>
              )}
            </div>
          </aside>

          {/* Main Content */}
          <main className="flex-1">
            <div className="mb-6">
              <h2 className="text-3xl font-bold tracking-tight">Products</h2>
              <p className="text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)] mt-1">
                {total.toLocaleString()} product{total !== 1 ? 's' : ''} found
                {debouncedQuery && ` for "${debouncedQuery}"`}
              </p>
            </div>

            {isLoading ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {[...Array(8)].map((_, i) => (
                  <div key={i} className="animate-pulse">
                    <div className="aspect-square bg-[var(--heron-cream-dark)] dark:bg-[var(--heron-slate-dark)] rounded-lg mb-3" />
                    <div className="h-4 bg-[var(--heron-cream-dark)] dark:bg-[var(--heron-slate-dark)] rounded w-3/4 mx-auto" />
                  </div>
                ))}
              </div>
            ) : products.length === 0 ? (
              <div className="text-center py-16 bg-white dark:bg-[var(--heron-forest)] rounded-xl border border-dashed border-[var(--heron-cream-dark)] dark:border-[var(--heron-slate-dark)]">
                <svg
                  className="w-16 h-16 mx-auto text-[var(--heron-cream-dark)] dark:text-[var(--heron-slate-dark)] mb-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1}
                    d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                  />
                </svg>
                <p className="text-[var(--heron-gray-dark)] dark:text-[var(--heron-gray)] text-lg">
                  No products found
                </p>
                {hasActiveFilters && (
                  <button
                    onClick={clearFilters}
                    className="mt-4 text-[var(--heron-slate)] hover:underline"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {products.map((product) => (
                    <Link
                      key={product.id}
                      href={`/shop/product/${product.id}${product.displayVariantId ? `?variantId=${product.displayVariantId}` : product.defaultVariantId ? `?variantId=${product.defaultVariantId}` : ''}`}
                      className="group block bg-white dark:bg-[var(--heron-forest)] rounded-lg border border-[var(--heron-cream-dark)] dark:border-[var(--heron-slate-dark)] shadow-sm hover:border-[var(--heron-slate)] dark:hover:border-[var(--heron-slate-light)] hover:shadow-lg transition-all duration-300 overflow-hidden"
                    >
                      <div className="aspect-square relative bg-[var(--heron-cream)] dark:bg-[var(--heron-slate-dark)] overflow-hidden">
                        {product.defaultVariantImageUrl ? (
                          <Image
                            src={product.defaultVariantImageUrl}
                            alt={product.name}
                            fill
                            sizes="(max-width: 768px) 50vw, (max-width: 1024px) 33vw, 25vw"
                            className="object-cover group-hover:scale-105 transition-transform duration-300"
                            unoptimized
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[var(--heron-gray)] text-sm">
                            No image
                          </div>
                        )}
                      </div>
                      <div className="p-4">
                        <h3 className="font-semibold text-sm truncate group-hover:text-[var(--heron-slate)] dark:group-hover:text-[var(--heron-slate-light)] transition-colors">
                          {product.name}
                        </h3>
                        {product.collectionName && (
                          <p className="text-xs text-[var(--heron-gray)] truncate">
                            {product.collectionName}
                          </p>
                        )}
                        <p className="text-sm font-medium mt-1">
                          {formatPrice(product.price.amount)}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>

                {/* Pagination */}
                {total > pageSize && (
                  <div className="mt-8 flex justify-center gap-2">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="px-4 py-2 rounded-lg border border-[var(--heron-cream-dark)] dark:border-[var(--heron-slate-dark)] disabled:opacity-50 hover:bg-[var(--heron-cream)] dark:hover:bg-[var(--heron-slate-dark)] transition-colors"
                    >
                      Previous
                    </button>
                    <span className="px-4 py-2">
                      Page {page} of {Math.ceil(total / pageSize)}
                    </span>
                    <button
                      onClick={() => setPage((p) => p + 1)}
                      disabled={page >= Math.ceil(total / pageSize)}
                      className="px-4 py-2 rounded-lg border border-[var(--heron-cream-dark)] dark:border-[var(--heron-slate-dark)] disabled:opacity-50 hover:bg-[var(--heron-cream)] dark:hover:bg-[var(--heron-slate-dark)] transition-colors"
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

export default function ShopPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[var(--heron-cream-light)] dark:bg-[var(--heron-forest-dark)] flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[var(--heron-slate)] mx-auto"></div>
        </div>
      }
    >
      <ShopPageContent />
    </Suspense>
  );
}
