/**
 * Tests for POST /api/auth/shopper/logout.
 */
import { describe, expect, it, vi } from 'vitest';

const cookieStore = await vi.hoisted(async () => {
  const { createCookieStoreMock } = await import('../../../../../test-support/next-route');
  return createCookieStoreMock();
});

vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

import { POST } from './route';

describe('POST /api/auth/shopper/logout', () => {
  it('deletes the session cookie and reports ok', async () => {
    cookieStore.set('shopperId', 'shopper-1');

    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(cookieStore.get('shopperId')).toBeUndefined();
    expect(cookieStore.deleted).toContain('shopperId');
  });
});
