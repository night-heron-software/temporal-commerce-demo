/**
 * Temporal UI link builders — the ONE place these URLs are built (backlog #8 /
 * remediation R9; previously one env-aware builder in admin-order-actions plus ~10
 * hardcoded `localhost:8233` hrefs, including an order-detail link that hardcoded the
 * `default` namespace and pointed at a single workflow instead of the journey).
 *
 * Universal module (usable from client components and server code alike), so it reads
 * its own env rather than importing the server-only temporal-client:
 * - server: `TEMPORAL_UI_URL` / `TEMPORAL_NAMESPACE`
 * - client bundle: `NEXT_PUBLIC_TEMPORAL_UI_URL` / `NEXT_PUBLIC_TEMPORAL_NAMESPACE`
 *   (inlined at build; unset in the demo, where the localhost default is the point)
 *
 * NOTE: the UI's "Show Child Workflows" toggle is NOT URL-addressable — proven during
 * run -006's F10 chase, where the operator's URL and a fresh profile's identical URL
 * rendered different row sets (the toggle lives in profile localStorage). So journey
 * links cannot pre-enable it; the walkthrough warns operators instead.
 */

function base(): string {
  return (
    process.env.NEXT_PUBLIC_TEMPORAL_UI_URL ||
    process.env.TEMPORAL_UI_URL ||
    'http://localhost:8233'
  );
}

function namespace(): string {
  return process.env.NEXT_PUBLIC_TEMPORAL_NAMESPACE || process.env.TEMPORAL_NAMESPACE || 'default';
}

/** The Temporal UI home (namespace-unscoped). */
export function temporalUiUrl(): string {
  return base();
}

/** Workflows list filtered by an arbitrary visibility query. */
export function temporalWorkflowsQueryUrl(query: string): string {
  return `${base()}/namespaces/${namespace()}/workflows?query=${encodeURIComponent(query)}`;
}

/**
 * The JOURNEY view: every workflow carrying this correlationId (post-R5, the cartId —
 * one id returns everything the cart ever did). Remind operators that child workflows
 * only appear with the UI's "Show Child Workflows" toggle on.
 */
export function temporalWorkflowsByCorrelationUrl(correlationId: string): string {
  return temporalWorkflowsQueryUrl(`CorrelationId="${correlationId}"`);
}

/** Workflows list filtered to one workflow type (admin index pages). */
export function temporalWorkflowsByTypeUrl(workflowType: string): string {
  return temporalWorkflowsQueryUrl(`WorkflowType="${workflowType}"`);
}

/** One workflow's detail page. */
export function temporalWorkflowUrl(workflowId: string): string {
  return `${base()}/namespaces/${namespace()}/workflows/${encodeURIComponent(workflowId)}`;
}
