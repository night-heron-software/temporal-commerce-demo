/**
 * Tests for the dev order-trace route: param validation, wiring into the trace
 * service (resolve → build), the multi-candidate branch, and the deliberate
 * 400-not-500 catch for malformed lookups.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  resolveOrderId: vi.fn(),
  buildOrderTrace: vi.fn(),
}));

vi.mock('@/app/dev/order-trace/trace-service', () => ({
  resolveOrderId: svc.resolveOrderId,
  buildOrderTrace: svc.buildOrderTrace,
}));

import { GET } from './route';

function request(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/dev/order-trace${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/dev/order-trace', () => {
  it('rejects a request with no lookup params without touching the service', async () => {
    const res = await GET(request(''));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Provide one of orderId, confirmation, or email',
      correlationId: expect.any(String),
    });
    expect(svc.resolveOrderId).not.toHaveBeenCalled();
  });

  it('treats whitespace-only params as absent', async () => {
    const res = await GET(request('?orderId=%20%20&email='));

    expect(res.status).toBe(400);
    expect(svc.resolveOrderId).not.toHaveBeenCalled();
  });

  it('builds and returns the trace for a uniquely resolved order', async () => {
    svc.resolveOrderId.mockResolvedValueOnce({ orderId: 'o-1', storeId: 'store-1' });
    svc.buildOrderTrace.mockResolvedValueOnce({ orderId: 'o-1', nodes: [] });

    const res = await GET(request('?orderId=o-1&confirmation=%20CONF-9%20'));

    expect(res.status).toBe(200);
    expect(svc.resolveOrderId).toHaveBeenCalledExactlyOnceWith({
      orderId: 'o-1',
      confirmation: 'CONF-9',
      email: undefined,
    });
    expect(svc.buildOrderTrace).toHaveBeenCalledExactlyOnceWith('store-1', 'o-1');
    await expect(res.json()).resolves.toEqual({ trace: { orderId: 'o-1', nodes: [] } });
  });

  it('returns candidates for disambiguation without building a trace', async () => {
    const candidates = [
      {
        orderId: 'o-1',
        confirmationNumber: 'C-1',
        total: 10,
        currency: 'USD',
        status: 'completed',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    svc.resolveOrderId.mockResolvedValueOnce({ candidates });

    const res = await GET(request('?email=shopper@example.com'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ candidates });
    expect(svc.buildOrderTrace).not.toHaveBeenCalled();
  });

  it('returns 404 when nothing matches the lookup', async () => {
    svc.resolveOrderId.mockResolvedValueOnce({});

    const res = await GET(request('?confirmation=NOPE'));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'No order matched the lookup' });
    expect(svc.buildOrderTrace).not.toHaveBeenCalled();
  });

  it('maps service throws (e.g. malformed UUID) to a 400, not a 500', async () => {
    svc.resolveOrderId.mockRejectedValueOnce(new Error('Invalid UUID string: not-a-uuid'));

    const res = await GET(request('?orderId=not-a-uuid'));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Failed to build order trace',
      correlationId: expect.any(String),
    });
  });
});
