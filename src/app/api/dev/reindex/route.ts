/**
 * POST /api/dev/reindex
 * Reindex Cassandra data into Elasticsearch.
 * Body: { index: 'products' | 'collections' | 'orders' | 'customers' | 'fulfillers' | 'inventory' | 'fulfiller_orders' | 'carts' | 'fulfillments' | 'reservations' | 'shipments' | 'communications' | 'all' }
 */
import { NextRequest, NextResponse } from 'next/server';
import { createErrorResponse } from '@/lib/api-utils';
import { executeCql, executeCqlAll } from '@/lib';
import { getElasticsearchClient } from '@/lib/es-client';
import { INDEX_MAPPINGS, NEVER_REINDEX, REINDEXABLE_INDICES } from '@/lib/es-index-mappings';
import { deriveLifecycleFromStatus } from '@/temporal/contracts/elasticsearch';

/** Cassandra UUID columns have a toString() method */
type CqlUuid = { toString(): string };

const VALID_INDICES = REINDEXABLE_INDICES;

export async function POST(request: NextRequest) {
  try {
    const { index } = (await request.json()) as { index: string };

    if (NEVER_REINDEX.has(index)) {
      return createErrorResponse(
        400,
        `${index} has no Cassandra source and is never reindexed — doing so would delete the only copy of the data.`,
      );
    }

    if (index !== 'all' && !VALID_INDICES.includes(index)) {
      return createErrorResponse(
        400,
        `Unknown index: ${index}. Valid: ${VALID_INDICES.join(', ')}, all`,
      );
    }

    const indicesToReindex = index === 'all' ? VALID_INDICES : [index];
    const esClient = getElasticsearchClient();
    const results: Record<string, { indexed: number; errors: string[] }> = {};

    for (const idx of indicesToReindex) {
      const result = { indexed: 0, errors: [] as string[] };
      results[idx] = result;

      // Delete and recreate index
      try {
        const exists = await esClient.indices.exists({ index: idx });
        if (exists) {
          await esClient.indices.delete({ index: idx });
        }
      } catch (err) {
        console.warn(`[dev/reindex] Delete index '${idx}' failed, attempting putMapping fallback:`, err);
      }

      try {
        await esClient.indices.create({
          index: idx,
          mappings: INDEX_MAPPINGS[idx],
        });
      } catch (createErr) {
        const errStr = String(createErr);
        if (errStr.includes('resource_already_exists_exception') || errStr.includes('already exists')) {
          console.log(`[dev/reindex] Index '${idx}' already exists, refreshing mapping`);
          await esClient.indices.putMapping({
            index: idx,
            ...INDEX_MAPPINGS[idx],
          });
        } else {
          throw createErr;
        }
      }

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
          case 'fulfillers':
            result.indexed = await reindexFulfillers(esClient, result.errors);
            break;
          case 'inventory':
            result.indexed = await reindexInventory(esClient, result.errors);
            break;
          case 'fulfiller_orders':
            // Fulfiller orders are embedded in orders — reindex from the orders table
            result.indexed = await reindexFulfillerOrders(esClient, result.errors);
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
          case 'communications':
            result.indexed = await reindexCommunications(esClient, result.errors);
            break;
        }
      } catch (err) {
        result.errors.push(`Fatal: ${String(err)}`);
      }

      await esClient.indices.refresh({ index: idx });
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    return createErrorResponse(500, 'Reindex failed', error);
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
        value: { label: o.label, hex: o.attributes?.hex },
      })),
      frontImageUrl:
        (v.images as Record<string, string> | null)?.['front'] ??
        (v.images as Record<string, string> | null)?.['back'] ??
        Object.values((v.images as Record<string, string> | null) ?? {})[0] ??
        null,
      images: v.images ?? {},
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
        collectionIds: row.collection_ids?.map((id) => id.toString()),
        collectionNames: row.collection_names,
        defaultVariantId: row.default_variant_id?.toString(),
        defaultVariantImageUrl: row.default_variant_image_url,
        variants: variantsByProduct.get(productId) ?? [],
        createdAt: row.created_at?.toISOString(),
        updatedAt: row.updated_at?.toISOString(),
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
        productCount: 0,
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
    correlation_id: string | null;
    confirmation_number: string;
    customer_email: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: any[] | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assignments: any[] | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fulfiller_orders: any[] | null;
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

  // Join the nested communication summaries from the source table, mirroring the live
  // indexOrder enrichment. Guarded: a missing/failed communications read degrades to
  // summary-less order docs instead of failing the whole rebuild.
  const commsByOrder = new Map<
    string,
    { commType?: string; subject: string; sentAt?: string; recipient: string }[]
  >();
  try {
    interface CommRow {
      order_id: CqlUuid;
      sent_at: Date | null;
      comm_type: string | null;
      recipient: string;
      subject: string;
    }
    const commRows = await executeCql<CommRow>(
      'SELECT order_id, sent_at, comm_type, recipient, subject FROM customer_communications',
    );
    for (const c of commRows) {
      const key = c.order_id.toString();
      if (!commsByOrder.has(key)) commsByOrder.set(key, []);
      commsByOrder.get(key)!.push({
        commType: c.comm_type ?? undefined,
        subject: c.subject,
        sentAt: c.sent_at ? new Date(c.sent_at).toISOString() : undefined,
        recipient: c.recipient,
      });
    }
  } catch (err) {
    errors.push(`communications join: ${err}`);
  }

  let indexed = 0;
  for (const row of rows) {
    try {
      const orderId = row.order_id.toString();
      const items = (row.items ?? []).map(
        (i: { line_item_id: string; variant_id: string; quantity: number; price: number }) => ({
          lineItemId: i.line_item_id,
          variantId: i.variant_id,
          quantity: i.quantity,
          price: i.price,
        }),
      );

      const doc = {
        orderId,
        cartId: row.cart_id,
        // Journey correlationId (ADR-0011); legacy rows predate the column → fall back
        // to the cart linkage (correlationId used to equal cartId).
        correlationId: row.correlation_id ?? row.cart_id,
        confirmationNumber: row.confirmation_number,
        customerEmail: row.customer_email,
        customerName: row.shipping_address
          ? `${row.shipping_address.first_name} ${row.shipping_address.last_name}`
          : '',
        status: row.status,
        subtotal: row.subtotal,
        shippingCost: row.shipping_cost,
        tax: row.tax,
        totalDiscounts: row.total_discounts,
        total: row.total,
        currency: row.currency,
        shippingAddress: row.shipping_address
          ? {
              firstName: row.shipping_address.first_name,
              lastName: row.shipping_address.last_name,
              address1: row.shipping_address.address1,
              address2: row.shipping_address.address2,
              city: row.shipping_address.city,
              state: row.shipping_address.state,
              postalCode: row.shipping_address.postal_code,
              country: row.shipping_address.country,
              phone: row.shipping_address.phone,
              email: row.shipping_address.email,
            }
          : undefined,
        paymentMethod: row.payment_method
          ? {
              type: row.payment_method.type,
              last4: row.payment_method.last4,
            }
          : undefined,
        items,
        itemCount: items.length,
        variantIds: items.map((i: { variantId: string }) => i.variantId),
        assignments: (row.assignments ?? []).map(
          (a: {
            assignment_id: string;
            line_item_id: string;
            variant_id: string;
            fulfiller_id: string;
            fulfiller_name: string;
            quantity: number;
            status: string;
            fulfiller_order_id: string;
            carrier: string;
          }) => ({
            assignmentId: a.assignment_id,
            lineItemId: a.line_item_id,
            variantId: a.variant_id,
            fulfillerId: a.fulfiller_id,
            fulfillerName: a.fulfiller_name,
            quantity: a.quantity,
            status: a.status,
            fulfillerOrderId: a.fulfiller_order_id,
            carrier: a.carrier,
          }),
        ),
        fulfillerOrders: (row.fulfiller_orders ?? []).map(
          (so: {
            fulfiller_order_id: string;
            fulfiller_id: string;
            fulfiller_name: string;
            status: string;
            items: { assignment_id: string; variant_id: string; quantity: number }[];
            carrier: string;
            tracking_number: string;
            rejection_reason: string;
            created_at: Date;
            updated_at: Date;
          }) => ({
            fulfillerOrderId: so.fulfiller_order_id,
            fulfillerId: so.fulfiller_id,
            fulfillerName: so.fulfiller_name,
            status: so.status,
            itemCount: (so.items ?? []).length,
            carrier: so.carrier,
            trackingNumber: so.tracking_number,
            rejectionReason: so.rejection_reason,
            createdAt: so.created_at ? new Date(so.created_at).toISOString() : undefined,
            updatedAt: so.updated_at ? new Date(so.updated_at).toISOString() : undefined,
          }),
        ),
        statusHistory: [],
        communications: commsByOrder.get(orderId) ?? [],
        createdAt: row.created_at?.toISOString(),
        updatedAt: row.updated_at?.toISOString(),
        ...deriveLifecycleFromStatus('orders', row.status, row.updated_at?.toISOString()),
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
  const customers = new Map<
    string,
    { totalSpent: number; orderCount: number; lastOrderAt: string }
  >();
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
        lastOrderAt: row.created_at?.toISOString() ?? new Date().toISOString(),
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
        lastOrderAt: data.lastOrderAt,
      };
      await esClient.index({ index: 'customers', id: email, document: doc });
      indexed++;
    } catch (err) {
      errors.push(`Customer ${email}: ${err}`);
    }
  }
  return indexed;
}

async function reindexFulfillers(esClient: EsClient, errors: string[]): Promise<number> {
  interface FulfillerRow {
    id: string;
    name: string;
  }

  interface FulfillerLocationRow {
    fulfiller_id: string;
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

  const fulfillerRows = await executeCql<FulfillerRow>('SELECT * FROM fulfillers');
  const locationRows = await executeCql<FulfillerLocationRow>('SELECT * FROM fulfiller_locations');

  // Group locations by fulfiller
  const locationsByFulfiller = new Map<string, FulfillerLocationRow[]>();
  for (const loc of locationRows) {
    if (!locationsByFulfiller.has(loc.fulfiller_id)) locationsByFulfiller.set(loc.fulfiller_id, []);
    locationsByFulfiller.get(loc.fulfiller_id)!.push(loc);
  }

  let indexed = 0;
  for (const row of fulfillerRows) {
    try {
      const doc = {
        fulfillerId: row.id,
        name: row.name,
        locations: (locationsByFulfiller.get(row.id) ?? []).map((loc) => ({
          locationId: loc.location_id,
          name: loc.name,
          cost: loc.cost,
          address1: loc.address1,
          address2: loc.address2,
          city: loc.city,
          state: loc.state,
          postalCode: loc.postal_code,
          country: loc.country,
          isPrimary: loc.is_primary,
        })),
      };
      await esClient.index({ index: 'fulfillers', id: row.id, document: doc });
      indexed++;
    } catch (err) {
      errors.push(`Fulfiller ${row.id}: ${err}`);
    }
  }
  return indexed;
}

async function reindexInventory(esClient: EsClient, errors: string[]): Promise<number> {
  interface StockRow {
    blank_sku: string;
    fulfiller_id: string;
    fulfiller_name: string;
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
  for (const [blankSku, fulfillers] of inventoryByBlankSku) {
    try {
      const totalStock = fulfillers.reduce((sum, s) => sum + (s.total_stock ?? 0), 0);
      const reservedStock = fulfillers.reduce((sum, s) => sum + (s.reserved_stock ?? 0), 0);

      const doc = {
        variantId: blankSku,
        totalStock,
        reservedStock,
        availableStock: totalStock - reservedStock,
        fulfillerCount: fulfillers.length,
        fulfillerLocations: fulfillers.map((s) => ({
          fulfillerId: s.fulfiller_id,
          fulfillerName: s.fulfiller_name,
          totalStock: s.total_stock,
          reservedStock: s.reserved_stock,
          orderedStock: s.ordered_stock ?? 0,
          city: '',
          state: '',
          country: '',
          reservations: [],
        })),
        reservations: [],
        reservationIds: [],
        cartIds: [],
      };
      await esClient.index({ index: 'inventory', id: blankSku, document: doc });
      indexed++;
    } catch (err) {
      errors.push(`Inventory ${blankSku}: ${err}`);
    }
  }
  return indexed;
}

async function reindexFulfillerOrders(esClient: EsClient, errors: string[]): Promise<number> {
  interface OrderRow {
    order_id: CqlUuid;
    cart_id: string;
    correlation_id: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fulfiller_orders: any[] | null;
  }

  const rows = await executeCql<OrderRow>(
    'SELECT order_id, cart_id, correlation_id, fulfiller_orders FROM orders',
  );
  let indexed = 0;

  for (const row of rows) {
    const orderId = row.order_id.toString();
    for (const so of row.fulfiller_orders ?? []) {
      try {
        const doc = {
          fulfillerOrderId: so.fulfiller_order_id,
          orderId,
          // Journey correlationId (ADR-0011); fallback cart_id for legacy rows.
          correlationId: row.correlation_id ?? row.cart_id,
          fulfillerId: so.fulfiller_id,
          fulfillerName: so.fulfiller_name,
          status: so.status,
          items: (so.items ?? []).map(
            (i: { assignment_id: string; variant_id: string; quantity: number }) => ({
              assignmentId: i.assignment_id,
              variantId: i.variant_id,
              quantity: i.quantity,
            }),
          ),
          itemCount: (so.items ?? []).length,
          carrier: so.carrier,
          trackingNumber: so.tracking_number,
          createdAt: so.created_at ? new Date(so.created_at).toISOString() : undefined,
          updatedAt: so.updated_at ? new Date(so.updated_at).toISOString() : undefined,
          rejectionReason: so.rejection_reason,
          statusHistory: (so.status_history ?? []).map(
            (h: { status: string; timestamp: Date; note: string }) => ({
              status: h.status,
              timestamp: h.timestamp ? new Date(h.timestamp).toISOString() : undefined,
              note: h.note,
            }),
          ),
          ...deriveLifecycleFromStatus(
            'fulfiller_orders',
            so.status,
            so.updated_at ? new Date(so.updated_at).toISOString() : undefined,
          ),
        };
        await esClient.index({
          index: 'fulfiller_orders',
          id: so.fulfiller_order_id,
          document: doc,
        });
        indexed++;
      } catch (err) {
        errors.push(`FulfillerOrder ${so.fulfiller_order_id}: ${err}`);
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
    correlation_id: string | null;
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
        // Journey key stored on the row since the write-side correlation change;
        // legacy rows predate it, where the correlationId equalled the cartId.
        correlationId: row.correlation_id ?? row.cart_id,
        variantId: row.variant_id ?? row.blank_sku,
        quantity: row.quantity,
        status: row.status,
        expiresAt: row.expires_at?.toISOString(),
        createdAt: row.created_at?.toISOString(),
        ...deriveLifecycleFromStatus('reservations', row.status),
      };
      await esClient.index({ index: 'reservations', id: row.reservation_id, document: doc });
      indexed++;
    } catch (err) {
      errors.push(`Reservation ${row.reservation_id}: ${err}`);
    }
  }
  return indexed;
}

async function reindexCommunications(esClient: EsClient, errors: string[]): Promise<number> {
  interface CommunicationRow {
    order_id: CqlUuid;
    sent_at: Date | null;
    seq: number;
    correlation_id: string | null;
    channel: string | null;
    comm_type: string | null;
    recipient: string;
    subject: string;
    body: string | null;
    actor: string | null;
  }

  const rows = await executeCql<CommunicationRow>('SELECT * FROM customer_communications');
  let indexed = 0;

  for (const row of rows) {
    const orderId = row.order_id.toString();
    try {
      const sentAt = row.sent_at ? new Date(row.sent_at) : new Date(0);
      // Deterministic composite id (orderId:sentAtMs:seq) — matches the live
      // write-through's buildCommunicationId, so rebuilds address the same docs.
      const id = `${orderId}:${sentAt.getTime()}:${row.seq}`;
      const doc = {
        id,
        orderId,
        correlationId: row.correlation_id ?? undefined,
        channel: row.channel ?? 'email',
        commType: row.comm_type ?? undefined,
        recipient: row.recipient,
        subject: row.subject,
        body: row.body ?? undefined,
        sentAt: sentAt.toISOString(),
        actor: row.actor ?? undefined,
      };
      await esClient.index({ index: 'communications', id, document: doc });
      indexed++;
    } catch (err) {
      errors.push(`Communication ${orderId}/${row.seq}: ${err}`);
    }
  }
  return indexed;
}
