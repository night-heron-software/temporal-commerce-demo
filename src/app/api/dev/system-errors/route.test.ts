/**
 * Tests for the system-errors route: query-param parsing into the errors service,
 * the DELETE (clear) action, and the hand-rolled 500 envelope — this route
 * deliberately avoids createErrorResponse so a down ES cannot feed the very index
 * it reads (so no correlationId, and `detail` is exposed).
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  querySystemErrors: vi.fn(),
  clearSystemErrors: vi.fn(),
}));

vi.mock('@/app/dev/system-errors/errors-service', () => ({
  querySystemErrors: svc.querySystemErrors,
  clearSystemErrors: svc.clearSystemErrors,
  DEFAULT_PAGE_SIZE: 50,
}));

import { DELETE, GET } from './route';

const EMPTY_RESULT = { hits: [], total: 0, page: 1, pageSize: 50 };

function request(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/dev/system-errors${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/dev/system-errors', () => {
  it('queries with defaults when no params are given', async () => {
    svc.querySystemErrors.mockResolvedValueOnce(EMPTY_RESULT);

    const res = await GET(request(''));

    expect(res.status).toBe(200);
    expect(svc.querySystemErrors).toHaveBeenCalledExactlyOnceWith({
      q: undefined,
      level: undefined,
      since: undefined,
      page: 1,
      pageSize: 50,
    });
    await expect(res.json()).resolves.toEqual(EMPTY_RESULT);
  });

  it('passes through q, level, since and pagination', async () => {
    svc.querySystemErrors.mockResolvedValueOnce({ ...EMPTY_RESULT, page: 3, pageSize: 10 });

    const res = await GET(request('?q=%20timeout%20&level=fatal&since=7d&page=3&pageSize=10'));

    expect(res.status).toBe(200);
    expect(svc.querySystemErrors).toHaveBeenCalledExactlyOnceWith({
      q: 'timeout',
      level: 'fatal',
      since: '7d',
      page: 3,
      pageSize: 10,
    });
  });

  it('drops an unrecognized level instead of forwarding it', async () => {
    svc.querySystemErrors.mockResolvedValueOnce(EMPTY_RESULT);

    await GET(request('?level=warn'));

    expect(svc.querySystemErrors).toHaveBeenCalledWith(
      expect.objectContaining({ level: undefined }),
    );
  });

  it('returns a hand-rolled 500 with detail (no correlationId) when the query fails', async () => {
    svc.querySystemErrors.mockRejectedValueOnce(new Error('es is down'));

    const res = await GET(request(''));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'Failed to query system errors',
      detail: 'es is down',
    });
  });
});

describe('DELETE /api/dev/system-errors', () => {
  it('clears the index and reports the deleted count', async () => {
    svc.clearSystemErrors.mockResolvedValueOnce(42);

    const res = await DELETE();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, deleted: 42 });
  });

  it('returns a hand-rolled 500 when the clear fails', async () => {
    svc.clearSystemErrors.mockRejectedValueOnce(new Error('delete_by_query failed'));

    const res = await DELETE();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'Failed to clear system errors',
      detail: 'delete_by_query failed',
    });
  });
});
