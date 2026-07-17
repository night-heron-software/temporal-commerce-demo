# Autoscaling by Push and by Pull: App Engine, Cloud Run, and Temporal Workers

*This document was drafted with AI assistance.*

Two architectures answer the question "who notices new work?" differently. In a **push** model, the
platform observes demand — a queue of pending HTTP requests, a concurrency target — and creates
compute to meet it (Google App Engine's scheduler, Cloud Run services). In a **pull** model, the
compute observes demand itself, by long-polling a task queue (a Temporal worker). This note examines
the operational consequences of that split, tests a working hypothesis against the evidence, and
evaluates where Temporal's new **Serverless Workers** feature lands between the two.

> **The hypothesis under examination.** Push-style autoscaling is easier to manage and has the
> advantage of scaling to zero, whereas implementing stickiness is more straightforward with
> pull-style. Verdict up front: the stickiness half is **supported**; the scale-to-zero half is
> **supported for request-shaped work but qualified for background work** — and Temporal Serverless
> Workers is the deliberate hybrid that trades the pull model's stickiness advantage for the push
> model's scale-from-zero ergonomics (§6).

This note is a companion to the [GAE paved-path analysis](google-app-engine-paved-path.md) — it
resolves that note's "the worker needs somewhere durable to run" thread (§6.5 there) — and to the
[Worker Topology guide](worker-scaling.md) and [Cloud Deployment](cloud-deployment.md), which cover
this project's concrete worker shapes.

---

## 1. The Push Model: the Platform Owns the Demand Signal

### 1.1. App Engine: the pending request queue

GAE's scheduler watches each instance's **pending request queue**. Queue fullness — not CPU —
triggers new instance creation. The operator's dials are
[`min_pending_latency` / `max_pending_latency`](https://docs.cloud.google.com/appengine/docs/standard/how-instances-are-managed)
(how long a request may wait before a new instance spins up) and `min_idle_instances` /
`max_idle_instances` (pre-warmed headroom against spikes). Three modes — **automatic** (request
rate + latency driven), **basic** (instance per burst, shut down when idle), **manual** (fixed
count, for in-memory state) — and on the standard environment, automatic scaling goes **to zero**
when traffic stops.

### 1.2. Cloud Run services: concurrency-target scaling

Cloud Run services scale on
[request concurrency and CPU utilization, targeting ~60% of both](https://docs.cloud.google.com/run/docs/about-instance-autoscaling):
instances ≈ average concurrent requests ÷ (max concurrency × target). No traffic → **zero
instances** by default; `min-instances` buys warm capacity against cold starts; idle instances are
reclaimed within ~15 minutes. Billing has two modes —
[request-based (CPU throttled to near-zero between requests) and instance-based (CPU always allocated)](https://docs.cloud.google.com/run/docs/configuring/billing-settings)
— a distinction that becomes decisive for pull workloads (§4.2).

### 1.3. Why this is easy to manage

The platform owns the demand signal end to end: it sees every request *before* the application
does, so scaling is a closed loop with no application involvement. The operator configures a target
(latency or concurrency) and a floor/ceiling — nothing else. There is no scaler to deploy, no
metric to export, no capacity math. For request-shaped work, this half of the hypothesis is simply
true.

---

## 2. The Pull Model: the Worker Owns the Demand Signal

### 2.1. The mechanics

A Temporal worker long-polls its task queues over gRPC and executes what it receives. This project
runs one worker per domain on per-domain task queues (see the
[Worker Topology guide](worker-scaling.md)) — one process in development, one worker per process in
production, N processes per queue as load demands. The topology is a deployment choice, not a code
change.

### 2.2. The scaling signals

The demand signal lives in the task queue, and [Temporal's guidance](https://docs.temporal.io/develop/worker-performance)
names the metrics to scale on:

| Signal | Metric | Meaning |
|:---|:---|:---|
| Task wait time | `workflow_task_schedule_to_start_latency`, `activity_schedule_to_start_latency` | The primary signal: rising values mean tasks are queueing for capacity |
| Backlog | `ApproximateBacklogCount`, `BacklogIncreaseRate` | Absolute queue depth and its growth rate |
| Saturation | `temporal_worker_task_slots_available` | Near zero = the worker is full |
| Ingestion health | poll success rate | Target >90% (>95% high-volume/low-latency) |

This is the same *kind* of signal GAE scaled on — queue depth — but ownership is inverted: the
platform exposes the metric, and **someone else must act on it**.

### 2.3. What acts on the signal

*Within* a worker process, Temporal now automates a lot:
[auto-scaling pollers](https://docs.temporal.io/develop/worker-performance)
(`PollerBehaviorAutoscaling`, server ≥ 1.28) adjust poller counts, and the
[Worker Tuner's resource-based slot suppliers](https://docs.temporal.io/develop/worker-tuning-reference)
adjust concurrent-task slots toward CPU/memory targets.

*Across* processes, scaling still requires an external actor:

- **Kubernetes:** the [official KEDA Temporal scaler](https://temporal.io/blog/announcing-keda-based-auto-scaling-for-temporal-workers)
  (built into [KEDA v2.17](https://keda.sh/docs/2.20/scalers/temporal/)) scales deployments on
  task-queue backlog, including to zero.
- **Cloud Run:** [Worker Pools](https://cloud.google.com/blog/products/serverless/exploring-cloud-run-worker-pools-and-kafka-autoscaler)
  (GA ~April 2026) are the industry conceding that pull workloads need their own resource type —
  continuous, non-HTTP, no load balancer, no inbound port. But note what they do natively:
  [**manual scaling only**](https://docs.cloud.google.com/run/docs/configuring/workerpools/manual-scaling).
  Autoscaling is a bolt-on —
  [CREMA](https://docs.cloud.google.com/run/docs/configuring/workerpools/crema-autoscaling)
  (Cloud Run External Metrics Autoscaling, KEDA-based) or equivalent recipes.

The management burden asymmetry is real: the pull model turns "configure a latency target" into
"deploy and operate a scaler that watches queue metrics." That is the substance behind "push is
easier to manage."

---

## 3. Stickiness: Where Pull Wins

### 3.1. Sticky execution — affinity as a consequence of polling

Temporal's [Sticky Execution](https://docs.temporal.io/sticky-execution) is on by default (workflow
tasks only). After a worker first executes a workflow's task, it keeps the workflow's state in an
in-memory cache and **polls a worker-specific sticky queue**; the service routes that workflow's
subsequent tasks there, skipping replay-from-history. The affinity mechanism *is* the poll: the
worker that owns the cache advertises for more of that workflow's work by polling its own private
queue. No router has to be told anything.

The failure semantics are first-class, not best-effort: if the sticky task isn't picked up within
the sticky schedule-to-start timeout (≈5 s in the
[docs' prose](https://docs.temporal.io/sticky-execution); the SDK option
`stickyQueueScheduleToStartTimeout` defaults to 10 s — confirm against your SDK), the task falls
back to the shared queue and **any** worker can run it, paying one replay. Cache capacity is a
dial (`maxCachedWorkflows`, default 10,000); worker death degrades to replay, never to loss.
Notably, this project's workers run entirely on these defaults — no sticky or cache tuning
anywhere in `src/temporal/` — and get correct affinity behavior for free.

### 3.2. Cloud Run session affinity — a router hint

Cloud Run's [session affinity](https://docs.cloud.google.com/run/docs/configuring/session-affinity)
is explicitly **"best effort"**: affinity breaks when an instance terminates, hits max concurrency,
or hits CPU limits, and Google's docs state plainly that "you cannot assume that a client will
always reconnect to the same instance." It is an optimization hint at the front-end router, with
no defined fallback semantics — the application must tolerate arbitrary re-routing anyway, which
means externalizing the very state the affinity was meant to keep warm.

### 3.3. Verdict

**Hypothesis supported.** In the pull model, stickiness is a structural consequence of the
mechanism (routing follows the poller, with defined degradation to replay). In the push model,
affinity fights the architecture — the whole point of push scaling is that any instance can take
any request — so it is offered only as a best-effort hint. GAE went further and made the lesson
explicit: statelessness was the constraint, and in-memory affinity was simply unsupported.

---

## 4. Scale-to-Zero: Where Push Wins — With an Asterisk

### 4.1. The clean push story

For request-shaped work, push platforms scale to zero natively because the platform sees demand
before any application compute needs to exist: the arriving request *is* the wake-up signal. GAE
standard and Cloud Run services both do this with zero extra components.

### 4.2. The asterisk: queue consumers get no help

A **pull worker scaled to zero has no poller left to notice new work.** Something external must
watch the queue and reanimate it:

- On a Cloud Run **service**, a Temporal worker must be kept alive artificially —
  instance-based billing (always-allocated CPU) plus `min-instances ≥ 1` — and then it *cannot*
  scale to zero. This project's documented worker deployment is exactly this shape:
  `--min-instances 1 --no-cpu-throttling` ([Cloud Deployment](cloud-deployment.md), Step 4).
- Cloud Run **worker pools** scale manually unless paired with CREMA/KEDA — and the scaler itself
  is always-on, so "scale to zero" applies to the workers, never the whole control plane.
- The KEDA route works but is fiddly at the zero boundary: the scaler's own docs warn that
  [activation based on backlog is unreliable near zero](https://keda.sh/docs/2.20/scalers/temporal/)
  (backlog metrics don't see in-flight tasks), and there is a documented case of
  [workers being scaled to zero mid-task](https://github.com/kedacore/keda/issues/7368).

### 4.3. Verdict

**Hypothesis supported, with a sharpened claim.** Scale-to-zero is not a property of push
*per se* — it is a property of **platform-visible demand signals**. Push platforms scale request
work to zero because they own the signal; the moment the workload is a queue consumer, push
platforms are no better off than anyone else, and both worlds reach for the same fix: an external
component that watches queue depth. The honest comparison is therefore not "push vs pull" but
"whose demand signal does the scaler see, and who has to run the scaler."

---

## 5. Latency: the Cost of Zero

Scale-to-zero converts idle cost into first-request latency. In GAE this was the **loading
request**; in Cloud Run it is the cold start that `min-instances` exists to price out. For this
project the exposure is concentrated by the interaction model: interactive mutations go through
workflow updates via `executeUpdateWithStart` (see
[Temporal Lessons Learned](temporal-lessons-learned.md)), expecting validated state back **in one
round trip** — a cold-started worker pays its startup inline in a user-facing response. This is
why per-domain scaling policy matters (§8): the same platform can hold cart/checkout at min-1 and
let batch domains fall to zero.

---

## 6. Temporal Serverless Workers: Push-Triggered Pull

The feature the hypothesis ultimately asks about.
[Announced at Replay 2026](https://temporal.io/blog/replay-2026-product-announcements) (May 5–7)
and currently **pre-release**,
[Serverless Workers](https://docs.temporal.io/serverless-workers) let Temporal Cloud invoke worker
compute on demand instead of requiring an always-on poller fleet.

### 6.1. Mechanics

- A **Worker Controller Instance (WCI)** — a background workflow in Temporal Cloud — watches two
  triggers: **sync-match failure** (a task arrived and no worker was immediately available) and
  **task-queue backlog** (pending tasks exceed capacity). Either fires a scaling action.
- The scaling action is a **push**: Temporal assumes a cross-account IAM role and calls AWS
  Lambda's `InvokeFunction` against worker code deployed **in your account**
  ([launch blog](https://temporal.io/blog/introducing-temporal-serverless-workers-deploy-temporal-workers-to-aws-lambda)).
- The invoked function then **pulls**: it starts a short-lived worker that polls the task queue,
  drains available tasks, and shuts down gracefully before the invocation deadline. Then: zero.

So the model is precisely a **push-triggered ephemeral poller** — Temporal converts its own pull
architecture's demand signal into a push at the compute boundary, playing the role GAE's scheduler
played for request queues and Cloud Tasks played for push queues.

### 6.2. Compared to the App Engine / Cloud Run push models

| Dimension | GAE / Cloud Run services (push) | Serverless Workers (push-triggered pull) |
|:---|:---|:---|
| Demand signal owner | Platform (pending requests / concurrency) | Temporal Cloud (sync-match + backlog) |
| Compute owner | Platform-managed instances | Your cloud account (Lambda; Cloud Run "coming soon") |
| Unit of scale | Instance serving many requests | Invocation draining a task burst |
| Idle cost | Zero (or min-instances floor) | Zero — no poller fleet, no external scaler |
| Scaler to operate | None | None (the WCI is Temporal's) |
| Work-duration bound | Request deadline (60 s GAE frontend) | Provider invocation limit (15 min Lambda) minus shutdown buffer |
| Versioning | Platform versions/revisions | [Worker Versioning is mandatory](https://docs.temporal.io/serverless-workers) (Pinned/AutoUpgrade, versioned ARNs) |

The management-burden claim of the hypothesis transfers cleanly: like GAE, there are "no
autoscaling policies to configure, no clusters to monitor." The pull world's one operational
weakness — running the scaler — is absorbed by Temporal Cloud.

### 6.3. What it gives up — the stickiness trade

Here the two halves of the hypothesis collide. An ephemeral worker that exits after each burst
**discards its sticky cache by construction**, so the next invocation replays affected workflows
from history. Temporal has **not published** how sticky execution behaves under Serverless Workers
— treat the replay-cost expectation as inference, not documented fact. Also unpublished as of this
writing: **pricing** (framed conceptually as pay-per-invocation, plus your own Lambda bill) and
**cold-start characteristics** (the sync-match trigger is designed to react immediately, but
Lambda cold start + worker init is unquantified). Verified SDK support: Go, Python, TypeScript.

For this project's architecture the trade is unusually cheap: the prepare/decide/finalize pattern
carries nothing in-process between tasks, workflow state lives in Temporal, and activities are
short — far inside the invocation limit. The sticky cache is a throughput optimization here, not a
correctness dependency — and the transition-recording projection behind the
[Order Trace tool](developer-guide.md#state-transition-recording--order-trace) means observability
doesn't depend on worker locality either.

---

## 7. The Comparison, Assembled

| | GAE standard | Cloud Run service | Cloud Run worker pool (+ CREMA) | Self-managed Temporal workers | Temporal Serverless Workers |
|:---|:---|:---|:---|:---|:---|
| Model | Push | Push | Pull, externally scaled | Pull | Push-triggered pull |
| Demand signal | Pending request queue | Request concurrency | Task-queue backlog (via KEDA) | Task-queue backlog / schedule-to-start | Sync-match failure + backlog |
| Scale to zero (request work) | ✅ native | ✅ native | n/a | n/a | n/a |
| Scale to zero (queue work) | ❌ (no queue visibility) | ❌ needs always-CPU + min-1 | ✅ but scaler always-on, in-flight blind spot | ✅ only via KEDA (same caveats) | ✅ native to the feature |
| Stickiness | ❌ unsupported by design | ⚠️ best-effort session affinity | ✅ sticky queues (while instance lives) | ✅ sticky queues, defined fallback | ⚠️ cache discarded per invocation (inference — undocumented) |
| You operate | Latency/idle dials | Concurrency/min/max dials | Worker pool + CREMA + OTel sidecar | Workers + scaler + capacity math | Function deployment + IAM role |
| Status | GA (two decades) | GA | Worker pools GA ~2026-04; CREMA documented recipe | GA | **Pre-release**, Lambda only, Cloud Run coming |

---

## 8. Implications for This Project

1. **Per-domain scaling policy is the reconciliation.** The per-domain task queues (see the
   [Worker Topology guide](worker-scaling.md)) let latency-sensitive domains (cart, checkout —
   where the update round trip makes cold starts user-visible) hold a min-1 floor while spiky
   domains (fulfillment, OMS fan-out) scale to zero. The push/pull choice can differ per domain.
2. **Current state is deliberately boring.** The documented Cloud Run worker is an always-on
   Service (`--min-instances 1 --no-cpu-throttling`, [Cloud Deployment](cloud-deployment.md)) that
   does not scale to zero — prove the boring shape first, then evolve.
3. **The pull route on GCP is real today** (worker pools + CREMA on backlog metrics); **the push
   route is worth waiting to evaluate** — Serverless Workers is pre-release, Lambda-first, with the
   Cloud Run provider "coming soon," and its pricing and sticky-cache behavior are still
   unpublished. The evaluation criteria when it lands: cold-start cost inline in update latency,
   replay overhead without a sticky cache at this project's history sizes, and whether per-domain
   min-floors are expressible.
4. **Nothing in the code has to move.** Both routes consume the same workers on the same queues —
   the reason "the topology is a deployment choice" was worth enforcing all along.

---

## References and Sources

### Temporal Serverless Workers

| Source | Description |
|:---|:---|
| [Serverless Workers documentation](https://docs.temporal.io/serverless-workers) | Official docs: Worker Controller Instance, sync-match/backlog triggers, mandatory Worker Versioning, invocation-limit bound, pre-release status. |
| [Introducing Temporal Serverless Workers](https://temporal.io/blog/introducing-temporal-serverless-workers-deploy-temporal-workers-to-aws-lambda) | Launch blog: cross-account Lambda invocation model, 3-step setup, drain-and-shutdown lifecycle, Cloud Run "coming soon." |
| [Replay 2026 product announcements](https://temporal.io/blog/replay-2026-product-announcements) | Conference announcement context; Worker Versioning GA; positioning for bursty/event-driven workloads. |

### Temporal worker scaling and stickiness (pull model)

| Source | Description |
|:---|:---|
| [Worker performance guide](https://docs.temporal.io/develop/worker-performance) | The scaling signals (schedule-to-start latency, backlog count/rate, slot availability, poll success), poller autoscaling behavior, cache/eviction mechanics, graceful-shutdown guidance. |
| [Worker tuning quick reference](https://docs.temporal.io/develop/worker-tuning-reference) | Worker Tuner and fixed/resource-based/custom slot suppliers. |
| [Sticky Execution](https://docs.temporal.io/sticky-execution) | Sticky queue mechanics, schedule-to-start fallback, cache invalidation on failure. |
| [KEDA-based autoscaling for Temporal workers](https://temporal.io/blog/announcing-keda-based-auto-scaling-for-temporal-workers) | The official external-scaler route (KEDA v2.17+). |
| [KEDA Temporal scaler docs](https://keda.sh/docs/2.20/scalers/temporal/) | Configuration; the activation-near-zero reliability warning. |
| [kedacore/keda#7368](https://github.com/kedacore/keda/issues/7368) | Documented scale-to-zero blind spot: workers scaled down with tasks in flight. |

### Cloud Run

| Source | Description |
|:---|:---|
| [About instance autoscaling](https://docs.cloud.google.com/run/docs/about-instance-autoscaling) | Concurrency/CPU-target scaling, scale-to-zero, min/max instances, idle reclamation, cold-start queueing. |
| [Billing settings (CPU allocation)](https://docs.cloud.google.com/run/docs/configuring/billing-settings) | Request-based vs instance-based billing — why pollers need always-allocated CPU. |
| [Session affinity](https://docs.cloud.google.com/run/docs/configuring/session-affinity) | The best-effort affinity contract and its break conditions. |
| [Worker pools: manual scaling](https://docs.cloud.google.com/run/docs/configuring/workerpools/manual-scaling) | Worker pools scale manually natively; min 0 means "won't start." |
| [CREMA autoscaling for worker pools](https://docs.cloud.google.com/run/docs/configuring/workerpools/crema-autoscaling) | The KEDA-based external-metrics autoscaling recipe. |
| [Exploring Cloud Run worker pools](https://cloud.google.com/blog/products/serverless/exploring-cloud-run-worker-pools-and-kafka-autoscaler) | The pull-shaped resource type; queue lag as the "true demand" signal; Kafka autoscaler. |
| [Deploying Temporal workers to Google Cloud Run](https://temporal.io/blog/deploying-temporal-workers-to-google-cloud-run) | Temporal's own worker-pool guidance. |

### Google App Engine (push model)

| Source | Description |
|:---|:---|
| [How instances are managed](https://docs.cloud.google.com/appengine/docs/standard/how-instances-are-managed) | Automatic/basic/manual scaling, pending-latency and idle-instance dials, scale-to-zero on standard. |
| [GAE paved-path analysis](google-app-engine-paved-path.md) | The companion note: the scheduler mechanics (§2.6) and the scaling-signal lineage (§6.2) this note extends. |

### In-repo anchors

| Source | Description |
|:---|:---|
| [Worker Topology guide](worker-scaling.md) | Per-domain task queues; topology as a deployment choice. |
| [Cloud Deployment](cloud-deployment.md) | The current always-on Cloud Run Service worker configuration. |
| [Temporal Lessons Learned](temporal-lessons-learned.md) | The updateWithStart interaction model that makes cold starts user-visible for cart/checkout. |
