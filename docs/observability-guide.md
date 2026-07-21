# Observability Guide

Everything in this guide is gated behind a single flag: `OTEL_ENABLED=true` in `.env.local`. With
it off (the default), the tracing code paths are complete no-ops — no SDK is loaded, no exporter
connections are attempted, and the observability containers never start.

> **Status note.** The tracing half of this stack (Jaeger) is wired end to end. The metrics half
> (Prometheus → Grafana) is **not currently functional** — see
> [Known gaps](#known-gaps) before you rely on it.

---

## Turning it on

`OTEL_ENABLED` does double duty — it is read by shell scripts at infra-start time _and_ by the
Node processes at runtime. Set it in one place:

```bash
# .env.local
OTEL_ENABLED=true
```

Then bring the stack up as usual:

```bash
npm run dev:init      # full reset, picks up the flag
# or, if infra is already provisioned:
npm run infra:up      # scripts/infra-start.sh reads OTEL_ENABLED from .env.local
npm run dev:up
```

`scripts/infra-start.sh` greps `.env.local` for the flag and, when it is `true`, swaps in the
observability compose overlay ([infra-start.sh:16-24](../scripts/infra-start.sh#L16-L24)):

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

You can also bypass the flag and start the overlay directly with `npm run infra:up:obs`, but note
this only starts the _containers_ — the Node-side tracing still keys off `OTEL_ENABLED`, so
without the env var you get a Jaeger UI with no application spans in it.

Confirm what is live:

```bash
npm run dev:status    # prints OTEL_ENABLED plus a per-service up/down table
```

---

## What comes up

| Service        | URL                    | Purpose                                                          |
| -------------- | ---------------------- | ---------------------------------------------------------------- |
| **Jaeger**     | http://localhost:16686 | Trace UI, and the OTLP collector itself                          |
| **Prometheus** | http://localhost:9090  | Metrics scraping and query                                       |
| **Grafana**    | http://localhost:3200  | Metrics dashboards (`admin` / `admin`, anonymous viewer enabled) |

Jaeger listens on two collector ports, and the split matters when you are debugging why spans are
missing:

- **4317 — OTLP gRPC.** Used by the **Temporal server** container. Configured via the `temporal`
  service override in [docker-compose.observability.yml](../docker-compose.observability.yml),
  which sets `OTEL_TRACES_EXPORTER=otlp` and points at `http://demo-jaeger:4317`.
- **4318 — OTLP HTTP.** Used by the **Node.js worker process**. Default endpoint is
  `http://localhost:4318`, overridable with `OTEL_EXPORTER_OTLP_ENDPOINT`.

Two different protocols, two different producers, one Jaeger.

---

## What actually gets traced

This is the part worth internalizing before you go hunting in the UI, because the coverage is
narrower than "OTel is on" suggests.

### Three instrumentation points

**1. The worker process — auto-instrumentation.**
[src/temporal/worker.ts:14](../src/temporal/worker.ts#L14) calls `initTracing('demo-workers')`
_before_ any other import, which is what lets the OTel Node SDK monkey-patch the libraries it
instruments. You get spans for `cassandra-driver`, `@elastic/elasticsearch`, `http`, `dns`, and
`net` for free. Filesystem and Winston instrumentation are explicitly disabled — `fs` because it
is overwhelmingly noisy, Winston because this project uses Pino and the module resolution warning
is just noise ([src/lib/tracing.ts:52-58](../src/lib/tracing.ts#L52-L58)).

**2. The Temporal client — outbound context propagation.**
[src/lib/temporal-client.ts:18-24](../src/lib/temporal-client.ts#L18-L24) installs
`OpenTelemetryWorkflowClientInterceptor` when the flag is on. This injects the active trace
context into workflow start / signal / update calls, so a trace started in a Server Action can
continue into the workflow's activities.

**3. The activity boundary — inbound spans.**
[src/lib/worker-otel.ts](../src/lib/worker-otel.ts) adds
`OpenTelemetryActivityInboundInterceptor` to the worker's `activityInbound` chain. Each activity
execution becomes a span, linked to the client-side parent.

Note that `worker-otel.ts` always registers the ADR-0010 activity-capture **workflow** interceptor
regardless of the flag — the OTel interceptor is layered into the same `interceptors` object so
neither clobbers the other. That co-location is deliberate; if you add a third interceptor, extend
that object rather than spreading a second one into `Worker.create`.

### Coverage boundaries

- **Workflow spans are not created.** Only `activityInbound` is registered. The OTel package also
  ships a workflow-side interceptor module that would need to be added to
  `interceptors.workflowModules` to get spans for workflow execution itself. Today a trace shows
  the activities a workflow ran, not the workflow as a span.
- **The Next.js app is not traced.** `initTracing` is called only from the unified worker entry
  point. Storefront page loads, API routes, and Server Actions produce no spans of their own —
  though a Server Action that starts a workflow _will_ propagate context onward through the client
  interceptor.
- **Temporal server traces are separate.** The server container exports its own spans under
  `service.name=temporal-server`. They appear alongside your application traces in Jaeger but are
  produced by an entirely different pipeline.

### Reading a trace

In Jaeger, select service **`demo-workers`** (application spans) or **`temporal-server`**. A
typical order-placement trace shows the activity spans fanned out under the client-initiated
parent, with Cassandra and Elasticsearch calls nested beneath each activity — which makes it a
good tool for the specific question _"which activity is slow, and is it slow because of the
datastore?"_

For the complementary question — _"what state transitions did this order go through?"_ — the
[Order Trace tool](/dev/order-trace) is the better instrument. It reads the ADR-0010 transition
projection rather than spans, so it works with `OTEL_ENABLED=false` and covers the workflow
topology that traces currently do not.

### Shutdown

`shutdownTracing()` runs during worker shutdown
([src/temporal/worker.ts:112](../src/temporal/worker.ts#L112)) to flush pending spans. If you
`kill -9` a worker, expect to lose the tail of its trace data.

---

## Known gaps

These are real defects in the current configuration, not caveats about how to use it. The tracing
path works; the metrics path does not.

**1. The Temporal server emits no Prometheus metrics.**
[docker-compose.yml:105](../docker-compose.yml#L105) publishes port `9464` and comments it as the
"Prometheus metrics endpoint", but the `temporalio/server` image only starts that listener when
`PROMETHEUS_ENDPOINT` is set — and it is set nowhere in the repo. Verified against the running
container: nothing is listening on `9464`.

**2. Prometheus scrapes the wrong port.**
[observability/prometheus.yml:8](../observability/prometheus.yml#L8) targets `temporal:9090`. Port
`9090` is Prometheus's own port, not Temporal's metrics port. Even once gap 1 is fixed, this
target would need to be `temporal:9464`. Expect the `temporal-server` job to show as **DOWN** in
http://localhost:9090/targets.

**3. Grafana has no dashboards.**
The provisioning path
[observability/grafana/provisioning/dashboards/json/](../observability/grafana/provisioning/dashboards/json/)
contains only a `.gitkeep`. Grafana starts with the Prometheus datasource wired up correctly and
an empty "Temporal Commerce Demo" folder.

**4. No application metrics at all.**
Only the Temporal server is a scrape target. Worker metrics (task-queue latency, activity
failures) and Next.js metrics are neither exported nor scraped.

Fixing 1 and 2 is a two-line change and would make Grafana useful immediately with a community
Temporal dashboard. Until then, treat Prometheus and Grafana as scaffolding.

---

## Troubleshooting

| Symptom                                    | Likely cause                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Jaeger UI loads, no `demo-workers` service | `OTEL_ENABLED` not set in the **worker's** environment — containers are up but Node tracing is off. Restart workers after changing `.env.local`. |
| No `temporal-server` service in Jaeger     | Stack started without the observability overlay, so the OTEL env override never applied to the `temporal` service.                               |
| Spans stop at the activity boundary        | Expected — workflow spans are not instrumented. See [Coverage boundaries](#coverage-boundaries).                                                 |
| Prometheus target DOWN                     | Expected — see [Known gaps](#known-gaps) 1 and 2.                                                                                                |
| Partial traces after a crash               | `shutdownTracing()` never ran; spans buffered in the exporter were lost.                                                                         |

```bash
# Container logs for the observability services
docker compose -f docker-compose.yml -f docker-compose.observability.yml logs -f jaeger
```

Remember that workers do not hot-reload workflow code — and they do not re-read `.env.local`
either. Any change to `OTEL_ENABLED` requires a worker restart.
