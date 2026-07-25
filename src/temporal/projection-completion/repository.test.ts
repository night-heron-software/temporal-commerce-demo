/**
 * Unit tests for the projection-completion write side: partial-update payload shape,
 * per-ref tolerance of missing docs/indices, and rethrow of everything else.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const update = vi.fn();

vi.mock('../../lib/es-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/es-client')>();
  return {
    ...original,
    getElasticsearchClient: () => ({ update }),
  };
});

import { markProjectionsCompleted } from './repository';

const CLOSED_AT = '2026-07-24T12:00:00.000Z';

beforeEach(() => {
  update.mockReset();
  update.mockResolvedValue(undefined);
});

describe('markProjectionsCompleted', () => {
  it('partial-updates each ref with exactly the lifecycle trio', async () => {
    await markProjectionsCompleted({
      refs: [
        { index: 'orders', id: 'o-1' },
        { index: 'fulfiller_orders', id: 'fo-1' },
      ],
      outcome: 'completed',
      closedAt: CLOSED_AT,
    });

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith({
      index: 'orders',
      id: 'o-1',
      doc: {
        workflowStatus: 'completed',
        workflowOutcome: 'completed',
        workflowClosedAt: CLOSED_AT,
      },
    });
  });

  it('no-ops on an empty ref list without touching the client', async () => {
    await markProjectionsCompleted({ refs: [], outcome: 'completed', closedAt: CLOSED_AT });
    expect(update).not.toHaveBeenCalled();
  });

  it('swallows a missing doc (404) and continues with the remaining refs', async () => {
    update
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { meta: { statusCode: 404 } }))
      .mockResolvedValueOnce(undefined);

    await markProjectionsCompleted({
      refs: [
        { index: 'fulfiller_orders', id: 'never-indexed' },
        { index: 'orders', id: 'o-1' },
      ],
      outcome: 'canceled',
      closedAt: CLOSED_AT,
    });

    expect(update).toHaveBeenCalledTimes(2);
  });

  it('swallows document_missing_exception by message text', async () => {
    update.mockRejectedValueOnce(new Error('document_missing_exception: [orders][o-x] missing'));
    await expect(
      markProjectionsCompleted({
        refs: [{ index: 'orders', id: 'o-x' }],
        outcome: 'failed',
        closedAt: CLOSED_AT,
      }),
    ).resolves.toBeUndefined();
  });

  it('swallows a missing index (reindex delete/recreate window)', async () => {
    update.mockRejectedValueOnce(
      Object.assign(new Error('ResponseError'), {
        meta: { body: { error: { type: 'index_not_found_exception' } } },
      }),
    );
    await expect(
      markProjectionsCompleted({
        refs: [{ index: 'carts', id: 'c-1' }],
        outcome: 'completed',
        closedAt: CLOSED_AT,
      }),
    ).resolves.toBeUndefined();
  });

  it('rethrows any other error so the activity retries', async () => {
    update.mockRejectedValueOnce(new Error('es exploded'));
    await expect(
      markProjectionsCompleted({
        refs: [{ index: 'orders', id: 'o-1' }],
        outcome: 'completed',
        closedAt: CLOSED_AT,
      }),
    ).rejects.toThrow('es exploded');
  });
});
