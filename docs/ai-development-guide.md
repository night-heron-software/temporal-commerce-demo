# AI-First Development

This repository treats AI coding agents as first-class contributors and operators: the rules they
need are written down where they will find them, the operational procedures are runnable documents,
the scripts they call are non-interactive and machine-readable, and the system's state — Temporal
histories, Cassandra rows, Elasticsearch projections — is directly readable, so an agent can answer
"what happened?" the same way a human would. This guide explains each surface and the reasoning
behind it.

The disclosure that motivates all of it: AI tooling was used extensively to build this project,
with correctness enforced by verification gates rather than line-by-line review. The layers below
are not an add-on for agents — they are how the project was actually built.

## The operating layer

The rules live where an agent will find them, ordered from broadest to most specific:

| File                                        | Role                                                                                                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AGENTS.md](../AGENTS.md)                   | The router: hard invariants with enforcement notes, key commands, and pointers to everything below. [CLAUDE.md](../CLAUDE.md) delegates to it.                                                              |
| [.agent/rules.md](../.agent/rules.md)       | Design standards: ten mandatory Temporal patterns (determinism, state machines, CQRS, workflow IDs, transition recording, generated diagrams, standalone activities), UI conventions, and the gotchas list. |
| [.agent/skills/](../.agent/skills/)         | Domain knowledge: [nextjs.md](../.agent/skills/nextjs.md) (this Next.js is newer than any model's training data), [typescript-temporal.md](../.agent/skills/typescript-temporal.md).                        |
| [.antigravityignore](../.antigravityignore) | Keeps build output, dependencies, and OS/IDE noise out of the agent's context window.                                                                                                                       |
| [docs/adr/](adr/README.md)                  | The _why_ — so an agent asked to "improve" something can check whether the current shape is a decision before undoing it.                                                                                   |

The design principle: **state invariants once, at the top, with their enforcement mechanism named**
— an agent that knows a rule is lint-enforced fixes the code rather than working around the rule.

## Runnable workflows instead of tribal knowledge

Operational procedures are step-by-step executable documents in
[.agent/workflows/](../.agent/workflows/) — ten runbooks covering the operational surface:

| Runbook                                                                                                         | Does                                                       |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [demo-start-local-dev.md](../.agent/workflows/demo-start-local-dev.md)                                          | Start containers, storefront, workers                      |
| [demo-initialize.md](../.agent/workflows/demo-initialize.md)                                                    | Wipe, re-create schemas, seed                              |
| [demo-status.md](../.agent/workflows/demo-status.md)                                                            | Health-check everything                                    |
| [demo-verify.md](../.agent/workflows/demo-verify.md) / [demo-e2e-test.md](../.agent/workflows/demo-e2e-test.md) | End-to-end checks and checkout flows                       |
| [demo-verify-cassandra-schema.md](../.agent/workflows/demo-verify-cassandra-schema.md)                          | Schema ↔ TypeScript consistency                            |
| [demo-temporal-worker-changes.md](../.agent/workflows/demo-temporal-worker-changes.md)                          | Safe worker/workflow deployment (workers don't hot-reload) |
| [demo-project-hygiene.md](../.agent/workflows/demo-project-hygiene.md)                                          | Git hygiene, secrets, metadata                             |
| [demo-open-browser-tabs.md](../.agent/workflows/demo-open-browser-tabs.md)                                      | Open all app/infra URLs                                    |
| [demo-shutdown.md](../.agent/workflows/demo-shutdown.md)                                                        | Graceful stop                                              |

These are the same paved path a human follows — but an agent starts every session cold, remembers
nothing, and follows exactly what the document says. That makes agents a **continuous integration
test for the docs**: if a runbook drifts from reality, the next cold session trips over it and it
gets fixed. Drift-detection-by-usage is the closest thing onboarding docs have to CI.

## Scripts an agent can trust

The repo's scripts are AI-first in a specific sense: non-interactive, deterministic, and honest in
their exit codes.

- [status.sh](../scripts/status.sh) reports the health of every service.
- [validate-system.ts](../scripts/validate-system.ts) and
  [verify-checkout.ts](../scripts/verify-checkout.ts) prove the system works end to end.
- [wait-for-workers.ts](../scripts/wait-for-workers.ts) removes the guessing from startup ordering.
- `npm run dev:init` is the one-command world reset an agent can run **without asking whether it's
  safe** — it always is, because local state is disposable by design.

An agent (or CI) can chain these and trust the exit codes; nothing prompts, nothing needs a TTY.

## The system's state is readable, not just observable

An agent debugging this system reads it the way support staff would:

- **One visibility query returns a whole journey** — `CorrelationId = '<correlationId>'` (the
  journey id, which is the cartId) lists every workflow in an order's chain, because every
  start is tagged ([ADR-0011](adr/0011-workflow-id-and-correlation-tagging.md)).
- **Every transition is recorded with a full state snapshot**
  ([ADR-0010](adr/0010-async-transition-recording-projection.md)), and the
  **Order Trace tool** (`/dev/order-trace`) turns "what happened to order X?" into a structured
  timeline instead of a log-grepping expedition.
- **Cassandra and Elasticsearch are directly queryable** — 12 searchable indices via
  `/admin/search`, schema via `cqlsh`.

One design, two audiences: the observability that serves humans serves agents identically.

## Gates make agent contributions safe

When an AI writes a meaningful fraction of the code, correctness can't depend on a human reading
every line. So the invariants that matter are mechanical:

- **Determinism lint rules** fail the build on a wall-clock read in a decider — with the fix in
  the error message, because the reader may be an agent that should self-correct.
- **Diagrams are generated from source** and CI fails if they're stale
  (`npm run docs:diagrams:check`); an agent cannot quietly desynchronize the docs.
- **Structural tests** ([state-graph.test.ts](../src/temporal/state-graph.test.ts)) assert the
  state graph has no orphan states and no dead ends.
- **The container-free test suite** ([testing guide](testing-guide.md)) runs in ~7 seconds, which
  is fast enough that agents actually run it mid-task instead of promising to.

Trust the gates, not the reviewer.
