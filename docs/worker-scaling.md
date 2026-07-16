# Worker Topology: From One Process to Many

> **Status:** stub — outline in place, sections to be expanded. The production deployment mechanics
> are covered today in [Cloud Deployment](cloud-deployment.md); the unified worker is described in
> [Project Description § Unified Worker Architecture](project-description.md#unified-worker-architecture)
> and [Developer Guide § Unified Worker](developer-guide.md#unified-worker).

In development, all six domain workers run in a single Node.js process over one gRPC connection,
each polling its own task queue (`src/temporal/worker.ts`) — one thing to start, restart, and read
logs from. That is a development convenience, not the production shape. In production, workers run
one per process, with as many processes per worker type as its queue's load demands. Because the
task queues were separate all along, moving between the two topologies is a deployment change, not
a refactor. This guide covers both shapes and the path between them.

## Outline

1. **The development topology** — the unified launcher, one gRPC connection, six task queues; why
   task-queue isolation already prevents a slow fulfillment activity from starving cart updates.
2. **The production topology** — one worker per process; multiple processes per queue; Temporal's
   task queues as the load balancer; no code changes required.
3. **Splitting the launcher** — running a single domain's worker from the shared entry point;
   container image layout (`deploy/worker.Dockerfile`).
4. **Sizing and tuning** — poller counts, max concurrent activities/workflow tasks, when to scale
   out vs. up; reading task-queue backlog as the scaling signal.
5. **Cloud Run specifics** — `--min-instances 1` (a poller cannot scale to zero) and
   `--no-cpu-throttling` (a throttled poller stops polling); pointers into
   [Cloud Deployment](cloud-deployment.md).
6. **What changes on Temporal Cloud** — mTLS, namespaces, search-attribute registration; what stays
   identical between local Temporal and Temporal Cloud.
