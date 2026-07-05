/**
 * POST /api/seed-inventory
 *
 * Seed inventory stock for every unique blank_sku in the variants table.
 * Uses InventoryCommandRepository.setFulfillerStock() so each write flows
 * through the inventory service workflow (CQRS projections + ES sync).
 */

import { NextResponse } from 'next/server';
import { executeCql, executeCqlAll } from '@/lib';
import { createLogger } from '@/lib/logger';
import { InventoryCommandRepository } from '@/temporal/inventory/db/inventory-command-repository';

const log = createLogger('api-seed-inventory');

const DEFAULT_STOCK = 100;
const FULFILLER_ID = 'default-fulfiller';
const FULFILLER_NAME = 'Default Fulfiller';

interface VariantSkuRow {
  blank_sku: string;
}

export async function POST() {
  try {
    // Get all unique blank_skus from variants — must use executeCqlAll
    // because the catalog can exceed the default 5000-row page size.
    const variants = await executeCqlAll<VariantSkuRow>(`SELECT blank_sku FROM variants`);

    const uniqueSkus = [...new Set(variants.map((v) => v.blank_sku).filter(Boolean))];

    if (uniqueSkus.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'No variants found — run catalog seed first',
        },
        { status: 400 },
      );
    }

    // Get the fulfiller location for default address info
    const locations = await executeCql<{
      address1: string;
      city: string;
      state: string;
      postal_code: string;
      country: string;
      cost: number;
    }>(
      `SELECT address1, city, state, postal_code, country, cost FROM fulfiller_locations
       WHERE fulfiller_id = ? AND location_id = ?`,
      [FULFILLER_ID, 'default-warehouse'],
    );

    const loc = locations[0] ?? {
      address1: '123 Warehouse Ave',
      city: 'Warehouse City',
      state: 'WC',
      postal_code: '00000',
      country: 'US',
      cost: 0,
    };

    // Set stock for each SKU via the command repository.
    // setFulfillerStock writes to inventory_stock_w and signals the
    // inventory-service workflow for CQRS projection + ES sync.
    let seeded = 0;
    for (const blankSku of uniqueSkus) {
      await InventoryCommandRepository.setFulfillerStock(blankSku, {
        fulfillerId: FULFILLER_ID,
        fulfillerName: FULFILLER_NAME,
        totalStock: DEFAULT_STOCK,
        cost: loc.cost,
        address1: loc.address1,
        city: loc.city,
        state: loc.state,
        postalCode: loc.postal_code,
        country: loc.country,
      });
      seeded++;
    }

    return NextResponse.json({
      success: true,
      message: `Seeded inventory stock for ${seeded} unique SKUs via inventory service`,
      results: {
        uniqueSkus: seeded,
        stockPerSku: DEFAULT_STOCK,
        fulfiller: FULFILLER_ID,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'Inventory seed error');
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
