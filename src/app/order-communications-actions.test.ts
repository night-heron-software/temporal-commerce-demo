/**
 * Shared order-communications Server Action tests: chronological orderId lookup against
 * the `communications` index, and the failure guard (missing index / ES down) degrading
 * to an empty list so order-detail pages never break.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const es = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock('@/lib/es-client', () => ({
  getElasticsearchClient: () => ({ search: es.search }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getOrderCommunications } from './order-communications-actions';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOrderCommunications', () => {
  it('queries the communications index by orderId term, sorted sentAt asc', async () => {
    const doc = {
      id: 'o-1:1:0',
      orderId: 'o-1',
      channel: 'email',
      commType: 'shipped',
      recipient: 'jane@example.com',
      subject: 'Your order #CONF-1 has shipped',
      sentAt: '2026-07-01T00:00:00.000Z',
    };
    es.search.mockResolvedValue({ hits: { hits: [{ _source: doc }, { _source: undefined }] } });

    const result = await getOrderCommunications('o-1');

    expect(es.search).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 'communications',
        query: { term: { orderId: 'o-1' } },
        sort: [{ sentAt: { order: 'asc' } }],
      }),
    );
    // Sourceless hits are dropped; real docs pass through untouched.
    expect(result).toEqual([doc]);
  });

  it('degrades to an empty list when ES fails (missing index, connection refused)', async () => {
    es.search.mockRejectedValue(new Error('index_not_found_exception'));

    await expect(getOrderCommunications('o-1')).resolves.toEqual([]);
  });
});
