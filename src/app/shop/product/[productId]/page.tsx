import ShopProductPageClient from './ShopProductPageClient';

interface PageProps {
  params: Promise<{ productId: string }>;
}

export default async function ShopProductPage({ params }: PageProps) {
  const { productId } = await params;

  return <ShopProductPageClient productId={productId} />;
}
