/**
 * Tests for the ES index bootstrap route: delegates to ensureIndicesExist and maps
 * failure to the standard createErrorResponse shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureIndicesExist = vi.hoisted(() => vi.fn());

vi.mock('@/lib/es-index-mappings', () => ({
  ensureIndicesExist,
}));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  ensureIndicesExist.mockResolvedValue(undefined);
});

describe('POST /api/dev/init/es-indices', () => {
  it('ensures indices exactly once and reports success', async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(ensureIndicesExist).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toEqual({
      success: true,
      message: 'ES indices ensured',
    });
  });

  it('returns a 500 error envelope with a correlationId when ES is unreachable', async () => {
    ensureIndicesExist.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const res = await POST();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'Failed to ensure ES indices',
      correlationId: expect.any(String),
    });
  });
});
