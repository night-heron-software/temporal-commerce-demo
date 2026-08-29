# ADR-0030 — Evolve workflow code with Worker Versioning, not `patched()`

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Jeff (2026-08-25, during the `-017` remediation plan's Phase 4)
- **Supersedes:** nothing. This is the first decision on the subject — the absence *was* the
  finding ([mono-backlog-070](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/reference/work-glossary/mono-backlog-070.md)).
- **Provenance:** duplicated from the parent platform's ADR-0030; held as close to identical as this demo's smaller surface allows.

> **Divergence from the parent platform.** The decision — Worker Versioning over `patched()` —
> resolves this repo's backlog #21 the way its "the mono decides first" note anticipated: the
> parent decided, proved the mechanism live on its local stack, and this repo aligns. The opt-in
> wiring exists here too (`WORKER_BUILD_ID` → `src/lib/worker-versioning.ts`, spread into every
> worker by the launcher); the parent's ECS/CD topology sections do not apply to this repo's
> single-process launcher. The replay gate this record leans on landed with the same sweep
> (`src/test-support/workflow-replay.test.ts`).


## Context

This platform had **no strategy at all** for evolving workflow code against running executions.
Re-verified 2026-08-25: `patched(`, `buildId`, `useVersioning` and `workerDeploymentOptions` appear
**nowhere** in `apps/workers/src` or `packages/`. Workers run unversioned, and every deploy replaces
the code under whatever is mid-flight.

That is not theoretical here. The demo's equivalent of
[mono-backlog-067](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/reference/work-glossary/mono-backlog-067.md) — a one-predicate fix to when the
idle tick fires — **broke replay for already-parked children**, observed live and remedied by
terminating them. Cart and checkout workflows in this platform run with a 30-day execution timeout,
so at any moment there is a long tail of executions parked in a waiting state, holding real
inventory. "Terminate the parked ones" is not an available answer.

Phase 4 landed two more driver changes ([mono-backlog-068](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/reference/work-glossary/mono-backlog-068.md),
[mono-backlog-069](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/reference/work-glossary/mono-backlog-069.md)), which is what forced the
question from "someday" to "before the next deploy".

## Decision

**Worker Versioning is the default mechanism for evolving workflow code.** `patched()` is a
fallback for cases Worker Versioning cannot cover, not the first reach.

Two things pin the version this means:

- Temporal's current guidance makes Worker Versioning the recommended default and explicitly
  demotes patching — *"treat patching as a fallback for environments that cannot adopt versioned
  worker deployments yet, not as the default recommendation."*
- The **pre-2025 experimental Worker Versioning API is being removed.** This ADR means the current
  API (worker deployment versions and a deployment's ramping/current assignment), not the
  build-id-based experiment that shares the name.

### Why not `patched()`

It works, and it is the right tool for a surgical change inside one workflow. But as a *default* it
accumulates permanent branches in workflow code: every patch is a conditional that can never be
deleted while any execution that saw it might still replay. Over a 30-day execution timeout and a
weekly deploy cadence that is a lot of branches, each of which is a place for exactly the class of
defect this repo's validation loop keeps finding — a path that is unit-tested and never taken.

Worker Versioning moves the concern out of the workflow body: old executions keep running on the
version that started them, and new ones start on the current version. The workflow code stays a
single readable thing.

## Consequences

- **Deployment must carry a version.** Workers deploy as one shared image to ECS Fargate
  (`.github/workflows/deploy-workers.yml`, `infra/ecs/workers.taskdef.json`), so the worker
  deployment version has to be threaded through that image build and the task definition, and the
  deployment's *current* version set as part of the rollout rather than after it.
- **Old versions must be drained, not stopped.** A version stays alive until the executions pinned
  to it finish. With a 30-day cart timeout, that is a 30-day tail — the operational cost of this
  decision, and the reason it is a decision rather than a default.
- ~~**Local dev does not exercise this.** Workers run from a process registry
  (`infra/scripts/process-registry.mjs`), one version at a time. So the mechanism cannot be
  meaningfully rehearsed on the local stack, and **that gap is stated rather than papered over**:
  see *Verification owed* below.~~

  > **Withdrawn 2026-08-27 (R6) — this was wrong, and it was wrong when written.** The premise
  > "one version at a time" is an assumption about the process registry that the registry does
  > not make: it keys entries `role-pid` (`process-registry.mjs:51`) with no duplicate-role
  > rejection, so two worker sets coexist as soon as they are given distinct metrics ports
  > (`WORKER_METRICS_BIND` **and** `APP_METRICS_BIND` — a collision on either makes the second
  > process lose the bind race and exit silently). The local server supports Worker Deployments
  > too: `temporal worker deployment list` returns an empty **table**, not an unimplemented
  > error. Nothing about the local stack blocked this; the mechanism was simply unwired, and
  > deferring verification to a hypothetical environment postponed work that a workstation could
  > do in an afternoon. See *Verification owed* below, now discharged.
- **The framework changes that prompted this are already in.** Phase 4's two driver fixes shipped
  before the versioning mechanism exists, which is a deliberate acceptance of the replay risk
  **once** rather than twice — the alternative was holding two correctness fixes behind an
  infrastructure change.

## Verification — discharged 2026-08-27 (R6)

The `-017` plan's acceptance for this item was *"a written strategy, plus one workflow evolved under
it end to end without terminating a parked child."* This ADR was the first half; the second half is
now done, **on the local stack** — see the withdrawn bullet above for why it was ever thought
impossible.

`getWorkerVersioningConfig()` (`packages/infrastructure/src/worker-versioning.ts`) is spread into
all 11 in-repo `Worker.create` sites. It is **opt-in**: with no `WORKER_BUILD_ID` it returns `{}`
and the fleet is byte-identical to before, which is also what keeps the four sibling plugin repos
from having to move in lockstep. `defaultVersioningBehavior` is `PINNED`.

What was observed, running two worker sets at once (v1 on `:9466/:9467`, v2 on `:9476/:9477`, the
second with a deliberately incompatible workflow change — a new timer at the top of `cartWorkflow`,
which no execution started before it can replay):

| Claim | Evidence |
| --- | --- |
| Two live versions | both registered under deployment `nightheron-mono` |
| Old versions drain, not stop | after promoting v2, v1 reported `DrainageStatus: draining` |
| A parked execution survives promotion | the v1 cart stayed `Running`, `Behavior: Pinned`, `pinned:nightheron-mono:v1` |
| **It still makes progress on its own version** | a `cartUpdate` (addItem) executed *after* v2 became current; `TemporalUsedWorkerDeploymentVersions` stayed `[nightheron-mono:v1]`, and v2's marker never appeared in v1's log |
| **It finishes without being terminated** | a second update emptied the cart → `terminal('abandoned')`, execution `Completed` on v1 |
| New work runs the evolved code | a cart started after the promotion pinned to v2 and logged the v2 marker — in v2's log only |

The one thing still genuinely owed is the **production rollout path**, and it is a bigger change
than "thread a version through the task definition" — see
[Worker Versioning in CD](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/planning/worker-versioning-cd.md), which designs it without building
it.

The short version: the current pipeline deploys one image to **one** ECS service with a rolling
replace, which *stops* old tasks. That is the direct opposite of the drain this ADR requires, and
setting `WORKER_BUILD_ID` on top of it would be actively worse than no versioning — a pinned
execution whose workers were stopped does not fail, it **stalls silently** until its 30-day timeout,
holding inventory the whole time. Honouring the drain needs a service-per-version topology plus a
reaper gated on `DrainageStatus: DRAINED`.

It is also blocked on something more basic: `deploy-workers.yml` has never succeeded (two runs,
both failed, June 2026) and `workers.taskdef.json` still carries `ACCOUNT_ID`/`REGION`
placeholders. The mechanism is proven; the rollout is neither built nor buildable-and-verifiable
yet, and stays owed.

## Links

- [mono-backlog-070](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/reference/work-glossary/mono-backlog-070.md) — the backlog entry
- [mono-backlog-067](https://github.com/night-heron-software/nightheron-mono/blob/main/docs/reference/work-glossary/mono-backlog-067.md) — the replay break that makes
  this concrete
- [ADR-0012](0012-extract-state-machine-framework-package.md) — the framework lives in a sibling
  repo, so its changes arrive here through a dist rebuild
