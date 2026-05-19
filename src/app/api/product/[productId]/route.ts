import { NextResponse } from 'next/server';
import { getElasticsearchClient } from '@/lib/es-client';


interface RouteParams {
  params: Promise<{ productId: string }>;
}

/**
 * GET /api/product/[productId]
 * Product detail — fetches from Elasticsearch products index.
 * Returns product info + all variants with images.
 */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { productId } = await params;

    const client = getElasticsearchClient();

    // Search ES for this product
    const response = await client.search({
      index: 'products',
      query: {
        bool: {
          must: [
            { term: { id: productId } }
          ]
        }
      },
      size: 1
    });

    if (!response.hits.hits.length) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const source = response.hits.hits[0]._source as Record<string, any>;

    // Build product context
    const product = {
      id: source.id,
      type: source.type || 'SIMULATED',
      name: source.name,
      description: source.description || '',
      collectionIds: source.collectionIds || [],
      collectionNames: source.collectionNames || [],
      brand: source.brand,
      model: source.model
    };

    // Build variants array from the ES document
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const variants = (source.variants || []).map((v: any) => ({
      id: v.variantId || v.id,
      blankSku: v.blankSku || v.sku,
      price: v.price || { amount: source.price?.amount || 0, currency: 'USD' },
      available: v.available !== false,
      variantImageUrl: v.images?.['front'] || source.defaultVariantImageUrl || '',
      options: v.options || [],
      images: v.images ?? {}
    }));

    // If no variants in ES doc, create a synthetic one from the product
    if (variants.length === 0) {
      variants.push({
        id: source.defaultVariantId || productId,
        blankSku: source.defaultVariantId || productId,
        price: source.price || { amount: 0, currency: 'USD' },
        available: true,
        variantImageUrl: source.defaultVariantImageUrl || '',
        options: [],
        images: source.defaultVariantImageUrl ? { front: source.defaultVariantImageUrl } : {}
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defaultVariant = variants.find((v: any) => v.available) || variants[0];

    return NextResponse.json({
      product,
      variants,
      defaultVariant
    });
  } catch (error) {
    console.error('Failed to fetch product:', error);
    return NextResponse.json({ error: 'Failed to fetch product' }, { status: 500 });
  }
}
