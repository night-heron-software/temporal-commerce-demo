# Worker Topology: From One Process to Many

> **Status:** stub — outline in place, sections to be expanded. Hosted deployment options are
> surveyed in [Deployment Options](cloud-deployment.md); the unified worker is described in
> [Project Description § Unified Worker Architecture](project-description.md#unified-worker-architecture)
> and [Developer Guide § Unified Worker](developer-guide.md#unified-worker). The autoscaling
> landscape behind items 4–6 (backlog signals, worker pools, Temporal Serverless Workers) is
> analyzed in [Autoscaling by Push and by Pull](push-vs-pull-autoscaling.md).

In development, all six domain workers run in a single Node.js process over one gRPC connection,
each polling its own task queue (`src/temporal/worker.ts`) — one thing to start, restart, and read
logs from. The same unified process is also the pragmatic first *hosted* shape
([Deployment Options](cloud-deployment.md), Option B: one always-on container running all six
domains). The split topology — one worker type per process, with as many processes per queue as
its load demands — is what the architecture is shaped for when load arrives: because the task
queues were separate all along, moving from the unified process to the split one is a deployment
change, not a refactor. This guide covers both shapes and the path between them.

## Outline

1. **The development topology** — the unified launcher, one gRPC connection, six task queues; why
   task-queue isolation already prevents a slow fulfillment activity from starving cart updates.
2. **The production topology** — one worker per process; multiple processes per queue; Temporal's
   task queues as the load balancer; no code changes required.
3. **Splitting the launcher** — running a single domain's worker from the shared entry point;
   container image layout (`deploy/worker.Dockerfile`).
4. **Sizing and tuning** — poller counts, max concurrent activities/workflow tasks, when to scale
   out vs. up; reading task-queue backlog as the scaling signal.
5. **Hosting the workers** — the two constraints that follow a poller anywhere (it cannot scale to
   zero; a throttled CPU stops it polling), and why serverless push is the preferred escape from
   both; option-by-option treatment in [Deployment Options](cloud-deployment.md).
6. **What changes on Temporal Cloud** — mTLS, namespaces, search-attribute registration; what stays
   identical between local Temporal and Temporal Cloud.
