/**
 * Customer Communications — domain contract.
 *
 * Every simulated customer-facing send (confirmation, status updates, shipped/delivered,
 * feedback thanks) is a first-class domain object: source of truth in the
 * `customer_communications` Cassandra table, projected into the `communications` ES index
 * (see `contracts/elasticsearch.ts` for the document shape).
 *
 * PURE module — no Temporal imports. Consumers import it directly by module path (never
 * via the contracts barrel), so it can be loaded from workflow-mocked tests and Node lib
 * code alike without dragging cart.ts's module-scope defineUpdate into the import graph
 * (the document-builder barrel note from PR #41).
 */

/** The five customer-facing sends the demo produces today. */
export type CommunicationType =
  | 'order-confirmation'
  | 'order-status'
  | 'shipped'
  | 'delivered'
  | 'feedback-thanks';

/**
 * Delivery channel. Always 'email' today; exists so in-app/SMS notifications slot in
 * without a schema change.
 */
export type CommunicationChannel = 'email';

/**
 * One communication sent to a customer — an immutable point-in-time fact keyed by order.
 * Identity is `(orderId, sentAt, seq)` in Cassandra; `id` is the deterministic composite
 * used as the ES doc id, so a write-through and a later reindex produce the same doc.
 */
export interface CustomerCommunication {
  id: string;
  orderId: string;
  /**
   * Journey correlationId (ADR-0011) — the join field shared with every order-flow
   * index; null for legacy/API-originated sends outside a correlation scope.
   */
  correlationId: string | null;
  channel: CommunicationChannel;
  commType: CommunicationType;
  /** Customer email address the communication was sent to. */
  recipient: string;
  subject: string;
  body: string;
  sentAt: string;
  /**
   * Sending surface (activity name). The true workflowId is not ambient in activities —
   * the correlationId is the journey join.
   */
  actor: string;
}

/**
 * The ES doc id for one communication: deterministic from the Cassandra row's identity,
 * so live write-through and reindex rebuilds address the same document.
 */
export function buildCommunicationId(orderId: string, sentAtMs: number, seq: number): string {
  return `${orderId}:${sentAtMs}:${seq}`;
}
