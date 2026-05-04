/**
 * POST /api/seed-cassandra
 * Seeds Cassandra with catalog data from sample-data/catalog.json.
 * No auth required — demo mode.
 */
import { NextResponse } from 'next/server';
import { getCassandraClient, executeCql, cassandraTypes as types } from '@/lib';
import { DEMO_STORE_ID } from '@/lib/constants';
import path from 'path';
import fs from 'fs/promises';

interface SampleData {
  collections: Array<{
    id: string;
    name: string;
    description: string;
  }>;
  products: Array<{
    id: string;
    type: string;
    name: string;
    description?: string;
    base_price_amount: number;
    base_price_currency: string;
    blank_brand?: string;
    blank_model?: string;
    default_variant_id?: string;
    default_variant_image_url?: string;
    collection_ids?: string[];
    collection_names?: string[];
  }>;
  variants: Array<{
    id: string;
    blank_sku: string;
    product_id: string;
    product_name: string;
    product_type: string;
    price_amount: number;
    price_currency: string;
    available: boolean;
    images?: Record<string, string>;
    options?: Array<{ option_type: string; label: string; attributes?: Record<string, string> }>;
  }>;
  option_types: Array<{ name: string; description: string }>;
  option_values: Array<{ option_type: string; label: string; attributes: Record<string, string> }>;
}

export async function POST() {
  const results = {
    reset: false,
    store: false,
    collections: 0,
    products: 0,
    variants: 0,
    option_types: 0,
    option_values: 0,
    errors: [] as string[]
  };

  try {
    const now = new Date();
    const storeId = types.Uuid.fromString(DEMO_STORE_ID);

    // Create demo store
    await executeCql(
      `INSERT INTO stores (id, name, slug, status, owner_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [storeId, 'Temporal Commerce Demo', 'demo', 'active', 'demo@example.com', now, now]
    );
    results.store = true;

    // Load sample data
    const dataPath = path.join(process.cwd(), 'sample-data', 'catalog.json');
    const fileContent = await fs.readFile(dataPath, 'utf-8');
    const sampleData = JSON.parse(fileContent) as SampleData;

    // Insert collections
    for (const collection of sampleData.collections) {
      try {
        await executeCql(
          `INSERT INTO collections (store_id, id, name, description, created_at) VALUES (?, ?, ?, ?, ?)`,
          [storeId, types.Uuid.fromString(collection.id), collection.name, collection.description, now]
        );
        results.collections++;
      } catch (error) {
        results.errors.push(`Collection ${collection.id}: ${error}`);
      }
    }

    // Insert products
    for (const product of sampleData.products) {
      try {
        await executeCql(
          `INSERT INTO products (
            store_id, id, type, collection_ids, collection_names, name, description,
            base_price_amount, base_price_currency, blank_brand, blank_model,
            default_variant_id, default_variant_image_url,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            storeId,
            types.Uuid.fromString(product.id),
            product.type,
            product.collection_ids?.map((id) => types.Uuid.fromString(id)) || [],
            product.collection_names ?? [],
            product.name,
            product.description ?? null,
            product.base_price_amount,
            product.base_price_currency,
            product.blank_brand ?? null,
            product.blank_model ?? null,
            product.default_variant_id ? types.Uuid.fromString(product.default_variant_id) : null,
            product.default_variant_image_url ?? null,
            now,
            now
          ]
        );

        // Products by collection
        if (product.collection_ids?.length) {
          for (const collectionId of product.collection_ids) {
            await executeCql(
              `INSERT INTO products_by_collection (
                store_id, collection_id, product_id, type, name,
                base_price_amount, base_price_currency,
                default_variant_id, default_variant_image_url
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                storeId,
                types.Uuid.fromString(collectionId),
                types.Uuid.fromString(product.id),
                product.type,
                product.name,
                product.base_price_amount,
                product.base_price_currency,
                product.default_variant_id ? types.Uuid.fromString(product.default_variant_id) : null,
                product.default_variant_image_url ?? null
              ]
            );
          }
        }

        results.products++;
      } catch (error) {
        results.errors.push(`Product ${product.id}: ${error}`);
      }
    }

    // Insert variants
    for (const variant of sampleData.variants) {
      try {
        await executeCql(
          `INSERT INTO variants (
            store_id, id, blank_sku, product_id, product_name, product_type,
            price_amount, price_currency, available, images, options, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            storeId,
            types.Uuid.fromString(variant.id),
            variant.blank_sku,
            types.Uuid.fromString(variant.product_id),
            variant.product_name,
            variant.product_type,
            variant.price_amount,
            variant.price_currency,
            variant.available,
            variant.images ?? {},
            variant.options ?? [],
            now
          ]
        );

        const primaryImageUrl =
          variant.images?.['front'] ??
          variant.images?.['back'] ??
          Object.values(variant.images ?? {})[0] ??
          null;
        await executeCql(
          `INSERT INTO variants_by_product (
            store_id, product_id, id, blank_sku, price_amount, price_currency,
            available, variant_image_url, options
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            storeId,
            types.Uuid.fromString(variant.product_id),
            types.Uuid.fromString(variant.id),
            variant.blank_sku,
            variant.price_amount,
            variant.price_currency,
            variant.available,
            primaryImageUrl,
            variant.options ?? []
          ]
        );

        results.variants++;
      } catch (error) {
        results.errors.push(`Variant ${variant.blank_sku}: ${error}`);
      }
    }

    // Insert option types
    for (const optionType of sampleData.option_types) {
      try {
        await executeCql(`INSERT INTO option_types (name, description) VALUES (?, ?)`, [
          optionType.name,
          optionType.description
        ]);
        results.option_types++;
      } catch (error) {
        results.errors.push(`OptionType ${optionType.name}: ${error}`);
      }
    }

    // Insert option values
    for (const optionValue of sampleData.option_values) {
      try {
        await executeCql(
          `INSERT INTO option_values_by_type (option_type, label, attributes) VALUES (?, ?, ?)`,
          [optionValue.option_type, optionValue.label, optionValue.attributes]
        );
        results.option_values++;
      } catch (error) {
        results.errors.push(`OptionValue ${optionValue.option_type}/${optionValue.label}: ${error}`);
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Sample data loaded successfully',
      results
    });
  } catch (error) {
    console.error('Failed to seed database:', error);
    return NextResponse.json(
      { success: false, error: `Failed to seed database: ${error}`, results },
      { status: 500 }
    );
  }
}
