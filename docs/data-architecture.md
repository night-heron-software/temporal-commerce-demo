# Data Architecture for Scale

> **Status:** stub — outline in place, sections to be expanded. The topics below are partially
> covered today in the [Project Description § Data Architecture](project-description.md#data-architecture)
> and the [Developer Guide § Data Layer](developer-guide.md#data-layer).

There is no relational database in this application's data path, and that is a scalability
decision, not a stylistic one. Entity state lives in Temporal workflows; durable writes go to
Cassandra, partitioned per entity; read traffic is served by Elasticsearch projections that the
Next.js app queries directly. This guide explains the write side, the read side, and the seam
between them.

## Outline

1. **Why not a relational database** — contention eliminated by construction: no shared tables, no
   row locks, no hot rows; what workloads this trades away.
2. **The workflow is the entity** — in-flight state lives in workflow context backed by Temporal's
   event history; Cassandra holds durable records, not coordination state.
3. **Cassandra write-side modeling** — partition-per-entity key design (`cassandra/schema.cql`);
   write patterns from activities; what never gets read at request time.
4. **CQRS: the read side is Elasticsearch** — projections written by workflow activities
   (workflow-mediated writes only); index shapes for catalog, orders, and inventory.
   *(Today: [Developer Guide § Non-Blocking Projection Pattern](developer-guide.md#non-blocking-projection-pattern).)*
5. **Elasticsearch as the app's query API** — Next.js reads projections directly through
   `src/lib/es-client.ts`; no BFF, no gateway, no cache tier to invalidate.
6. **Dirty-flag batching** — the inventory singleton's
   `condition(() => dirtySkus.size > 0, CONSISTENCY_SWEEP_INTERVAL)` loop: event-driven and
   time-driven projection in one expression.
7. **Event sourcing without an event store** — Temporal history as the durable log; the
   `decide → facts → evolve` style without operating Kafka or an event store.
8. **Consistency model** — what is read-your-writes (workflow updates return state) and what is
   eventually consistent (projections); where each is acceptable and why.
