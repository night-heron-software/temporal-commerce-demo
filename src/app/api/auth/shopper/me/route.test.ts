/**
 * Tests for GET /api/auth/shopper/me — cookie store, Cassandra, and the address
 * repository are mocked at module boundaries.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const cookieStore = await vi.hoisted(async () => {
  const { createCookieStoreMock } = await import('../../../../../test-support/next-route');
  return createCookieStoreMock();
});
const db = vi.hoisted(() => ({ executeCql: vi.fn() }));
const repos = vi.hoisted(() => ({ getByUserId: vi.fn() }));

vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));
vi.mock('@/lib/cassandra-client', () => ({ executeCql: db.executeCql }));
vi.mock('@/temporal/identity', () => ({
  AddressRepository: class {
    getByUserId = repos.getByUserId;
  },
}));

import { GET } from './route';

describe('GET /api/auth/shopper/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieStore.reset();
    db.executeCql.mockResolvedValue([]);
    repos.getByUserId.mockResolvedValue([]);
  });

  it('returns a null shopper when no session cookie is set', async () => {
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ shopper: null, savedAddress: null });
    expect(db.executeCql).not.toHaveBeenCalled();
  });

  it('clears a stale cookie when the shopper row no longer exists', async () => {
    cookieStore.set('shopperId', 'ghost');

    const res = await GET();
    const body = await res.json();

    expect(body).toEqual({ shopper: null, savedAddress: null });
    expect(cookieStore.deleted).toContain('shopperId');
  });

  it('returns the shopper and default address for a valid session', async () => {
    cookieStore.set('shopperId', 'shopper-1');
    db.executeCql.mockResolvedValue([
      { id: { toString: () => 'shopper-1' }, email: 'ada@example.com', name: 'Ada' },
    ]);
    repos.getByUserId.mockResolvedValue([
      { addressId: 'a1', isDefault: false },
      { addressId: 'a2', isDefault: true },
    ]);

    const res = await GET();
    const body = await res.json();

    expect(body.shopper).toEqual({ id: 'shopper-1', email: 'ada@example.com', name: 'Ada' });
    expect(body.savedAddress).toMatchObject({ addressId: 'a2', isDefault: true });
  });
});
