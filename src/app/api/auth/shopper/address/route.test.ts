/**
 * Tests for GET/POST /api/auth/shopper/address — cookie store and address repository
 * are mocked at module boundaries.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { jsonRequest } from '../../../../../test-support/next-route';

const cookieStore = await vi.hoisted(async () => {
  const { createCookieStoreMock } = await import('../../../../../test-support/next-route');
  return createCookieStoreMock();
});
const repos = vi.hoisted(() => ({ getByUserId: vi.fn() }));
const temporal = vi.hoisted(() => ({ executeStandaloneActivity: vi.fn() }));

vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));
vi.mock('@/temporal/identity', () => ({
  AddressRepository: class {
    getByUserId = repos.getByUserId;
  },
}));
// The address save is a STANDALONE activity (ADR-0006) executed via the client helper.
vi.mock('@/lib/temporal-client', () => ({
  executeStandaloneActivity: temporal.executeStandaloneActivity,
}));

import { GET, POST } from './route';

const ADDRESS_BODY = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  address1: '1 Analytical Way',
  city: 'London',
  state: 'LDN',
  postalCode: 'E1 6AN',
  email: 'ada@example.com',
};

function postAddress(body: unknown) {
  return POST(jsonRequest('http://localhost/api/auth/shopper/address', body) as never);
}

describe('/api/auth/shopper/address', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieStore.reset();
    repos.getByUserId.mockResolvedValue([]);
    temporal.executeStandaloneActivity.mockResolvedValue(undefined);
  });

  it('GET returns an empty list when not signed in', async () => {
    const res = await GET();
    expect(await res.json()).toEqual({ addresses: [] });
    expect(repos.getByUserId).not.toHaveBeenCalled();
  });

  it('GET returns the saved addresses for the session shopper', async () => {
    cookieStore.set('shopperId', 'shopper-1');
    repos.getByUserId.mockResolvedValue([{ addressId: 'a1' }]);

    const res = await GET();
    expect(await res.json()).toEqual({ addresses: [{ addressId: 'a1' }] });
    expect(repos.getByUserId).toHaveBeenCalledWith('shopper-1');
  });

  it('POST rejects with 401 when not signed in', async () => {
    const res = await postAddress(ADDRESS_BODY);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe('Not signed in');
  });

  it('POST creates a new default address with generated id and defaults applied', async () => {
    cookieStore.set('shopperId', 'shopper-1');

    const res = await postAddress(ADDRESS_BODY);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.address).toMatchObject({
      label: 'Default',
      country: 'US',
      address2: '',
      phone: '',
      isDefault: true,
    });
    expect(body.address.addressId).toBeTypeOf('string');
    expect(temporal.executeStandaloneActivity).toHaveBeenCalledWith(
      'saveShopperAddress',
      expect.objectContaining({
        taskQueue: 'identity-queue',
        args: ['shopper-1', expect.objectContaining(ADDRESS_BODY)],
      }),
    );
  });

  it('POST reuses the existing default addressId instead of generating a new one', async () => {
    cookieStore.set('shopperId', 'shopper-1');
    repos.getByUserId.mockResolvedValue([{ addressId: 'existing-default', isDefault: true }]);

    const res = await postAddress(ADDRESS_BODY);
    const body = await res.json();

    expect(body.address.addressId).toBe('existing-default');
  });
});
