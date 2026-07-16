# AI-First Development

> **Status:** stub — outline in place, sections to be expanded. The agent tooling surfaces are
> indexed today in the [README § AI Agent Tooling & Configuration](../README.md#ai-agent-tooling--configuration).

This repository treats AI coding agents as first-class contributors and operators: the rules they
need are written down where they will find them, the operational procedures are runnable documents,
the scripts they call are non-interactive and machine-readable, and the system's state — Temporal
histories, Cassandra rows, Elasticsearch projections — is directly readable, so an agent can answer
"what happened?" the same way a human would. This guide explains each surface and the reasoning
behind it.

## Outline

1. **The operating layer** — [`AGENTS.md`](../AGENTS.md) / [`CLAUDE.md`](../CLAUDE.md) (workspace
   rules), [`.agent/rules.md`](../.agent/rules.md) (design standards, Temporal determinism
   gotchas), [`.agent/skills/`](../.agent/skills/) (domain knowledge: Next.js, TypeScript +
   Temporal).
2. **Runnable workflows instead of tribal knowledge** — the [`.agent/workflows/`](../.agent/workflows/)
   library (start-local-dev, initialize, status, verify, e2e-test, temporal-worker-changes,
   project-hygiene, shutdown): the same paved path humans follow, executable by an agent that
   starts cold.
3. **AI-first scripts** — non-interactive, deterministic, exit-code honest:
   `scripts/status.sh`, `scripts/validate-system.ts`, `scripts/verify-checkout.ts`,
   `scripts/wait-for-workers.ts`; `npm run dev:init` as the one-command world reset an agent can
   safely run.
4. **Reading the system's state** — Temporal CLI/UI visibility queries over correlation search
   attributes; querying Elasticsearch and Cassandra directly; the Order Trace tool as a structured
   answer to "where is order X and why?".
5. **Gates make agent contributions safe** — determinism lint rules, diagrams generated from source
   with a CI staleness check (`npm run docs:diagrams:check`), state-graph structural tests, and a
   no-mock test suite fast enough that agents actually run it mid-task.
6. **Keeping the layer honest** — agents exercise these documents constantly; drift gets caught by
   the next cold-start session, which is the closest thing onboarding docs have to CI.
