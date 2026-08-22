# ADR-0023 — Async projections via per-store projection-service workflows

- **Status:** Accepted (2026-08-06, on the run-010 flip gate)
- **Date:** 2026-08-06
- **Deciders:** platform operator + code-review session 002 (notes N1/N2); design detail in the
  implementation plan (parent platform)
- **Tags:** cqrs, data-layer, temporal, projections, observability
- **Provenance:** duplicated from the parent platform's ADR-0023; held as close to identical as this demo's smaller surface allows.
- **Amends:** [ADR-0007](0007-workflow-mediated-projection-writes.md) (workflow-mediated writes —
  the mediation stays and tightens; the synchronous in-window guarantee goes) ·
  [ADR-0020](0020-projection-lifecycle-marking.md) (the close-time mark's ordering now spans two
  workflows). Builds on [ADR-0010](0010-async-transition-recording-projection.md) (the async-sink
  precedent) and [ADR-0011](0011-workflow-id-and-correlation-tagging.md) (service identity).

> **Divergence from the parent platform.** **Not implemented in this demo.** Projections are written inline by workflow activities ([ADR-0007](0007-workflow-mediated-projection-writes.md)); there is no projection-service workflow. Carried because ADR-0020 and ADR-0026 reference it.

## Context

Every domain workflow writes Elasticsearch inside the interactive blocking window: the driver
awaits `onTransition` — where the projection write lives — before releasing the update response.
That bought read-your-writes (ADR-0007's era), but three facts have since eroded the bargain:

1. **The hot path doesn't read the index.** Interactive state is served live from workflows
   (cart/checkout redesign §7.5); the `carts` index serves admin and dev surfaces only. The
   synchronous write pays latency in front of a shopper to guarantee freshness for readers who
   don't need it. Only the order surfaces ("my orders", the admin list) read ES on a path a
   shopper notices.
2. **Failure is a swallow, not a signal.** The driver logs and continues when the write fails
   (backlog #48): the update succeeds, the projection goes silently stale, and "RYW held" is
   indistinguishable from "RYW silently didn't" — the exact defect shape this repo's validation
   history keeps finding.
3. **The cost is bounded but real**: single-digit ms per mutation after the local-activity
   conversion (#38), but up to the 5-second close timeout when ES misbehaves — paid inside the
   shopper's wait.

The repo already contains both halves of the alternative, proven: the transition recorder's
non-blocking record/flush/drain sink (ADR-0010), and `inventoryServiceWorkflow` + its
fire-and-forget `signalInventoryChanged` nudge. The inventory model's two specifics — it is
**dirty-mark-and-pull** (the signal is a freshness nudge; a sweep re-projects from source) and a
**platform singleton** — were examined rather than inherited: pull cannot reach a closed workflow
(24h namespace retention), and ledger R11 documented the singleton's silent blast radius.

## Decision

We will move **every ES projection write** out of the interactive window into dedicated
**per-store projection-service workflows** (`{storeId}.projection.service`, per ADR-0011), and
tighten ADR-0007's writer set from "workflows" to **exactly one workflow type** (plus the reindex
worker and the named dev exemptions).

Specifics:

1. **Hybrid event model.** For live workflows, domains send a fire-and-forget **dirty nudge**
   (`{index, docId, workflowId}`); the service **pulls** the current state via the owning domain's
   query and rebuilds the document — ordering self-heals because the latest state always wins.
   Terminal and cancellation flushes are **pushes** carrying the built document and its
   driver-supplied `at`, because a closed workflow cannot be queried; the service rejects a push
   older than the stored document's `updatedAt` (the deterministic `at` stamp is the staleness
   guard).
2. **Per-store sharding**, not a singleton. One service per store bounds the blast radius and the
   history growth; `signalWithStart` from the first nudge means no provisioning step.
3. **Failure is pipeline state.** Retries with the tolerated/retryable taxonomy
   (doc-missing/index-missing continue; the rest retry); exhaustion writes a queryable
   `projection_dead_letter` document and an ERROR log line. Queue depth and lag are metrics.
4. **ADR-0020's ordering survives across workflows:** the domain's terminal push is acknowledged
   before the driver schedules the completion mark, preserving "the final re-index cannot
   overwrite the mark."
5. **Read-your-writes is explicitly narrowed** to surfaces that need it: order-facing UI gets a
   bounded-lag mitigation (refresh nudge or short poll — locked in the plan's design review);
   everything else accepts eventual consistency with a stated bound (one flush interval).

Rollout ran `off | shadow | on` per the plan (parent platform)
§7: shadow mode's live smoke caught (and fixed, via partial `doc_as_upsert` writes) the
lifecycle-mark race, and validation run 010 (parent platform)
executed the full walkthrough at `on` as the flip gate — sole-writer parity held across
ES/Temporal/Cassandra, the `at` chain matched to the millisecond, and latency stayed at the #38
baseline. The Phase 3 flip then deleted the flag and the synchronous paths outright, and the
single-writer lint rule (`@nightheron/eslint-config` invariant (h)) now enforces the writer set;
ADR-0007 carries the amendment annotation.

### Rollout note — deploys that touch workflow-side projection calls (run-010 Defect #1)

Renaming or re-shaping an **activity call made from workflow code** (as Phase 1 did:
`indexCart` → `projectCart` in `onTransition`) is a nondeterministic change for every in-flight
workflow: on replay, the recorded marker no longer matches the generated command
(`Activity type of recorded marker 'indexCart' does not match local activity command
'projectCart'`), and the workflow task fails permanently. Run 010 hit exactly this with a cart
started before the deploy. The rule: **drain or version.** Either confirm no in-flight workflows
of the affected type exist before deploying (`pnpm ops:stale` — the -011 walkthrough's pre-run
check), or gate the change with Temporal's `patched()` API so old histories replay the old code
path. Activity-side (impl-only) changes are exempt — that is precisely why the rollout flag was
read node-side only.

## Consequences

- **Positive:** the interactive window sheds its last I/O (and its 5s worst case); projection
  failure becomes observable (queue depth, dead letters) instead of swallowed — #48 dissolves;
  the projection-write lint gate tightens from pattern-matching many call sites to enforcing one
  writer; batching and coalescing across a store's traffic become possible; domain workflows can
  close without racing their final flush (signals are recorded, exactly-once).
- **Negative / costs:** order surfaces trade strict RYW for bounded lag plus a UI mitigation; a
  new always-running workflow per store to operate and monitor; cross-workflow ordering (terminal
  push → completion mark) is an invariant that needs its own test rather than falling out of one
  driver's sequencing; migration touches every domain's projection call sites.
- **Follow-ups:** the four locked decisions and phase gates live in the
  implementation plan (parent platform); `ops:stale` and
  a validation-walkthrough amendment must cover the services **before** Phase 2 (the R11 lesson:
  a dead projection service must be loud); framework-facing semantics notes sync to
  `nightheron-state-machine-go`.

## Alternatives considered

- **Keep synchronous writes, fix only the swallow (#48 alone):** surfaces the failure but keeps
  ES in the shopper's window and the many-writer gate; treats the symptom.
- **Per-workflow async sink (transition-recorder shape in every domain):** removes the window
  cost but leaves failure handling and observability scattered per-workflow, and the writer set
  stays "every workflow" — no single place to ask "is projection healthy?".
- **Platform-singleton service (the literal inventory model):** simplest identity, but R11 showed
  the failure mode — one silent workflow degrading every store's surfaces unnoticed; rejected for
  tenant-scoped projections.
- **Pull-only (pure dirty-marking):** cleanest ordering story, but cannot project a workflow's
  terminal state after it closes under 24h retention; rejected as the sole mechanism, kept as the
  live-update half of the hybrid.
