/**
 * Unit tests for admin cart Server Actions: ES query composition per status scope,
 * live-workflow enrichment of in-flight carts vs. the ES-doc-is-the-record path for
 * closed workflows, sorting, and error mapping. ES and Temporal clients are mocked
 * at the lib boundary.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const esSearch = vi.hoisted(() => vi.fn());
const getHandle = vi.hoisted(() => vi.fn());

vi.mock('@/lib', () => ({
  getTemporalClient: async () => ({ workflow: { getHandle } }),
}));
vi.mock('@/lib/es-client', () => ({
  getElasticsearchClient: () => ({ search: esSearch }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { searchCarts, getCartDetails } from './admin-cart-actions';
import { Cart } from '@/temporal/contracts';

interface QueryDef {
  name: string;
}

function cartDoc(overrides: Record<string, unknown> = {}) {
  return {
    cartId: 'cart-1',
    correlationId: 'corr-1',
    status: 'completed',
    itemCount: 2,
    totalPrice: 42,
    currency: 'USD',
    userId: 'u-1',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

function esResult(docs: Array<Record<string, unknown> | undefined>) {
  return { hits: { hits: docs.map((doc) => ({ _source: doc })) } };
}

const liveDetails = {
  cartId: 'cart-1',
  status: 'active',
  items: [{ lineItemId: 'li-1' }, { lineItemId: 'li-2' }, { lineItemId: 'li-3' }],
  totalPrice: 99,
  currency: 'USD',
  userId: 'u-1',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-03T00:00:00.000Z',
  checkout: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  esSearch.mockResolvedValue(esResult([]));
});

describe('searchCarts', () => {
  it("composes the ES query for the 'active' scope as an in-flight status terms filter", async () => {
    await searchCarts({ status: 'active' });

    expect(esSearch).toHaveBeenCalledWith({
      index: 'carts',
      size: 200,
      query: { bool: { must: [{ terms: { status: ['active', 'checkout', 'processing'] } }] } },
      sort: [{ updatedAt: 'desc' }],
    });
  });

  it("uses match_all for 'all' with no query string, and adds cartId/email clauses for q", async () => {
    await searchCarts({ status: 'all' });
    expect(esSearch.mock.calls[0][0].query).toEqual({ match_all: {} });

    await searchCarts({ status: 'abandoned', q: '  ada@example.com ' });
    expect(esSearch.mock.calls[1][0].query).toEqual({
      bool: {
        must: [
          { term: { status: 'abandoned' } },
          {
            bool: {
              should: [
                { prefix: { cartId: { value: 'ada@example.com' } } },
                { term: { email: 'ada@example.com' } },
                { prefix: { email: { value: 'ada@example.com' } } },
              ],
              minimum_should_match: 1,
            },
          },
        ],
      },
    });
  });

  it('enriches in-flight carts from the live workflow, keeping the ES correlationId', async () => {
    esSearch.mockResolvedValue(esResult([cartDoc({ status: 'active' })]));
    const query = vi.fn(async (def: QueryDef) =>
      def.name === Cart.getCartQuery.name ? liveDetails : null,
    );
    getHandle.mockReturnValue({ query });

    const result = await searchCarts({ status: 'active' });

    expect(getHandle).toHaveBeenCalledWith('demo.cart.cart-1');
    expect(result).toEqual({
      success: true,
      data: [
        {
          cartId: 'cart-1',
          correlationId: 'corr-1',
          workflowId: 'demo.cart.cart-1',
          status: 'active',
          itemCount: 3, // live item count, not the stale ES itemCount of 2
          totalPrice: 99,
          currency: 'USD',
          userId: 'u-1',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-03T00:00:00.000Z',
          checkout: undefined,
          orderId: undefined,
        },
      ],
    });
  });

  it('also queries the checkout workflow id when the live cart is in checkout', async () => {
    esSearch.mockResolvedValue(esResult([cartDoc({ status: 'checkout' })]));
    const query = vi.fn(async (def: QueryDef) => {
      if (def.name === Cart.getCartQuery.name) {
        return {
          ...liveDetails,
          status: 'checkout',
          checkout: { step: 'payment', order: { orderId: 'o-1' } },
        };
      }
      return 'demo.checkout.ck-1';
    });
    getHandle.mockReturnValue({ query });

    const result = await searchCarts({ status: 'active' });

    expect(query).toHaveBeenCalledWith(Cart.getCheckoutWorkflowIdQuery);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data[0].checkout).toEqual({ step: 'payment', workflowId: 'demo.checkout.ck-1' });
    expect(result.data[0].orderId).toBe('o-1');
  });

  it('uses the ES doc as the record for closed carts and when the workflow query fails', async () => {
    esSearch.mockResolvedValue(
      esResult([
        cartDoc({ cartId: 'closed-1', status: 'completed', updatedAt: '2026-07-05T00:00:00.000Z' }),
        cartDoc({ cartId: 'gone-1', status: 'active', updatedAt: '2026-07-04T00:00:00.000Z' }),
      ]),
    );
    // The only workflow queried is gone-1's (closed-1 is never attempted) — and it is closed.
    getHandle.mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('workflow closed')) });

    const result = await searchCarts({ status: 'all' });

    expect(getHandle).toHaveBeenCalledTimes(1);
    expect(getHandle).toHaveBeenCalledWith('demo.cart.gone-1');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    // Both came from the ES docs, sorted by updatedAt desc.
    expect(result.data.map((c) => c.cartId)).toEqual(['closed-1', 'gone-1']);
    expect(result.data[1]).toMatchObject({ status: 'active', itemCount: 2, totalPrice: 42 });
  });

  it('drops hits without a _source and sorts by updatedAt desc after enrichment', async () => {
    esSearch.mockResolvedValue(
      esResult([
        cartDoc({ cartId: 'a', updatedAt: '2026-07-01T00:00:00.000Z' }),
        undefined,
        cartDoc({ cartId: 'b', updatedAt: '2026-07-09T00:00:00.000Z' }),
      ]),
    );

    const result = await searchCarts({ status: 'all' });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.map((c) => c.cartId)).toEqual(['b', 'a']);
  });

  it('returns a failure result when the ES search throws', async () => {
    esSearch.mockRejectedValue(new Error('es down'));

    const result = await searchCarts({ status: 'all' });

    expect(result).toEqual({ success: false, error: 'Failed to load carts: es down' });
  });
});

describe('getCartDetails', () => {
  it('queries the derived cart workflow id and returns the details', async () => {
    const query = vi.fn().mockResolvedValue(liveDetails);
    getHandle.mockReturnValue({ query });

    const result = await getCartDetails('cart-9');

    expect(getHandle).toHaveBeenCalledWith('demo.cart.cart-9');
    expect(query).toHaveBeenCalledWith(Cart.getCartQuery);
    expect(result).toEqual({ success: true, data: liveDetails });
  });

  it('maps not-found errors to a cart-not-found message', async () => {
    getHandle.mockReturnValue({
      query: vi.fn().mockRejectedValue(new Error('5 NOT_FOUND: workflow execution not found')),
    });

    const result = await getCartDetails('missing');

    expect(result).toEqual({ success: false, error: 'Cart not found: missing' });
  });
});
