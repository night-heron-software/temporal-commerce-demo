/**
 * Replay registry — maps each domain to its workflow module path (ported from
 * nightheron-mono's @nightheron/test-support).
 *
 * This is the single source of truth for the replay test: it iterates every entry, reads
 * `__histories__/*.json` from the directory next to the domain's workflows module, and replays
 * each history against the current workflow code. A domain listed here without fixtures fails
 * the gate loudly rather than passing vacuously.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface ReplayDomainSpec {
  /** Human-readable domain name (e.g. 'cart'). */
  domain: string;
  /** Absolute path to the domain's `workflows.ts` entrypoint. */
  workflowsPath: string;
}

function domainWorkflowsPath(domain: string): string {
  return path.join(HERE, '..', 'temporal', domain, 'workflows.ts');
}

/**
 * Domains with replay fixtures. Add an entry here when `npm run histories:capture` has produced
 * fixtures for it. The core order chain — the domains whose workflow changes are most likely to
 * break in-flight executions.
 */
export const REPLAY_REGISTRY: ReplayDomainSpec[] = [
  { domain: 'cart', workflowsPath: domainWorkflowsPath('cart') },
  { domain: 'checkout', workflowsPath: domainWorkflowsPath('checkout') },
  { domain: 'oms', workflowsPath: domainWorkflowsPath('oms') },
];

/** Resolve the `__histories__/` directory for a domain spec (next to its `workflows.ts`). */
export function historiesDir(spec: ReplayDomainSpec): string {
  return path.join(path.dirname(spec.workflowsPath), '__histories__');
}
