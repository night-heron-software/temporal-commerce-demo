/**
 * Row types for the async state-transition projection (ADR-0010, ported from nightheron-mono).
 *
 * The activity payload (`TransitionPersistRecord`) is the framework's wire type — payload and
 * snapshot are already serialized, capped, and redacted workflow-side, so this node side just
 * writes strings. The correlation tags (`Domain`, `CorrelationId`, `OrderId`) are mapped from
 * the record's generic `tags` into dedicated Cassandra columns by the repository.
 */
import type { ActivityCall } from '../framework';

export type { TransitionPersistRecord } from '../framework';

/** A decoded transition row read back for the dev tool / audit. */
export interface WorkflowTransitionRow {
  workflowId: string;
  at: string;
  runId: string;
  seq: number;
  workflowType: string;
  domain: string | null;
  correlationId: string | null;
  orderId: string | null;
  fromState: string;
  toState: string;
  triggerKind: string;
  triggerName: string | null;
  triggerPayload: unknown;
  contextSnapshot: unknown;
  prepareActivities: ActivityCall[];
  finalizeActivities: ActivityCall[];
}
