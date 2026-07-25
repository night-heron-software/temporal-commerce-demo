/**
 * email-service persistence write-through tests: an order-linked send produces a
 * Cassandra row + ES doc; a plain send stays console-only; either store failing is
 * swallowed with a warn (the send never fails); the ambient correlationId (ADR-0011)
 * wins over the explicit param, which is the fallback outside a correlation scope.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const stores = vi.hoisted(() => ({
  executeCql: vi.fn(),
  esIndex: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./cassandra-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('./cassandra-client')>();
  return {
    ...original,
    executeCql: stores.executeCql,
  };
});
vi.mock('./es-client', () => ({
  getElasticsearchClient: () => ({ index: stores.esIndex }),
}));
vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: stores.warn, error: vi.fn(), debug: vi.fn() }),
}));

import { sendEmail } from './email-service';
import { runWithCorrelationId } from './correlation-context';

const ORDER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

beforeEach(() => {
  vi.clearAllMocks();
  stores.executeCql.mockResolvedValue([]);
  stores.esIndex.mockResolvedValue({});
});

describe('sendEmail persistence write-through', () => {
  it('persists an order-linked send to Cassandra and the communications index', async () => {
    await sendEmail({
      to: 'jane@example.com',
      subject: 'Your order #CONF-1 has shipped',
      text: 'On its way',
      orderId: ORDER_ID,
      commType: 'shipped',
      actor: 'sendShippedEmail',
    });

    expect(stores.executeCql).toHaveBeenCalledTimes(1);
    const [cql, params] = stores.executeCql.mock.calls[0];
    expect(cql).toContain('INSERT INTO customer_communications');
    expect(params[0].toString()).toBe(ORDER_ID);
    expect(params.slice(4)).toEqual([
      'email',
      'shipped',
      'jane@example.com',
      'Your order #CONF-1 has shipped',
      'On its way',
      'sendShippedEmail',
    ]);

    expect(stores.esIndex).toHaveBeenCalledTimes(1);
    const { index, id, document } = stores.esIndex.mock.calls[0][0];
    expect(index).toBe('communications');
    // Deterministic composite id: orderId:sentAtMs:seq — reindex rebuilds the same doc.
    expect(id).toBe(document.id);
    expect(id).toMatch(new RegExp(`^${ORDER_ID}:${new Date(document.sentAt).getTime()}:\\d+$`));
    expect(document).toMatchObject({
      orderId: ORDER_ID,
      channel: 'email',
      commType: 'shipped',
      recipient: 'jane@example.com',
      subject: 'Your order #CONF-1 has shipped',
      body: 'On its way',
      actor: 'sendShippedEmail',
    });
  });

  it('skips persistence entirely when there is no orderId', async () => {
    await sendEmail({ to: 'jane@example.com', subject: 'Hello' });

    expect(stores.executeCql).not.toHaveBeenCalled();
    expect(stores.esIndex).not.toHaveBeenCalled();
  });

  it('still "sends" (and still writes ES) when Cassandra throws — warn only', async () => {
    stores.executeCql.mockRejectedValue(new Error('cassandra down'));

    await expect(
      sendEmail({ to: 'a@b.c', subject: 's', orderId: ORDER_ID, commType: 'delivered' }),
    ).resolves.toBeUndefined();

    expect(stores.esIndex).toHaveBeenCalledTimes(1);
    expect(stores.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID }),
      expect.stringContaining('Cassandra write failed'),
    );
  });

  it('still "sends" when ES throws — warn only, Cassandra row already written', async () => {
    stores.esIndex.mockRejectedValue(new Error('es down'));

    await expect(
      sendEmail({ to: 'a@b.c', subject: 's', orderId: ORDER_ID, commType: 'delivered' }),
    ).resolves.toBeUndefined();

    expect(stores.executeCql).toHaveBeenCalledTimes(1);
    expect(stores.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID }),
      expect.stringContaining('ES write failed'),
    );
  });

  it('stamps the ambient correlationId (ADR-0011), which wins over the explicit param', async () => {
    await runWithCorrelationId('ambient-corr', () =>
      sendEmail({
        to: 'a@b.c',
        subject: 's',
        orderId: ORDER_ID,
        commType: 'order-status',
        correlationId: 'explicit-corr',
      }),
    );

    expect(stores.executeCql.mock.calls[0][1][3]).toBe('ambient-corr');
    expect(stores.esIndex.mock.calls[0][0].document.correlationId).toBe('ambient-corr');
  });

  it('falls back to the explicit correlationId outside a correlation scope, else null', async () => {
    await sendEmail({
      to: 'a@b.c',
      subject: 's',
      orderId: ORDER_ID,
      commType: 'order-status',
      correlationId: 'explicit-corr',
    });
    expect(stores.executeCql.mock.calls[0][1][3]).toBe('explicit-corr');

    await sendEmail({ to: 'a@b.c', subject: 's', orderId: ORDER_ID, commType: 'order-status' });
    expect(stores.executeCql.mock.calls[1][1][3]).toBeNull();
  });

  it('orders same-millisecond sends deterministically via the monotonic seq', async () => {
    await sendEmail({ to: 'a@b.c', subject: 's1', orderId: ORDER_ID, commType: 'shipped' });
    await sendEmail({ to: 'a@b.c', subject: 's2', orderId: ORDER_ID, commType: 'delivered' });

    const seq1 = stores.executeCql.mock.calls[0][1][2];
    const seq2 = stores.executeCql.mock.calls[1][1][2];
    expect(seq2).toBe(seq1 + 1);
  });
});
