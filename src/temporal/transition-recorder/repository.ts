/**
 * Cassandra repository for the async state-transition projection (ADR-0010).
 *
 * Write side is called only from the `persistWorkflowTransitions` activity (off the workflow
 * hot path). Read side (`getWorkflowTransitions`) is used by server code (the order-trace dev
 * tool), not by a workflow. `store_id` is always the fixed demo tenant.
 */
import { executeBatch, executeCql } from '../../lib/cassandra-client';
import type { ActivityCall } from '../framework';
import type { TransitionPersistRecord, WorkflowTransitionRow } from './types';

const INSERT_TRANSITION = `INSERT INTO workflow_state_transitions (
  store_id, workflow_id, at, run_id, seq, workflow_type, domain, correlation_id, order_id,
  from_state, to_state, trigger_kind, trigger_name, trigger_payload, context_snapshot,
  prepare_activities, finalize_activities, update_result
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Batch-write a run of transitions for a single workflow. All records in a flush batch share
 * the same `(store_id, workflow_id)` partition, so an unlogged batch is safe and cheap. The
 * `(at, run_id, seq)` key is workflow-determined, so re-writes on activity retry are idempotent.
 */
export async function persistWorkflowTransitions(
  records: TransitionPersistRecord[],
): Promise<void> {
  if (!records || records.length === 0) return;
  const queries = records.map((r) => ({
    query: INSERT_TRANSITION,
    params: [
      r.tenantId,
      r.workflowId,
      new Date(r.at),
      r.runId,
      r.seq,
      r.workflowType,
      r.tags?.Domain ?? null,
      r.tags?.CorrelationId ?? null,
      r.tags?.OrderId ?? null,
      r.fromState,
      r.toState,
      r.triggerKind,
      r.triggerName ?? null,
      r.triggerPayload ?? null,
      r.contextSnapshot ?? null,
      r.prepareActivities ?? null,
      r.finalizeActivities ?? null,
      r.updateResult ?? null,
    ],
  }));
  await executeBatch(queries, { logged: false });
}

interface TransitionCqlRow {
  workflow_id: string;
  at: { toISOString(): string } | null;
  run_id: string;
  seq: number;
  workflow_type: string;
  domain: string | null;
  correlation_id: string | null;
  order_id: string | null;
  from_state: string;
  to_state: string;
  trigger_kind: string;
  trigger_name: string | null;
  trigger_payload: string | null;
  context_snapshot: string | null;
  prepare_activities: string | null;
  finalize_activities: string | null;
  update_result: string | null;
}

function parseJson(s: string | null): unknown {
  if (s == null) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function parseActivityCalls(s: string | null): ActivityCall[] {
  const v = parseJson(s);
  return Array.isArray(v)
    ? v.filter((x): x is ActivityCall => Boolean(x) && typeof x === 'object')
    : [];
}

/** Read a workflow's transition timeline (ordered by `at`), decoding payload/snapshot JSON. */
export async function getWorkflowTransitions(
  storeId: string,
  workflowId: string,
): Promise<WorkflowTransitionRow[]> {
  const rows = await executeCql<TransitionCqlRow>(
    `SELECT workflow_id, at, run_id, seq, workflow_type, domain, correlation_id, order_id,
            from_state, to_state, trigger_kind, trigger_name, trigger_payload, context_snapshot,
            prepare_activities, finalize_activities, update_result
     FROM workflow_state_transitions WHERE store_id = ? AND workflow_id = ?`,
    [storeId, workflowId],
  );
  return rows.map((r) => ({
    workflowId: r.workflow_id,
    at: r.at?.toISOString() ?? '',
    runId: r.run_id,
    seq: r.seq,
    workflowType: r.workflow_type,
    domain: r.domain,
    correlationId: r.correlation_id,
    orderId: r.order_id,
    fromState: r.from_state,
    toState: r.to_state,
    triggerKind: r.trigger_kind,
    triggerName: r.trigger_name,
    triggerPayload: parseJson(r.trigger_payload),
    contextSnapshot: parseJson(r.context_snapshot),
    prepareActivities: parseActivityCalls(r.prepare_activities),
    finalizeActivities: parseActivityCalls(r.finalize_activities),
    updateResult: parseJson(r.update_result),
  }));
}
