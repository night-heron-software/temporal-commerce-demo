# ADR-0005 — Single-launcher, shared `NativeConnection`, per-domain task queues

- **Status:** Accepted
- **Date:** 2026-06-30 (retroactively recorded)
- **Deciders:** platform / Temporal worker topology
- **Tags:** temporal, deployment
- **Amended (2026-08-09):** scope clarified from code-review session-005 (note N1) — the
  single-process, single-connection launcher is a **development/demo convenience only**, chosen to
  simplify debugging and demos. The settled production topology is **at least one process per
  worker domain** (`WORKER_TYPE` sharding, every queue covered by some process); the shared
  in-process `NativeConnection` is not a production goal.
- **Provenance:** duplicated from the parent platform's ADR-0005; held as close to identical as this demo's smaller surface allows.


> **Divergence from the parent platform.** The topology is the same in miniature: this demo's
> launcher (`src/temporal/worker.ts`) runs every domain worker in one process over one shared
> `NativeConnection`, one worker per domain task queue. There is no plugin registry and no
> process registry — a single `npm run dev:worker` process is the whole fleet.

## Context

Eight worker domains need to run against Temporal. The topology can range from one process hosting all
domains to a separate microservice per domain. This affects deployment complexity, connection count,
task-queue fairness, and how new domains are added.

## Decision

We will run a **single launcher process** that starts per-domain workers, all sharing **one
`NativeConnection`**, each polling its **own per-domain task queue** (`cart-queue`, `checkout-queue`,
`oms-queue`, …) plus two utility queues (`catalog-sync-queue`, `reindex-queue`). Cross-domain fairness
relies on **Temporal Task Queue Fairness** rather than process isolation.

`WORKER_TYPE=all` starts every domain; individual domains can be started alone. Adding a domain means
registering it in the launcher (`apps/workers/src/index.ts`) and giving it a task queue — no new
service.

## Consequences

- **Positive:** minimal ops (one deployable, one connection), simple local dev, straightforward domain
  addition; per-domain queues keep work isolated and independently tunable.
- **Negative / costs:** domains share a process, so a crash affects all; horizontal scaling is
  per-launcher, not per-domain (acceptable at current scale; revisit if one domain's load diverges).
- **Follow-ups:** this is the canonical topology; the alternatives (isolated microservices) are
  background, not a live menu — see [Theme 2 §P6](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/planning/temporal-patterns-theme2-plan-2026-06-30.md).

## Alternatives considered

- **One process per domain (microservices)** — better fault/scaling isolation, but more connections and
  far more deployment/ops overhead than current scale warrants. Deferred.
- **One worker, one shared queue for all domains** — loses per-domain isolation and tuning; harder to
  reason about fairness. Rejected.

## References

[Worker Orchestration](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/temporal/worker-orchestration.md)
