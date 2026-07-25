/**
 * Tests for the admin feature-flags route: GET passthrough of the flag store and
 * PUT validation ({ name: string, value: boolean }, name in the known-flag
 * vocabulary, JSON body) before writing.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({
  getAllFlags: vi.fn(),
  setFlag: vi.fn(),
}));

vi.mock('@/lib/feature-flags', () => ({
  getAllFlags: flags.getAllFlags,
  setFlag: flags.setFlag,
  KNOWN_FLAG_NAMES: ['MANUAL_FULFILLMENT', 'DATA_FLOW_LOGGING'],
}));

import { GET, PUT } from './route';

function putRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/feature-flags', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.getAllFlags.mockReturnValue({ MANUAL_FULFILLMENT: false, DATA_FLOW_LOGGING: true });
});

describe('GET /api/admin/feature-flags', () => {
  it('returns the full flag map', async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      MANUAL_FULFILLMENT: false,
      DATA_FLOW_LOGGING: true,
    });
  });
});

describe('PUT /api/admin/feature-flags', () => {
  it('sets the flag and returns the updated map', async () => {
    flags.getAllFlags.mockReturnValue({ MANUAL_FULFILLMENT: true, DATA_FLOW_LOGGING: true });

    const res = await PUT(putRequest({ name: 'MANUAL_FULFILLMENT', value: true }));

    expect(res.status).toBe(200);
    expect(flags.setFlag).toHaveBeenCalledExactlyOnceWith('MANUAL_FULFILLMENT', true);
    await expect(res.json()).resolves.toEqual({
      success: true,
      flags: { MANUAL_FULFILLMENT: true, DATA_FLOW_LOGGING: true },
    });
  });

  it('rejects an unknown flag name with 400 and does not write', async () => {
    const res = await PUT(putRequest({ name: 'MANUAL_FULFILMENT', value: true }));

    expect(res.status).toBe(400);
    expect(flags.setFlag).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toContain("Unknown flag 'MANUAL_FULFILMENT'");
  });

  it('rejects a malformed JSON body with 400 instead of throwing', async () => {
    const res = await PUT(
      new NextRequest('http://localhost/api/admin/feature-flags', {
        method: 'PUT',
        body: 'not json{',
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(res.status).toBe(400);
    expect(flags.setFlag).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean value without writing', async () => {
    const res = await PUT(putRequest({ name: 'MANUAL_FULFILLMENT', value: 'true' }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Invalid request. Expected { name: string, value: boolean }',
    });
    expect(flags.setFlag).not.toHaveBeenCalled();
  });

  it('rejects a missing name without writing', async () => {
    const res = await PUT(putRequest({ value: false }));

    expect(res.status).toBe(400);
    expect(flags.setFlag).not.toHaveBeenCalled();
  });
});
