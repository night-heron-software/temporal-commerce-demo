# ADR-0001 — Cassandra + Elasticsearch + Temporal as the core triad (CQRS)

- **Status:** Accepted
- **Date:** 2026-06-30 (retroactively recorded)
- **Deciders:** platform architecture (foundational)
- **Tags:** data-layer, temporal, cqrs
- **Provenance:** duplicated from the parent platform's ADR-0001; held as close to identical as this demo's smaller surface allows.

> **Divergence from the parent platform.** The demo runs the same triad. Multi-tenancy, the accounting ledger, and supplier plugins named here are parent-platform concerns it excludes.

## Context

The platform needs to orchestrate long-running, failure-prone commerce flows (cart → checkout → order
→ fulfillment → inventory/accounting) across multiple tenants, while serving fast storefront reads
(search, faceted navigation, admin dashboards). Three concerns pull in different directions:

- **Coordination/durability:** flows span minutes to a year, cross domains, involve external suppliers
  and payment, and must survive process death without losing or double-applying work.
- **Multi-tenant writes:** high-cardinality, partition-friendly, tenant-isolated write data.
- **Rich reads:** full-text and faceted queries a normalized write store serves poorly.

No single datastore does all three well.

## Decision

We will use a **three-part core** with CQRS between the write and read stores:

- **Temporal** (TypeScript SDK) as the orchestration/durability layer — the source of truth for
  in-flight process state via its event history.
- **Apache Cassandra** as the primary **write** store — partition-keyed by `store_id` (see
  [ADR-0004](0004-multi-tenant-shared-infrastructure-store-id.md)), holding the command/write model.
- **Elasticsearch** as the **read/projection** store — search, facets, dashboards; projected from the
  write path via Temporal-mediated writes (see
  [ADR-0007](0007-workflow-mediated-projection-writes.md)).

## Consequences

- **Positive:** each store is used for what it is good at; reads scale independently of writes;
  Temporal removes hand-rolled saga/retry/idempotency machinery.
- **Negative / costs:** CQRS means eventual consistency between Cassandra and ES and a projection path
  to keep correct; three systems to run and operate; queries must respect Cassandra's partition model.
- **Follow-ups:** projection correctness is enforced by [ADR-0007](0007-workflow-mediated-projection-writes.md);
  tenant isolation by [ADR-0004](0004-multi-tenant-shared-infrastructure-store-id.md).

## Alternatives considered

- **Single relational DB (Postgres) for everything** — simplest to operate, but weak multi-tenant
  partitioning at scale and poor faceted search; would push search into a bolt-on anyway.
- **Event-sourced domain store separate from Temporal** — rejected as redundant; Temporal already
  provides the durable event history (see [ADR-0003](0003-prepare-decide-finalize-state-machines.md)).
