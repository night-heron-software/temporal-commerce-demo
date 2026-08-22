# ADR-0004 — Multi-tenant isolation via shared infrastructure keyed by `store_id`

- **Status:** Accepted
- **Date:** 2026-06-30 (retroactively recorded)
- **Deciders:** platform architecture
- **Tags:** multi-tenancy, data-layer
- **Provenance:** duplicated from the parent platform's ADR-0004; held as close to identical as this demo's smaller surface allows.

> **Divergence from the parent platform.** This demo is **single-tenant**: `storeId` is the fixed `DEMO_STORE_ID` (`demo`) and no tenant isolation is exercised. The record is carried because the parent's partition keys and store-scoping conventions are visible throughout this codebase and its reasoning explains them.

## Context

The platform serves many independent storefronts from one deployment. Tenant data must be isolated so
one store can never read or mutate another's, but standing up per-tenant infrastructure (a Cassandra
keyspace, ES index, or Temporal namespace per store) would be operationally heavy and scale poorly as
stores are onboarded self-service.

## Decision

We will run **shared infrastructure** and isolate tenants by **`store_id` as the leading partition-key
component**, not by separate infrastructure per tenant:

- **Cassandra:** every tenant-scoped table has `store_id` first in the partition key; every query
  touching tenant data includes `store_id` in the `WHERE` clause. This is **architecture invariant #4**,
  backed by a runtime guard (`TENANT_QUERY_GUARD`).
- **Elasticsearch:** shared indices with a **mandatory `store_id` filter** on every query.
- **Temporal:** shared namespace; workflow IDs are store-prefixed (`{storeId}-{domain}-{entityId}` via
  `buildWorkflowId()`), relying on Task Queue Fairness rather than per-store namespaces.
- **Object storage:** shared bucket; assets are content-addressed.

Some data is deliberately **not** store-scoped: the global inventory pool (reservations carry
`store_id`) and platform-global fulfiller/blank definitions.

> **Amended by [ADR-0016](0016-inventory-write-path-integrity.md).** The global pool remains, but
> its sharpest cross-tenant edge is closed: preemption is expiry-only, so one store's reserve can
> no longer evict another store's live hold. Store-scoped stock keys remain a deferred lever.

## Consequences

- **Positive:** cheap, fast tenant onboarding (no infra provisioning per store); one system to operate,
  scale, and back up; isolation is a mechanical, enforceable rule.
- **Negative / costs:** isolation depends on discipline — a query missing `store_id` is a cross-tenant
  leak, which is why it is a lint/runtime-guarded invariant, not a convention; noisy-neighbor effects
  are managed by partitioning + Task Queue Fairness rather than hard separation.
- **Follow-ups:** per-store Temporal namespaces and per-store ES indices are explicitly **deferred**
  (the roadmap's Deferred section) — Task Queue Fairness and the `store_id` filter are sufficient.

## Alternatives considered

- **Per-tenant keyspace / index / namespace** — strong isolation but heavy provisioning and poor
  self-service scaling. Deferred, not adopted.
- **Row-level `store_id` without partition-key leadership** — would allow accidental cross-tenant scans
  and defeat Cassandra's data locality. Rejected.

## References

Multi-Tenant Platform Architecture (parent platform) ·
[`AGENTS.md` invariant #4](../../AGENTS.md#architecture-invariants-must-follow)
