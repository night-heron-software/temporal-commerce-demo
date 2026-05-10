/**
 * POST /api/dev/reindex
 * Reindex Cassandra data into Elasticsearch.
 * Body: { index: 'products' | 'collections' | 'orders' | 'customers' | 'suppliers' | 'inventory' | 'supplier_orders' | 'carts' | 'fulfillments' | 'reservations' | 'shipments' | 'all' }
 */
import { NextRequest, NextResponse } from 'next/server';
import { executeCql, executeCqlAll } from '@/lib';
import { getElasticsearchClient } from '@/lib/es-client';
import { INDEX_MAPPINGS } from '@/lib/es-index-mappings';

/** Cassandra UUID columns have a toString() method */
type CqlUuid = { toString(): string };

const VALID_INDICES = Object.keys(INDEX_MAPPINGS);

export async function POST(request: NextRequest) {
  try {
    const { index } = await request.json() as { index: string };

    if (index !== 'all' && !VALID_INDICES.includes(index)) {
      return NextResponse.json({ error: `Unknown index: ${index}. Valid: ${VALID_INDICES.join(', ')}, all` }, { status: 400 });
    }

    const indicesToReindex = index === 'all' ? VALID_INDICES : [index];
    const esClient = getElasticsearchClient();
    const results: Record<string, { indexed: number; errors: string[] }> = {};

    for (const idx of indicesToReindex) {
      const result = { indexed: 0, errors: [] as string[] };
      results[idx] = result;

      // Delete and recreate index
      try {
        await esClient.indices.delete({ index: idx });
      } catch {
        // Index may not exist
      }

      await esClient.indices.create({
        index: idx,
        mappings: INDEX_MAPPINGS[idx]
      });

      try {
        switch (idx) {
          case 'products':
            result.indexed = await reindexProducts(esClient, result.errors);
            break;
          case 'collections':
            result.indexed = await reindexCollections(esClient, result.errors);
            break;
          case 'orders':
            result.indexed = await reindexOrders(esClient, result.errors);
            break;
          case 'customers':
            result.indexed = await reindexCustomers(esClient, result.errors);
            break;
          case 'suppliers':
            result.indexed = await reindexSuppliers(esClient, result.errors);
            break;
          case 'inventory':
            result.indexed = await reindexInventory(esClient, result.errors);
            break;
          case 'supplier_orders':
            // Supplier orders are embedded in orders — reindex from the orders table
            result.indexed = await reindexSupplierOrders(esClient, result.errors);
            break;
          case 'carts':
            // Carts are ephemeral Temporal workflow state — no Cassandra source to reindex from
            // They are projected live by cart activities
            break;
          case 'reservations':
            result.indexed = await reindexReservations(esClient, result.errors);
            break;
          case 'fulfillments':
            // Fulfillments are ephemeral Temporal workflow state — no Cassandra source
            break;
          case 'shipments':
            // Shipments are ephemeral — projected live by fulfillment activities
            break;
        }
      } catch (err) {
        result.errors.push(`Fatal: ${String(err)}`);
      }

      await esClient.indices.refresh({ index: idx });
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error('Reindex failed:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

// ─── Reindex Functions ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EsClient = any;

async function reindexProducts(esClient: EsClient, errors: string[]): Promise<number> {
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
  const variantRows = await executeCqlAll<VariantRow>('SELECT * FROM variants');

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

  let indexed = 0;
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
  return indexed;
}

async function reindexCollections(esClient: EsClient, errors: string[]): Promise<number> {
  interface CollectionRow {
    id: CqlUuid;
    name: string;
  }

  const rows = await executeCql<CollectionRow>('SELECT * FROM collections');
  let indexed = 0;
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
  return indexed;
}

async function reindexOrders(esClient: EsClient, errors: string[]): Promise<number> {
  interface OrderRow {
    order_id: CqlUuid;
    cart_id: string;
    confirmation_number: string;
    customer_email: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: any[] | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assignments: any[] | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supplier_orders: any[] | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    shipping_address: any | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payment_method: any | null;
    subtotal: number;
    shipping_cost: number;
    tax: number;
    total_discounts: number;
    total: number;
    currency: string;
    status: string;
    created_at: Date | null;
    updated_at: Date | null;
  }

  const rows = await executeCql<OrderRow>('SELECT * FROM orders');
  let indexed = 0;
  for (const row of rows) {
    try {
      const orderId = row.order_id.toString();
      const items = (row.items ?? []).map((i: { line_item_id: string; variant_id: string; quantity: number; price: number }) => ({
        lineItemId: i.line_item_id,
        variantId: i.variant_id,
        quantity: i.quantity,
        price: i.price
      }));

      const doc = {
        orderId,
        cartId: row.cart_id,
        confirmationNumber: row.confirmation_number,
        customerEmail: row.customer_email,
        customerName: row.shipping_address ? `${row.shipping_address.first_name} ${row.shipping_address.last_name}` : '',
        status: row.status,
        subtotal: row.subtotal,
        shippingCost: row.shipping_cost,
        tax: row.tax,
        totalDiscounts: row.total_discounts,
        total: row.total,
        currency: row.currency,
        shippingAddress: row.shipping_address ? {
          firstName: row.shipping_address.first_name,
          lastName: row.shipping_address.last_name,
          address1: row.shipping_address.address1,
          address2: row.shipping_address.address2,
          city: row.shipping_address.city,
          state: row.shipping_address.state,
          postalCode: row.shipping_address.postal_code,
          country: row.shipping_address.country,
          phone: row.shipping_address.phone,
          email: row.shipping_address.email
        } : undefined,
        paymentMethod: row.payment_method ? {
          type: row.payment_method.type,
          last4: row.payment_method.last4
        } : undefined,
        items,
        itemCount: items.length,
        variantIds: items.map((i: { variantId: string }) => i.variantId),
        assignments: (row.assignments ?? []).map((a: { assignment_id: string; line_item_id: string; variant_id: string; supplier_id: string; supplier_name: string; quantity: number; status: string; supplier_order_id: string; carrier: string }) => ({
          assignmentId: a.assignment_id,
          lineItemId: a.line_item_id,
          variantId: a.variant_id,
          supplierId: a.supplier_id,
          supplierName: a.supplier_name,
          quantity: a.quantity,
          status: a.status,
          supplierOrderId: a.supplier_order_id,
          carrier: a.carrier
        })),
        supplierOrders: (row.supplier_orders ?? []).map((so: { supplier_order_id: string; supplier_id: string; supplier_name: string; status: string; items: { assignment_id: string; variant_id: string; quantity: number }[]; carrier: string; tracking_number: string; rejection_reason: string; created_at: Date; updated_at: Date }) => ({
          supplierOrderId: so.supplier_order_id,
          supplierId: so.supplier_id,
          supplierName: so.supplier_name,
          status: so.status,
          itemCount: (so.items ?? []).length,
          carrier: so.carrier,
          trackingNumber: so.tracking_number,
          rejectionReason: so.rejection_reason,
          createdAt: so.created_at ? new Date(so.created_at).toISOString() : undefined,
          updatedAt: so.updated_at ? new Date(so.updated_at).toISOString() : undefined
        })),
        statusHistory: [],
        createdAt: row.created_at?.toISOString(),
        updatedAt: row.updated_at?.toISOString()
      };

      await esClient.index({ index: 'orders', id: orderId, document: doc });
      indexed++;
    } catch (err) {
      errors.push(`Order ${row.order_id}: ${err}`);
    }
  }
  return indexed;
}

async function reindexCustomers(esClient: EsClient, errors: string[]): Promise<number> {
  interface CustomerRow {
    customer_email: string;
    created_at: Date;
    order_id: CqlUuid;
    total: number;
    currency: string;
    status: string;
  }

  // Aggregate from orders_by_customer
  const rows = await executeCql<CustomerRow>('SELECT * FROM orders_by_customer');

  // Group by email
  const customers = new Map<string, { totalSpent: number; orderCount: number; lastOrderAt: string }>();
  for (const row of rows) {
    const existing = customers.get(row.customer_email);
    if (existing) {
      existing.totalSpent += row.total ?? 0;
      existing.orderCount++;
      if (row.created_at && row.created_at.toISOString() > existing.lastOrderAt) {
        existing.lastOrderAt = row.created_at.toISOString();
      }
    } else {
      customers.set(row.customer_email, {
        totalSpent: row.total ?? 0,
        orderCount: 1,
        lastOrderAt: row.created_at?.toISOString() ?? new Date().toISOString()
      });
    }
  }

  let indexed = 0;
  for (const [email, data] of customers) {
    try {
      const doc = {
        email,
        firstName: '',
        lastName: '',
        totalSpent: data.totalSpent,
        orderCount: data.orderCount,
        lastOrderAt: data.lastOrderAt
      };
      await esClient.index({ index: 'customers', id: email, document: doc });
      indexed++;
    } catch (err) {
      errors.push(`Customer ${email}: ${err}`);
    }
  }
  return indexed;
}

async function reindexSuppliers(esClient: EsClient, errors: string[]): Promise<number> {
  interface SupplierRow {
    id: string;
    name: string;
  }

  interface SupplierLocationRow {
    supplier_id: string;
    location_id: string;
    name: string;
    cost: number;
    address1: string;
    address2: string | null;
    city: string;
    state: string;
    postal_code: string;
    country: string;
    is_primary: boolean;
  }

  const supplierRows = await executeCql<SupplierRow>('SELECT * FROM suppliers');
  const locationRows = await executeCql<SupplierLocationRow>('SELECT * FROM supplier_locations');

  // Group locations by supplier
  const locationsBySupplier = new Map<string, SupplierLocationRow[]>();
  for (const loc of locationRows) {
    if (!locationsBySupplier.has(loc.supplier_id)) locationsBySupplier.set(loc.supplier_id, []);
    locationsBySupplier.get(loc.supplier_id)!.push(loc);
  }

  let indexed = 0;
  for (const row of supplierRows) {
    try {
      const doc = {
        supplierId: row.id,
        name: row.name,
        locations: (locationsBySupplier.get(row.id) ?? []).map(loc => ({
          locationId: loc.location_id,
          name: loc.name,
          cost: loc.cost,
          address1: loc.address1,
          address2: loc.address2,
          city: loc.city,
          state: loc.state,
          postalCode: loc.postal_code,
          country: loc.country,
          isPrimary: loc.is_primary
        }))
      };
      await esClient.index({ index: 'suppliers', id: row.id, document: doc });
      indexed++;
    } catch (err) {
      errors.push(`Supplier ${row.id}: ${err}`);
    }
  }
  return indexed;
}

async function reindexInventory(esClient: EsClient, errors: string[]): Promise<number> {
  interface StockRow {
    blank_sku: string;
    supplier_id: string;
    supplier_name: string;
    total_stock: number;
    reserved_stock: number;
    ordered_stock: number;
  }

  const rows = await executeCql<StockRow>('SELECT * FROM inventory_stock_w');

  // Group by blank_sku
  const inventoryByBlankSku = new Map<string, StockRow[]>();
  for (const row of rows) {
    if (!inventoryByBlankSku.has(row.blank_sku)) inventoryByBlankSku.set(row.blank_sku, []);
    inventoryByBlankSku.get(row.blank_sku)!.push(row);
  }

  let indexed = 0;
  for (const [blankSku, suppliers] of inventoryByBlankSku) {
    try {
      const totalStock = suppliers.reduce((sum, s) => sum + (s.total_stock ?? 0), 0);
      const reservedStock = suppliers.reduce((sum, s) => sum + (s.reserved_stock ?? 0), 0);

      const doc = {
        variantId: blankSku,
        totalStock,
        reservedStock,
        availableStock: totalStock - reservedStock,
        supplierCount: suppliers.length,
        supplierLocations: suppliers.map(s => ({
          supplierId: s.supplier_id,
          supplierName: s.supplier_name,
          totalStock: s.total_stock,
          reservedStock: s.reserved_stock,
          orderedStock: s.ordered_stock ?? 0,
          city: '',
          state: '',
          country: '',
          reservations: []
        })),
        reservations: [],
        reservationIds: [],
        cartIds: []
      };
      await esClient.index({ index: 'inventory', id: blankSku, document: doc });
      indexed++;
    } catch (err) {
      errors.push(`Inventory ${blankSku}: ${err}`);
    }
  }
  return indexed;
}

async function reindexSupplierOrders(esClient: EsClient, errors: string[]): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface OrderRow {
    order_id: CqlUuid;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supplier_orders: any[] | null;
  }

  const rows = await executeCql<OrderRow>('SELECT order_id, supplier_orders FROM orders');
  let indexed = 0;

  for (const row of rows) {
    const orderId = row.order_id.toString();
    for (const so of row.supplier_orders ?? []) {
      try {
        const doc = {
          supplierOrderId: so.supplier_order_id,
          orderId,
          supplierId: so.supplier_id,
          supplierName: so.supplier_name,
          status: so.status,
          items: (so.items ?? []).map((i: { assignment_id: string; variant_id: string; quantity: number }) => ({
            assignmentId: i.assignment_id,
            variantId: i.variant_id,
            quantity: i.quantity
          })),
          itemCount: (so.items ?? []).length,
          carrier: so.carrier,
          trackingNumber: so.tracking_number,
          createdAt: so.created_at ? new Date(so.created_at).toISOString() : undefined,
          updatedAt: so.updated_at ? new Date(so.updated_at).toISOString() : undefined,
          rejectionReason: so.rejection_reason,
          statusHistory: (so.status_history ?? []).map((h: { status: string; timestamp: Date; note: string }) => ({
            status: h.status,
            timestamp: h.timestamp ? new Date(h.timestamp).toISOString() : undefined,
            note: h.note
          }))
        };
        await esClient.index({ index: 'supplier_orders', id: so.supplier_order_id, document: doc });
        indexed++;
      } catch (err) {
        errors.push(`SupplierOrder ${so.supplier_order_id}: ${err}`);
      }
    }
  }
  return indexed;
}

async function reindexReservations(esClient: EsClient, errors: string[]): Promise<number> {
  interface ReservationRow {
    reservation_id: string;
    blank_sku: string;
    cart_id: string;
    variant_id: string;
    quantity: number;
    status: string;
    expires_at: Date | null;
    created_at: Date | null;
  }

  const rows = await executeCql<ReservationRow>('SELECT * FROM inventory_reservations_w');
  let indexed = 0;

  for (const row of rows) {
    try {
      const doc = {
        reservationId: row.reservation_id,
        cartId: row.cart_id,
        variantId: row.variant_id ?? row.blank_sku,
        quantity: row.quantity,
        status: row.status,
        expiresAt: row.expires_at?.toISOString(),
        createdAt: row.created_at?.toISOString()
      };
      await esClient.index({ index: 'reservations', id: row.reservation_id, document: doc });
      indexed++;
    } catch (err) {
      errors.push(`Reservation ${row.reservation_id}: ${err}`);
    }
  }
  return indexed;
}
