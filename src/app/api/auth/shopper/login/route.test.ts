/**
 * Tests for POST /api/auth/shopper/login — repositories, the ES client, cart actions, and
 * the request cookie store are all mocked at module boundaries.
 *
 * `@/temporal/identity` is mocked (never importActual'd): the real barrel re-exports the
 * domain worker entrypoint, which cannot load outside a worker process.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { jsonRequest } from '../../../../../test-support/next-route';

// vi.hoisted runs before static imports, so the helper must be imported dynamically here.
const cookieStore = await vi.hoisted(async () => {
  const { createCookieStoreMock } = await import('../../../../../test-support/next-route');
  return createCookieStoreMock();
});
const repos = vi.hoisted(() => ({
  getShopperByEmail: vi.fn(),
  createShopper: vi.fn(),
  getByUserId: vi.fn(),
}));
const es = vi.hoisted(() => ({ search: vi.fn() }));
const cartActions = vi.hoisted(() => ({ executeCartUpdate: vi.fn() }));

vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));
vi.mock('@/temporal/identity', () => ({
  ShopperRepository: class {
    getShopperByEmail = repos.getShopperByEmail;
    createShopper = repos.createShopper;
  },
  AddressRepository: class {
    getByUserId = repos.getByUserId;
  },
}));
vi.mock('@/lib/es-client', () => ({
  getElasticsearchClient: () => ({ search: es.search }),
}));
vi.mock('@/app/shop/cart-actions', () => ({
  executeCartUpdate: cartActions.executeCartUpdate,
}));

import { POST } from './route';

const SHOPPER = { id: 'shopper-1', email: 'ada@example.com', name: 'ada' };

function loginRequest(body: unknown) {
  // NextRequest and Request are interchangeable for this handler's usage.
  return POST(jsonRequest('http://localhost/api/auth/shopper/login', body) as never);
}

describe('POST /api/auth/shopper/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieStore.reset();
    repos.getShopperByEmail.mockResolvedValue(SHOPPER);
    repos.createShopper.mockResolvedValue(undefined);
    repos.getByUserId.mockResolvedValue([]);
    es.search.mockResolvedValue({ hits: { hits: [] } });
  });

  it('rejects a missing email with 400 and a correlationId', async () => {
    const res = await loginRequest({});
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe('Email is required');
    expect(body.correlationId).toBeTypeOf('string');
  });

  it('signs in an existing shopper and sets a 30-day httpOnly session cookie', async () => {
    const res = await loginRequest({ email: 'ada@example.com' });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.shopper).toEqual(SHOPPER);
    expect(body.savedAddress).toBeNull();
    expect(repos.createShopper).not.toHaveBeenCalled();

    expect(cookieStore.get('shopperId')?.value).toBe('shopper-1');
    expect(cookieStore.setOptions.get('shopperId')).toMatchObject({
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60,
    });
  });

  it('normalizes the email before lookup', async () => {
    await loginRequest({ email: '  Ada@Example.COM ' });
    expect(repos.getShopperByEmail).toHaveBeenCalledWith('ada@example.com');
  });

  it('auto-creates an account for an unknown email, deriving the name from the local part', async () => {
    repos.getShopperByEmail.mockResolvedValueOnce(null).mockResolvedValueOnce(SHOPPER);

    const res = await loginRequest({ email: 'ada@example.com' });
    expect(res.status).toBe(200);

    expect(repos.createShopper).toHaveBeenCalledWith({
      id: expect.any(String),
      email: 'ada@example.com',
      passwordHash: 'demo-no-password',
      name: 'ada',
    });
  });

  it('returns 500 when the shopper cannot be found after creation', async () => {
    repos.getShopperByEmail.mockResolvedValue(null);

    const res = await loginRequest({ email: 'ada@example.com' });
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toBe('Failed to create account');
  });

  it('recovers an active cart from ES and overwrites the cartId cookie', async () => {
    cookieStore.set('cartId', 'guest-cart');
    es.search.mockResolvedValue({
      hits: { hits: [{ _source: { cartId: 'recovered-cart' } }] },
    });

    const res = await loginRequest({ email: 'ada@example.com' });
    expect(res.status).toBe(200);

    expect(cookieStore.get('cartId')?.value).toBe('recovered-cart');
    expect(cartActions.executeCartUpdate).not.toHaveBeenCalled();
  });

  it('links the current guest cart to the user when ES has no active cart', async () => {
    cookieStore.set('cartId', 'guest-cart');

    const res = await loginRequest({ email: 'ada@example.com' });
    expect(res.status).toBe(200);

    expect(cartActions.executeCartUpdate).toHaveBeenCalledWith('guest-cart', 'cartUpdate', [
      { type: 'linkUser', email: 'ada@example.com', userId: 'shopper-1' },
    ]);
  });

  it('still logs in when the cart-linking ES lookup fails', async () => {
    es.search.mockRejectedValue(new Error('es down'));

    const res = await loginRequest({ email: 'ada@example.com' });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.shopper).toEqual(SHOPPER);
  });

  it('returns the default saved address when one exists', async () => {
    const addresses = [
      { id: 'a1', isDefault: false, city: 'Austin' },
      { id: 'a2', isDefault: true, city: 'Boston' },
    ];
    repos.getByUserId.mockResolvedValue(addresses);

    const res = await loginRequest({ email: 'ada@example.com' });
    const body = await res.json();
    expect(body.savedAddress).toEqual(addresses[1]);
  });
});
