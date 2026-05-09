/**
 * POST /api/seed-inventory
 *
 * Seed inventory_stock_w with stock for every unique blank_sku in the variants table.
 * Uses the default-supplier with a configurable default stock level.
 */

import { NextResponse } from 'next/server';
import { executeCql, executeBatch } from '@/lib';

const DEFAULT_STOCK = 100;
const SUPPLIER_ID = 'default-supplier';
const SUPPLIER_NAME = 'Default Supplier';

interface VariantSkuRow {
  blank_sku: string;
}

export async function POST() {
  try {
    // Get all unique blank_skus from variants
    const variants = await executeCql<VariantSkuRow>(
      `SELECT blank_sku FROM variants`
    );

    const uniqueSkus = [...new Set(variants.map(v => v.blank_sku).filter(Boolean))];

    if (uniqueSkus.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'No variants found — run catalog seed first',
      }, { status: 400 });
    }

    // Get the supplier location for default address info
    const locations = await executeCql<{
      address1: string;
      city: string;
      state: string;
      postal_code: string;
      country: string;
      cost: number;
    }>(
      `SELECT address1, city, state, postal_code, country, cost FROM supplier_locations
       WHERE supplier_id = ? AND location_id = ?`,
      [SUPPLIER_ID, 'default-warehouse']
    );

    const loc = locations[0] ?? {
      address1: '123 Warehouse Ave',
      city: 'Warehouse City',
      state: 'WC',
      postal_code: '00000',
      country: 'US',
      cost: 0,
    };

    // Batch insert stock rows
    const BATCH_SIZE = 20;
    const now = new Date();
    let inserted = 0;

    for (let i = 0; i < uniqueSkus.length; i += BATCH_SIZE) {
      const batch = uniqueSkus.slice(i, i + BATCH_SIZE).map(blankSku => ({
        query: `INSERT INTO inventory_stock_w (
          blank_sku, supplier_id, supplier_name,
          total_stock, reserved_stock, ordered_stock, cost,
          address1, city, state, postal_code, country,
          updated_at
        ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          blankSku, SUPPLIER_ID, SUPPLIER_NAME,
          DEFAULT_STOCK, loc.cost,
          loc.address1, loc.city, loc.state, loc.postal_code, loc.country,
          now,
        ],
      }));

      await executeBatch(batch);
      inserted += batch.length;
    }

    return NextResponse.json({
      success: true,
      message: `Seeded inventory stock for ${inserted} unique SKUs`,
      results: {
        uniqueSkus: inserted,
        stockPerSku: DEFAULT_STOCK,
        supplier: SUPPLIER_ID,
      },
    });
  } catch (error) {
    console.error('Inventory seed error:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
