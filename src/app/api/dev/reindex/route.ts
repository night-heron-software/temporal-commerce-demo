/**
 * POST /api/dev/reindex
 * Reindex Cassandra data into Elasticsearch.
 * Body: { index: 'products' | 'collections' }
 */
import { NextRequest, NextResponse } from 'next/server';
import { executeCql } from '@/lib';
import { getElasticsearchClient } from '@/lib/es-client';
import { INDEX_MAPPINGS } from '@/lib/es-index-mappings';

/** Cassandra UUID columns have a toString() method */
type CqlUuid = { toString(): string };

export async function POST(request: NextRequest) {
  try {
    const { index } = await request.json() as { index: string };

    if (index !== 'products' && index !== 'collections') {
      return NextResponse.json({ error: `Unknown index: ${index}` }, { status: 400 });
    }

    const esClient = getElasticsearchClient();

    // Delete and recreate index
    try {
      await esClient.indices.delete({ index });
    } catch {
      // Index may not exist
    }

    await esClient.indices.create({
      index,
      mappings: INDEX_MAPPINGS[index]
    });

    let indexed = 0;
    const errors: string[] = [];

    if (index === 'products') {
      // Read products from Cassandra
      interface ProductRow {
        id: CqlUuid;
        name: string;
        description: string;
        type: string;
        base_price_amount: number;
        base_price_currency: string;
        collection_ids: CqlUuid[] | null;
        collection_names: string[] | null;
        default_variant_id: CqlUuid | null;
        default_variant_image_url: string | null;
        created_at: Date | null;
        updated_at: Date | null;
      }

      interface VariantRow {
        id: CqlUuid;
        product_id: CqlUuid;
        blank_sku: string;
        price_amount: number;
        price_currency: string;
        available: boolean;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options: any[] | null;
        images: Record<string, string> | null;
      }

      const productRows = await executeCql<ProductRow>('SELECT * FROM products');
      const variantRows = await executeCql<VariantRow>('SELECT * FROM variants');

      // Group variants by product
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const variantsByProduct = new Map<string, any[]>();
      for (const v of variantRows) {
        const pid = v.product_id.toString();
        const variantDoc = {
          id: v.id.toString(),
          blankSku: v.blank_sku,
          price: { amount: v.price_amount, currency: v.price_currency },
          available: v.available,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          options: (v.options ?? []).map((o: any) => ({
            optionType: o.option_type,
            value: { label: o.label, hex: o.attributes?.hex }
          })),
          frontImageUrl: v.images?.['front']
        };
        if (!variantsByProduct.has(pid)) variantsByProduct.set(pid, []);
        variantsByProduct.get(pid)!.push(variantDoc);
      }

      for (const row of productRows) {
        try {
          const productId = row.id.toString();
          const doc = {
            id: productId,
            name: row.name,
            description: row.description,
            type: row.type,
            price: { amount: row.base_price_amount, currency: row.base_price_currency },
            collectionIds: row.collection_ids?.map(id => id.toString()),
            collectionNames: row.collection_names,
            defaultVariantId: row.default_variant_id?.toString(),
            defaultVariantImageUrl: row.default_variant_image_url,
            variants: variantsByProduct.get(productId) ?? [],
            createdAt: row.created_at?.toISOString(),
            updatedAt: row.updated_at?.toISOString()
          };

          await esClient.index({ index: 'products', id: productId, document: doc });
          indexed++;
        } catch (err) {
          errors.push(`Product ${row.id}: ${err}`);
        }
      }
    } else if (index === 'collections') {
      interface CollectionRow {
        id: CqlUuid;
        name: string;
      }

      const rows = await executeCql<CollectionRow>('SELECT * FROM collections');
      for (const row of rows) {
        try {
          const doc = {
            id: row.id.toString(),
            name: row.name,
            productCount: 0
          };
          await esClient.index({ index: 'collections', id: doc.id, document: doc });
          indexed++;
        } catch (err) {
          errors.push(`Collection ${row.id}: ${err}`);
        }
      }
    }

    await esClient.indices.refresh({ index });

    return NextResponse.json({ success: true, indexed, errors: errors.length > 0 ? errors : undefined });
  } catch (error) {
    console.error('Reindex failed:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
