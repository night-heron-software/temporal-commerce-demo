/**
 * Email Service — Console-only stub for demo, and the single persistence choke point
 * for customer communications.
 *
 * In the full platform this sends via Mailgun/SendGrid; the provider would slot in here
 * with the persistence unchanged. For the demo, the "send" logs to console — but every
 * order-linked send is persisted as a CustomerCommunication domain object: a row in the
 * `customer_communications` Cassandra table (source of truth) and a write-through doc in
 * the `communications` ES index. Persistence is best-effort and never fails the send
 * (same guard posture as the inventory journal's recordHistoryBestEffort).
 */

import { createLogger } from './logger';
import { executeCql, cassandraTypes as types } from './cassandra-client';
import { getElasticsearchClient } from './es-client';
import { currentCorrelationId } from './correlation-context';
// Direct module imports (not the contracts barrel) — pure modules, safe from lib code
// and workflow-mocked tests alike (PR #41).
import { buildCommunicationId, type CommunicationType } from '../temporal/contracts/communications';
import { ES_INDICES, type CommunicationDocument } from '../temporal/contracts/elasticsearch';

const log = createLogger('email');

export interface SendEmailParams {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  /**
   * Domain-object context: presence of `orderId` turns on the persistence
   * write-through (Cassandra row + ES doc). Sends without an order (none today)
   * stay console-only.
   */
  orderId?: string;
  /**
   * Journey correlationId (ADR-0011) fallback for callers outside an activity
   * correlation scope; the ambient `currentCorrelationId()` wins when set.
   */
  correlationId?: string;
  commType?: CommunicationType;
  /** Sending surface (activity name) recorded as the row's actor. */
  actor?: string;
}

/**
 * Per-process monotonic tiebreak within a timestamp, mirroring inventory_history's
 * writer: (sent_at, seq) orders same-millisecond sends deterministically.
 */
let commSeq = 0;

/**
 * Best-effort persistence of one send: Cassandra INSERT (source of truth) and ES
 * write-through, each guarded independently — Cassandra up / ES down still records the
 * fact and a later reindex heals the projection. Never throws.
 */
async function persistCommunication(params: SendEmailParams & { orderId: string }): Promise<void> {
  const sentAt = new Date();
  const seq = commSeq++;
  const correlationId = currentCorrelationId() ?? params.correlationId ?? null;
  const body = params.text ?? params.html ?? '';
  const actor = params.actor ?? 'email-service';

  try {
    await executeCql(
      `INSERT INTO customer_communications (
        order_id, sent_at, seq, correlation_id, channel, comm_type,
        recipient, subject, body, actor
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        types.Uuid.fromString(params.orderId),
        sentAt,
        seq,
        correlationId,
        'email',
        params.commType ?? null,
        params.to,
        params.subject,
        body,
        actor,
      ],
    );
  } catch (err) {
    log.warn(
      { err, orderId: params.orderId, commType: params.commType },
      'Communication Cassandra write failed (best-effort — send unaffected)',
    );
  }

  try {
    const doc: CommunicationDocument = {
      id: buildCommunicationId(params.orderId, sentAt.getTime(), seq),
      orderId: params.orderId,
      correlationId: correlationId ?? undefined,
      channel: 'email',
      commType: params.commType,
      recipient: params.to,
      subject: params.subject,
      body,
      sentAt: sentAt.toISOString(),
      actor,
    };
    await getElasticsearchClient().index({
      index: ES_INDICES.communications,
      id: doc.id,
      document: doc,
    });
  } catch (err) {
    log.warn(
      { err, orderId: params.orderId, commType: params.commType },
      'Communication ES write failed (best-effort — send unaffected; reindex heals)',
    );
  }
}

export async function sendEmail(params: SendEmailParams): Promise<void> {
  log.info(
    { to: params.to, subject: params.subject, orderId: params.orderId, commType: params.commType },
    '📧 [DEMO] Email sent (console only)',
  );
  if (params.orderId) {
    await persistCommunication(params as SendEmailParams & { orderId: string });
  }
}
