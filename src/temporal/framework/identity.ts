/**
 * Convention-based workflow identity resolution for transition recording.
 *
 * The framework's convention: every recorded workflow carries a tenant id in a keyword
 * Search Attribute (default `StoreId`), plus any number of correlation tags in further
 * custom keyword Search Attributes (e.g. `Domain`, `CorrelationId`). Workflows started
 * before tagging — or by hosts that only use the dot-delimited
 * `{tenantId}.{domain}.{entityId}` workflow-ID convention — fall back to parsing the
 * workflow ID.
 *
 * Hosts with a different convention supply their own {@link TransitionIdentityResolver}
 * via `TransitionRecordingConfig.identity`.
 */
import { workflowInfo } from '@temporalio/workflow';
import type { TransitionIdentity, TransitionIdentityResolver } from './types';

export interface ConventionIdentityOptions {
  /** Search Attribute holding the tenant id. Default: 'StoreId'. */
  tenantAttribute?: string;
  /**
   * Fallback when Search Attributes are absent. Default parses the dot-delimited
   * `{tenantId}.{domain}.{entityId}` workflow-ID convention into
   * `{ tenantId, tags: { Domain: domain } }`; returns undefined for other shapes.
   */
  workflowIdFallback?: (workflowId: string) => TransitionIdentity | undefined;
}

const DEFAULT_TENANT_ATTRIBUTE = 'StoreId';

/** Default workflow-ID fallback: the three-part dot-delimited convention. */
function parseDotDelimitedWorkflowId(workflowId: string): TransitionIdentity | undefined {
  const parts = workflowId.split('.');
  if (parts.length !== 3) return undefined;
  return { tenantId: parts[0], tags: { Domain: parts[1] } };
}

/** First value of a keyword Search Attribute, when it is a string. */
function keywordValue(values: unknown): string | undefined {
  return Array.isArray(values) && typeof values[0] === 'string' ? values[0] : undefined;
}

/**
 * Build the convention resolver: tenant id from the tenant Search Attribute (falling back to
 * the workflow-ID parse); tags = every other custom keyword Search Attribute, excluding
 * Temporal built-ins (`Temporal*` keys). Returns `undefined` when no tenant id can be
 * resolved — such workflows are not recorded.
 */
export function conventionIdentityResolver(
  options?: ConventionIdentityOptions,
): TransitionIdentityResolver {
  const tenantAttribute = options?.tenantAttribute ?? DEFAULT_TENANT_ATTRIBUTE;
  const fallback = options?.workflowIdFallback ?? parseDotDelimitedWorkflowId;

  return () => {
    const info = workflowInfo();
    const searchAttributes = info.searchAttributes ?? {};

    const tags: Record<string, string> = {};
    for (const [key, values] of Object.entries(searchAttributes)) {
      if (key === tenantAttribute || key.startsWith('Temporal')) continue;
      const value = keywordValue(values);
      if (value !== undefined) tags[key] = value;
    }

    const parsed = fallback(info.workflowId);
    const tenantId = keywordValue(searchAttributes[tenantAttribute]) ?? parsed?.tenantId;
    if (tenantId === undefined) return undefined;

    for (const [key, value] of Object.entries(parsed?.tags ?? {})) {
      if (!(key in tags)) tags[key] = value;
    }

    return { tenantId, tags: Object.keys(tags).length > 0 ? tags : undefined };
  };
}
