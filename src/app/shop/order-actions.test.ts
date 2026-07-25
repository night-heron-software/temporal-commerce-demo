/**
 * Unit tests for shop order Server Actions: the orders_by_customer lookup with email
 * normalization, per-order shipping-address enrichment (tolerant of failures),
 * nullable-column defaults, and the outer error envelope. Cassandra is mocked at
 * the lib boundary.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const executeCql = vi.hoisted(() => vi.fn());

vi.mock('@/lib', () => ({ executeCql }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getOrdersByEmail } from './order-actions';

const CUSTOMER_ROW = {
  order_id: 'order-1',
  confirmation_number: 'CN-1',
  total: 42,
  currency: 'USD',
  status: 'confirmed',
  created_at: new Date('2026-07-20T00:00:00Z'),
};

const DB_ADDRESS = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  address1: '1 Analytical Way',
  address2: null,
  city: 'London',
  state: 'LDN',
  postal_code: 'E1 6AN',
  country: 'GB',
  phone: null,
  email: 'ada@example.com',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOrdersByEmail', () => {
  it('queries orders_by_customer with the normalized email and enriches the address', async () => {
    executeCql.mockImplementation(async (cql: string) => {
      if (cql.includes('orders_by_customer')) return [CUSTOMER_ROW];
      return [{ shipping_address: DB_ADDRESS }];
    });

    const result = await getOrdersByEmail('  Ada@Example.COM ');

    expect(executeCql).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('FROM orders_by_customer'),
      ['ada@example.com'],
    );
    expect(executeCql).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SELECT shipping_address FROM orders'),
      ['order-1'],
    );
    expect(result).toEqual({
      success: true,
      data: [
        {
          orderId: 'order-1',
          confirmationNumber: 'CN-1',
          total: 42,
          currency: 'USD',
          status: 'confirmed',
          createdAt: '2026-07-20T00:00:00.000Z',
          shippingAddress: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            address1: '1 Analytical Way',
            address2: undefined, // null column → undefined
            city: 'London',
            state: 'LDN',
            postalCode: 'E1 6AN',
            country: 'GB',
            phone: undefined,
            email: 'ada@example.com',
          },
        },
      ],
    });
  });

  it('omits the shipping address when the orders row has none', async () => {
    executeCql.mockImplementation(async (cql: string) => {
      if (cql.includes('orders_by_customer')) return [CUSTOMER_ROW];
      return [{ shipping_address: null }];
    });

    const result = await getOrdersByEmail('ada@example.com');

    expect(result.success).toBe(true);
    expect(result.data[0].shippingAddress).toBeUndefined();
  });

  it('still returns the order when the address enrichment query fails', async () => {
    executeCql.mockImplementation(async (cql: string) => {
      if (cql.includes('orders_by_customer')) return [CUSTOMER_ROW];
      throw new Error('orders table read failed');
    });

    const result = await getOrdersByEmail('ada@example.com');

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ orderId: 'order-1', shippingAddress: undefined });
  });

  it('applies display defaults for nullable columns', async () => {
    executeCql.mockImplementation(async (cql: string) => {
      if (cql.includes('orders_by_customer')) {
        return [
          {
            ...CUSTOMER_ROW,
            total: null,
            currency: null,
            status: null,
            created_at: null,
          },
        ];
      }
      return [];
    });

    const result = await getOrdersByEmail('ada@example.com');

    expect(result.data[0]).toMatchObject({
      total: 0,
      currency: 'USD',
      status: 'unknown',
      shippingAddress: undefined,
    });
    expect(typeof result.data[0].createdAt).toBe('string');
  });

  it('returns a failure envelope when the customer lookup itself fails', async () => {
    executeCql.mockRejectedValue(new Error('keyspace unavailable'));

    const result = await getOrdersByEmail('ada@example.com');

    expect(result).toEqual({
      success: false,
      data: [],
      error: 'Failed to load orders: keyspace unavailable',
    });
  });
});
