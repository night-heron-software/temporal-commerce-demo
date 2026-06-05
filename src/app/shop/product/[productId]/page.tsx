import ShopProductPageClient from './ShopProductPageClient';

interface PageProps {
  params: Promise<{ productId: string }>;
  searchParams: Promise<{ variant?: string }>;
}

export default async function ShopProductPage({ params, searchParams }: PageProps) {
  const { productId } = await params;
  const { variant: initialVariantId } = await searchParams;

  return <ShopProductPageClient productId={productId} initialVariantId={initialVariantId} />;
}
