# AGENTS.md — temporal-commerce-demo

A full-stack e-commerce demo built on the Temporal TypeScript SDK (Next.js + Cassandra +
Elasticsearch). Six workflow domains: cart, checkout, oms, fulfillment, inventory, identity.
This file is the router — it states the invariants and points at the detail; it does not
duplicate it.

## Hard invariants

1. **Workflow determinism.** No clock reads, randomness, or I/O in workflow code or deciders —
   I/O lives in activities, time enters as data (`meta.timestamp`). _Enforced: custom ESLint
   rules fail the build, with the fix in the error message._
2. **Workflow IDs and correlation.** Build IDs with `buildWorkflowId()` — dot-delimited
   `demo.{domain}.{entityId}`, never inline (lint-enforced) — and spread
   `buildWorkflowStartOptions()` at every workflow start so the correlation Search Attributes +
   memo are set. `correlationId` (the `cartId` itself — one journey id per cart lifecycle
   since 2026-08-12; earlier workflows keep their separately minted UUIDs) is REQUIRED;
   correlation-less singletons pass `undefined` explicitly. See
   [ADR-0011](docs/adr/0011-workflow-id-and-correlation-tagging.md).
3. **State machines are authored, diagrams are generated.** Domains follow prepare → decide →
   finalize with a pure Chassaing decider core ([ADR-0003](docs/adr/0003-prepare-decide-finalize-state-machines.md),
   [ADR-0009](docs/adr/0009-chassaing-decider-transfer-pilot.md)). After changing any `states.ts` /
   `*-decider.ts` / `fulfiller-states.ts`, run `npm run docs:diagrams` and commit the result —
   CI fails stale diagrams; never hand-edit `docs/reference/state-machine-diagrams.md`.
4. **Test policy (overrides "don't add tests unless asked").** Changes to decider / states files
   **require** co-located `*.test.ts` unit tests. The suite must stay runnable with zero
   containers (`npm test` — no Docker).
5. **New domain workers spread `transitionRecorderActivities`** so every transition is recorded
   ([ADR-0010](docs/adr/0010-async-transition-recording-projection.md)).
6. **System actors journal under the reservation row's stored journey key.** Inventory
   mutations performed on the system's behalf (expiry sweep, inline sweep on a contended
   reserve) write to `inventory_history` under `rowJournalKey` (the row's `correlation_id`,
   falling back to `cart_id` for legacy rows) — never an ambient correlationId.

## Key commands

```bash
npm run dev:init      # full reset: containers + schema + seeded catalog (2–4 min)
npm run dev:up        # storefront :3000 + workers        npm run dev:status  # health
npm test              # 514 tests, ~6s, no containers     npm run typecheck
npm run docs:diagrams # regenerate state-machine diagrams (docs:diagrams:check in CI)
```

Workers do **not** hot-reload workflow code — restart them after workflow changes
(see `.agent/workflows/demo-temporal-worker-changes.md`).

## Where the detail lives

| Need                                                        | Read                                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Temporal patterns, determinism gotchas, project structure   | [.agent/rules.md](.agent/rules.md)                                                                        |
| Runnable procedures (start, init, verify, e2e, shutdown, …) | [.agent/workflows/](.agent/workflows/) — 10 runbooks                                                      |
| Domain knowledge (Next.js conventions, TS-on-Temporal)      | [.agent/skills/](.agent/skills/)                                                                          |
| Why the architecture is shaped this way                     | [docs/adr/](docs/adr/README.md)                                                                           |
| Every state machine, generated from source                  | [docs/reference/state-machine-diagrams.md](docs/reference/state-machine-diagrams.md) + `state-graph.json` |
| Hard-won scar tissue (26 lessons)                           | [docs/temporal-lessons-learned.md](docs/temporal-lessons-learned.md)                                      |
| Day-to-day conventions                                      | [docs/developer-guide.md](docs/developer-guide.md)                                                        |
| Tracing, worker metrics, logging fan-out                    | [docs/observability-guide.md](docs/observability-guide.md)                                                |

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->
