/**
 * Elasticsearch write side of the projection-completion mark.
 *
 * Called only from the `markProjectionsCompleted` activity, scheduled by the framework
 * driver when a workflow closes (terminal, cancellation, or failure). The partial
 * `update` can never clobber domain fields — it only stamps the lifecycle trio.
 */
import { getElasticsearchClient, isIndexNotFoundError } from '../../lib/es-client';
import type { ProjectionRef, WorkflowOutcome } from '../contracts/elasticsearch';

export interface MarkProjectionsCompletedInput {
  refs: ProjectionRef[];
  outcome: WorkflowOutcome;
  closedAt: string;
}

function isDocumentMissingError(error: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const err = error as any;
  return (
    err?.meta?.statusCode === 404 ||
    String(err?.message ?? '').includes('document_missing_exception')
  );
}

/**
 * Stamp each referenced projection doc as completed. Tolerates per-ref missing docs
 * (never indexed — e.g. a fulfiller order still in intake) and missing indices (the
 * reindex delete/recreate window); anything else rethrows so the activity retries.
 */
export async function markProjectionsCompleted(
  input: MarkProjectionsCompletedInput,
): Promise<void> {
  const { refs, outcome, closedAt } = input;
  if (!refs || refs.length === 0) return;
  const client = getElasticsearchClient();
  for (const ref of refs) {
    try {
      await client.update({
        index: ref.index,
        id: ref.id,
        doc: {
          workflowStatus: 'completed',
          workflowOutcome: outcome,
          workflowClosedAt: closedAt,
        },
      });
    } catch (error) {
      if (isDocumentMissingError(error) || isIndexNotFoundError(error)) continue;
      throw error;
    }
  }
}
