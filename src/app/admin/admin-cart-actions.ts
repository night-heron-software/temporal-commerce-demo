'use server';

/**
 * Admin Cart Actions
 *
 * Server Actions for listing carts. The ES `carts` index (populated live by the cart
 * workflow's indexCart activity) is the search backbone — it covers completed and
 * abandoned carts whose workflows have closed. In-flight carts are enriched with live
 * workflow state via the getCartQuery handle.
 */

import { getTemporalClient } from '@/lib';
import { getElasticsearchClient } from '@/lib/es-client';
import { createLogger } from '@/lib/logger';
import { Cart, Elasticsearch } from '@/temporal/contracts';
import { buildWorkflowId, DEMO_STORE_ID } from '@/temporal/contracts/constants';

const log = createLogger('admin-cart-actions');

export type ActionResult<T> = { success: true; data: T } | { success: false; error: string };

export interface CartSummary {
  cartId: string;
  /** Journey correlationId (ADR-0011) from the ES doc; undefined for legacy docs. */
  correlationId?: string;
  workflowId: string;
  status: string;
  itemCount: number;
  totalPrice: number;
  currency: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
  checkout?: {
    step: string;
    workflowId?: string;
  };
  /** Present once the checkout has placed an order. */
  orderId?: string;
}

export type CartSearchStatus = 'active' | 'completed' | 'abandoned' | 'all';

export interface CartSearchParams {
  status: CartSearchStatus;
  q?: string;
}

/**
 * ES statuses that mean the cart workflow may still be running. The 'active' scope
 * covers all of them ('checkout'/'processing' carts are still in-flight), and only
 * these are worth attempting live-workflow enrichment for.
 */
const IN_FLIGHT_STATUSES = ['active', 'checkout', 'processing'];

/**
 * Query the live cart workflow for fresh state (checkout step, order ID, current
 * totals). Returns null when the workflow can't be queried — closed workflows
 * cannot be queried, so for completed/abandoned carts the ES doc IS the record.
 */
async function enrichFromWorkflow(
  client: Awaited<ReturnType<typeof getTemporalClient>>,
  workflowId: string,
): Promise<CartSummary | null> {
  try {
    const handle = client.workflow.getHandle(workflowId);
    const details: Cart.CartDetails = await handle.query(Cart.getCartQuery);

    // If cart is in checkout, query for the checkout workflow ID
    let checkoutWorkflowId: string | null = null;
    if (details.checkout) {
      try {
        checkoutWorkflowId = await handle.query(Cart.getCheckoutWorkflowIdQuery);
      } catch {
        // Query may not be available — skip
      }
    }

    return {
      cartId: details.cartId,
      workflowId,
      status: details.status,
      itemCount: details.items.length,
      totalPrice: details.totalPrice,
      currency: details.currency,
      userId: details.userId,
      createdAt: details.createdAt,
      updatedAt: details.updatedAt,
      checkout: details.checkout
        ? { step: details.checkout.step, workflowId: checkoutWorkflowId ?? undefined }
        : undefined,
      orderId: details.checkout?.order?.orderId,
    };
  } catch {
    // Workflow closed (or not yet visible) — fall back to the ES document.
    return null;
  }
}

/**
 * Search carts in the ES `carts` index, optionally filtered by status and a query
 * string matching cartId (prefix) or email (exact/prefix). Carts whose indexed
 * status is in-flight are enriched with live workflow state; for closed workflows
 * the ES document is the record (closed workflows can't be queried).
 */
export async function searchCarts({
  status,
  q,
}: CartSearchParams): Promise<ActionResult<CartSummary[]>> {
  try {
    const es = getElasticsearchClient();

    const must: object[] = [];
    if (status === 'active') {
      must.push({ terms: { status: IN_FLIGHT_STATUSES } });
    } else if (status !== 'all') {
      must.push({ term: { status } });
    }
    const query = q?.trim();
    if (query) {
      must.push({
        bool: {
          should: [
            { prefix: { cartId: { value: query } } },
            { term: { email: query } },
            { prefix: { email: { value: query } } },
          ],
          minimum_should_match: 1,
        },
      });
    }

    const result = await es.search<Elasticsearch.CartDocument>({
      index: Elasticsearch.ES_INDICES.carts,
      size: 200,
      query: must.length > 0 ? { bool: { must } } : { match_all: {} },
      sort: [{ updatedAt: 'desc' }],
    });

    const client = await getTemporalClient();
    const carts = (
      await Promise.all(
        result.hits.hits.map(async (hit): Promise<CartSummary | null> => {
          const doc = hit._source;
          if (!doc) return null;
          // ES docs don't carry the workflow ID — derive it (ADR: cartId is the entity ID).
          const workflowId = buildWorkflowId(DEMO_STORE_ID, 'cart', doc.cartId);
          const fromDoc: CartSummary = {
            cartId: doc.cartId,
            correlationId: doc.correlationId,
            workflowId,
            status: doc.status,
            itemCount: doc.itemCount,
            totalPrice: doc.totalPrice,
            currency: doc.currency,
            userId: doc.userId,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
          };
          if (!IN_FLIGHT_STATUSES.includes(doc.status)) return fromDoc;
          // Live-workflow enrichment refreshes cart state, but the correlationId only
          // lives on the ES doc (getCartQuery returns CartDetails, which lacks it).
          const live = await enrichFromWorkflow(client, workflowId);
          return live ? { ...live, correlationId: doc.correlationId } : fromDoc;
        }),
      )
    ).filter((c): c is CartSummary => c !== null);

    // Sort by updatedAt desc (enrichment may have refreshed timestamps)
    carts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return { success: true, data: carts };
  } catch (e) {
    log.error({ status, q, err: e }, 'Failed to search carts');
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error: `Failed to load carts: ${message}` };
  }
}

/**
 * List all active (in-flight) carts. Delegates to the ES-backed search.
 */
export async function getActiveCarts(): Promise<ActionResult<CartSummary[]>> {
  return searchCarts({ status: 'active' });
}

/**
 * Get full cart details for a specific cart.
 */
export async function getCartDetails(cartId: string): Promise<ActionResult<Cart.CartDetails>> {
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(buildWorkflowId(DEMO_STORE_ID, 'cart', cartId));
    const details = await handle.query(Cart.getCartQuery);
    return { success: true, data: details };
  } catch (e) {
    log.error({ cartId, err: e }, 'Failed to get cart details');
    const message = e instanceof Error ? e.message : 'Unknown error';
    const isNotFound = message.includes('not found') || message.includes('NOT_FOUND');
    return {
      success: false,
      error: isNotFound ? `Cart not found: ${cartId}` : `Failed to get cart: ${message}`,
    };
  }
}
