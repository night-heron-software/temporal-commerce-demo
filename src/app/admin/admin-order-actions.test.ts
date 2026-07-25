/**
 * Unit tests for admin order Server Actions: row mapping with legacy-column fallbacks
 * (correlation_id ?? cart_id), Temporal UI deep-link construction, created_at sorting,
 * and the query/update wrappers' error mapping. Cassandra and the Temporal client are
 * mocked at the lib boundary.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const executeCqlAll = vi.hoisted(() => vi.fn());
const getHandle = vi.hoisted(() => vi.fn());

vi.mock('@/lib', () => ({
  getTemporalClient: async () => ({ workflow: { getHandle } }),
  executeCqlAll,
}));
vi.mock('@/lib/temporal-client', () => ({ TEMPORAL_NAMESPACE: 'default' }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getAllOrders, getOrderState, updateOrderStatus, cancelOrder } from './admin-order-actions';
import {
  getOrderStateQuery,
  updateStatusUpdate,
  cancelOrderUpdate,
} from '@/temporal/oms/definitions';

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    order_id: 'order-1',
    confirmation_number: 'CN-1',
    customer_email: 'ada@example.com',
    total: 42,
    currency: 'USD',
    status: 'confirmed',
    created_at: new Date('2026-07-20T00:00:00Z'),
    cart_id: 'cart-1',
    correlation_id: 'corr-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getAllOrders', () => {
  it('sorts by created_at desc and builds the Temporal UI URL from the correlationId', async () => {
    executeCqlAll.mockResolvedValue([
      orderRow({ order_id: 'older', created_at: new Date('2026-07-01T00:00:00Z') }),
      orderRow({ order_id: 'newer', created_at: new Date('2026-07-21T00:00:00Z') }),
    ]);

    const result = await getAllOrders();

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.map((o) => o.orderId)).toEqual(['newer', 'older']);
    expect(result.data[0]).toEqual({
      orderId: 'newer',
      confirmationNumber: 'CN-1',
      customerEmail: 'ada@example.com',
      total: 42,
      currency: 'USD',
      status: 'confirmed',
      createdAt: '2026-07-21T00:00:00.000Z',
      cartId: 'cart-1',
      correlationId: 'corr-1',
      temporalUrl:
        'http://localhost:8233/namespaces/default/workflows?query=' +
        encodeURIComponent('CorrelationId="corr-1"'),
    });
  });

  it('falls back to cart_id as the correlationId for legacy rows, and to null when both are absent', async () => {
    executeCqlAll.mockResolvedValue([
      orderRow({ order_id: 'legacy', correlation_id: null, cart_id: 'cart-legacy' }),
      orderRow({
        order_id: 'orphan',
        correlation_id: null,
        cart_id: null,
        customer_email: null,
        total: null,
        currency: null,
        status: null,
        created_at: null,
      }),
    ]);

    const result = await getAllOrders();

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    const legacy = result.data.find((o) => o.orderId === 'legacy');
    expect(legacy?.correlationId).toBe('cart-legacy');
    expect(legacy?.temporalUrl).toContain(encodeURIComponent('CorrelationId="cart-legacy"'));

    // No correlation known → no deep link; nullable columns get display defaults.
    const orphan = result.data.find((o) => o.orderId === 'orphan');
    expect(orphan).toMatchObject({
      correlationId: null,
      temporalUrl: null,
      customerEmail: '',
      total: 0,
      currency: 'USD',
      status: 'unknown',
    });
    expect(typeof orphan?.createdAt).toBe('string');
  });

  it('returns a failure result when the table scan throws', async () => {
    executeCqlAll.mockRejectedValue(new Error('scan failed'));

    const result = await getAllOrders();

    expect(result).toEqual({ success: false, error: 'Failed to load orders: scan failed' });
  });
});

describe('getOrderState', () => {
  it('queries the derived order workflow id', async () => {
    const state = { orderId: 'o-1', status: 'confirmed' };
    const query = vi.fn().mockResolvedValue(state);
    getHandle.mockReturnValue({ query });

    const result = await getOrderState('o-1');

    expect(getHandle).toHaveBeenCalledWith('demo.order.o-1');
    expect(query).toHaveBeenCalledWith(getOrderStateQuery);
    expect(result).toEqual({ success: true, data: state });
  });

  it('maps not-found errors to an order-not-found message', async () => {
    getHandle.mockReturnValue({
      query: vi.fn().mockRejectedValue(new Error('workflow not found for id')),
    });

    const result = await getOrderState('missing');

    expect(result).toEqual({ success: false, error: 'Order not found: missing' });
  });
});

describe('updateOrderStatus', () => {
  it('executes the updateStatus update with the admin-attributed signal', async () => {
    const state = { orderId: 'o-1', status: 'shipped' };
    const executeUpdate = vi.fn().mockResolvedValue(state);
    getHandle.mockReturnValue({ executeUpdate });

    const result = await updateOrderStatus('o-1', 'shipped' as never, 'left the warehouse');

    expect(getHandle).toHaveBeenCalledWith('demo.order.o-1');
    expect(executeUpdate).toHaveBeenCalledWith(updateStatusUpdate, {
      args: [{ status: 'shipped', note: 'left the warehouse', updatedBy: 'admin' }],
    });
    expect(result).toEqual({ success: true, data: state });
  });
});

describe('cancelOrder', () => {
  it('executes the cancel update and maps failures to an error envelope', async () => {
    const executeUpdate = vi
      .fn()
      .mockResolvedValueOnce({ orderId: 'o-1', status: 'cancelled' })
      .mockRejectedValueOnce(new Error('update rejected'));
    getHandle.mockReturnValue({ executeUpdate });

    const ok = await cancelOrder('o-1', 'customer changed mind');
    expect(executeUpdate).toHaveBeenCalledWith(cancelOrderUpdate, {
      args: [{ reason: 'customer changed mind' }],
    });
    expect(ok).toEqual({ success: true, data: { orderId: 'o-1', status: 'cancelled' } });

    const failed = await cancelOrder('o-1');
    expect(failed).toEqual({ success: false, error: 'Failed to cancel order: update rejected' });
  });
});
