# ADR-0007 — Workflow-mediated projection writes as a hard gate

- **Status:** Accepted
- **Date:** 2026-06-30 (retroactively recorded)
- **Deciders:** platform / CQRS + data integrity
- **Tags:** cqrs, data-layer
- **Provenance:** duplicated from the parent platform's ADR-0007; held as close to identical as this demo's smaller surface allows.
- **Amended by:** [ADR-0023](0023-async-projections-via-projection-service.md) (2026-08-06) — the
  mediation stays and tightens (the writer set narrows from "workflows" to the per-store
  projection service, lint-enforced), but the synchronous in-window write — and with it strict
  read-your-writes — is replaced by async dispatch with bounded lag.

## Context

Under CQRS ([ADR-0001](0001-cassandra-elasticsearch-temporal-core-triad.md)), read/projection stores
(Elasticsearch, and Cassandra read tables) are derived from the write path. When storefront/API code
writes projections **directly**, those writes bypass Temporal's durability and retry, drift from the
write model, and are invisible to replay — a data-integrity hazard. The storefront historically had 54
such direct projection writes.

## Decision

We will require **all projection writes to go through Temporal workflows/activities** — never directly
from storefront/API code. This is enforced as a **zero-tolerance hard lint gate** (`no-projection-writes`):
storefront direct projection writes were driven from 54 to 0, and even developer tooling (e.g. the ES
reindex) runs behind a workflow (`reindex-queue`).

## Consequences

- **Positive:** projections inherit Temporal's durability, retry, and idempotency; the write→read path
  is uniform and auditable; regressions are caught at lint time, not in production drift.
- **Negative / costs:** a projection update requires a workflow/activity round-trip rather than an
  inline write — more indirection for the simple case, accepted for the integrity guarantee. The gate's
  **detection has known gaps** (multi-char `UPDATE`, raw `cassandra.execute()`, non-`esClient`-named ES
  writes; `apply-mappings` writes through a gap) — tracked as High technical debt.
- **Follow-ups:** harden gate detection and migrate the remaining gap (`apply-mappings`), and
  runtime-verify the reindex — WMW phase 2 (parent platform) /
  Theme 5 §P5 (parent platform).

## Alternatives considered

- **Direct projection writes with review discipline** — the prior state; drifted and was unenforceable.
  Rejected.
- **A runtime-only guard** — catches violations late (in an environment), not at author time; the lint
  gate fails fast. Kept lint as the primary gate.

## References

Workflow-Mediated Writes — Phase 2 Plan (parent platform)
