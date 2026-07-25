/**
 * OMS activity tests for the customer-communications footprint:
 * - indexOrder enriches the workflow-built (pure) OrderDocument with communication
 *   summaries read from the customer_communications source table — and degrades to a
 *   summary-less doc when the read fails (enrichment must never fail order indexing);
 * - the send stubs route through sendEmail with the domain-object context (orderId,
 *   commType, template subject/body) while their activity signatures stay unchanged.
 * Cassandra/ES and the Temporal activity logger are mocked at the lib boundary.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const lib = vi.hoisted(() => ({
  execute: vi.fn(),
  batch: vi.fn(),
  esIndex: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('@temporalio/activity', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../lib', () => ({
  getCassandraClient: () => ({ execute: lib.execute, batch: lib.batch }),
  getElasticsearchClient: () => ({ index: lib.esIndex }),
  cassandraTypes: {
    Uuid: { fromString: (s: string) => ({ toString: () => s }) },
    TimeUuid: { fromDate: (d: Date) => ({ toString: () => d.toISOString() }) },
  },
  sendEmail: lib.sendEmail,
}));

import { indexOrder, sendOrderStatusEmail, sendFeedbackThankYouEmail } from './activities-impl';
import type { Elasticsearch } from '../contracts';

const baseDoc = { orderId: 'o-1', correlationId: 'corr-1' } as Elasticsearch.OrderDocument;

beforeEach(() => {
  vi.clearAllMocks();
  lib.execute.mockResolvedValue({ rows: [] });
  lib.esIndex.mockResolvedValue({});
  lib.sendEmail.mockResolvedValue(undefined);
});

describe('indexOrder communication enrichment', () => {
  it('merges communication summaries from the source table into the built doc', async () => {
    lib.execute.mockResolvedValue({
      rows: [
        {
          sent_at: new Date('2026-07-01T00:00:00.000Z'),
          comm_type: 'order-confirmation',
          recipient: 'jane@example.com',
          subject: 'Order Confirmed - #CONF-1',
        },
        {
          sent_at: new Date('2026-07-02T00:00:00.000Z'),
          comm_type: 'shipped',
          recipient: 'jane@example.com',
          subject: 'Your order #CONF-1 has shipped',
        },
      ],
    });

    await indexOrder(baseDoc);

    const readCall = lib.execute.mock.calls[0];
    expect(readCall[0]).toContain('FROM customer_communications');
    expect(readCall[1][0].toString()).toBe('o-1');

    expect(lib.esIndex).toHaveBeenCalledWith({
      index: 'orders',
      id: 'o-1',
      document: {
        ...baseDoc,
        communications: [
          {
            commType: 'order-confirmation',
            subject: 'Order Confirmed - #CONF-1',
            sentAt: '2026-07-01T00:00:00.000Z',
            recipient: 'jane@example.com',
          },
          {
            commType: 'shipped',
            subject: 'Your order #CONF-1 has shipped',
            sentAt: '2026-07-02T00:00:00.000Z',
            recipient: 'jane@example.com',
          },
        ],
      },
    });
  });

  it('still indexes the order (empty summaries) when the Cassandra read fails', async () => {
    lib.execute.mockRejectedValue(new Error('table does not exist'));

    await indexOrder(baseDoc);

    expect(lib.esIndex).toHaveBeenCalledWith({
      index: 'orders',
      id: 'o-1',
      document: { ...baseDoc, communications: [] },
    });
  });
});

describe('send stubs route through sendEmail (signatures unchanged)', () => {
  it('sendOrderStatusEmail sends the templated status email with tracking details', async () => {
    await sendOrderStatusEmail('jane@example.com', 'o-1', 'shipped', {
      trackingNumber: '1Z999',
      carrier: 'UPS',
    });

    expect(lib.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'jane@example.com',
        subject: 'Order #o-1 update: shipped',
        orderId: 'o-1',
        commType: 'order-status',
        actor: 'sendOrderStatusEmail',
        text: expect.stringContaining('tracking number 1Z999'),
      }),
    );
  });

  it('sendFeedbackThankYouEmail sends the templated thank-you', async () => {
    await sendFeedbackThankYouEmail('jane@example.com', 'o-1');

    expect(lib.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'jane@example.com',
        subject: 'Thanks for your feedback on order #o-1',
        orderId: 'o-1',
        commType: 'feedback-thanks',
        actor: 'sendFeedbackThankYouEmail',
      }),
    );
  });
});
