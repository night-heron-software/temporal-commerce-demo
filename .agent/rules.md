# Agent Rules — temporal-commerce-demo

## What This Repo Is

`temporal-commerce-demo` is a **standalone monolithic e-commerce demo** showcasing Temporal durable execution patterns. It combines a Next.js storefront, admin panel, and all Temporal domain workers in a single deployable project. Built for open-source release and hackathon presentation.

---

## Development Preferences

1. Do not recommend adding unit tests unless explicitly requested — **except** in `src/temporal/`, where Temporal Patterns rule 7 below *requires* co-located tests for decider/states changes.
2. Do not add confirmation dialogs to any actions unless explicitly requested.
3. Make sure that input fields are cleared before filling in new values.
4. Do not recommend or implement caching unless explicitly requested.
5. Strictly separate business management interfaces from technical instrumentation. Use the `/admin` route prefix for user-facing management (e.g., orders, catalogs, inventory) and the `/dev` prefix for developer-only tools (e.g., Temporal debuggers, API tokens, reindexing).
6. For state mutations, default to orchestrating changes via Temporal workflows rather than direct database REST calls, ensuring all state changes emit proper audit trails.
7. When generating new UI components, default to using the existing CSS variables (e.g., `var(--heron-slate)`) and Tailwind utility classes rather than creating new custom CSS files.

---

## Temporal Patterns

These rules are mandatory for all workflow and activity code in `src/temporal/`:

1. **Determinism & Sandbox**: Workflows must be 100% deterministic (no network I/O, no filesystem, use `wf.sleep()`, synchronous predicates, no dynamic imports). Isolate side-effects purely within Activities.
2. **State & Lifecycle**: Enforce state machines with validators. Use `expectedVersion` for optimistic locking. Track update counts to `continueAsNew`. Use `await allHandlersFinished()` before ending workflows. Implement compensation patterns for unhandled paths.
3. **CQRS**: Sync projections with non-blocking updates/signals. Perform dirty-loop projections for high-latency Update handlers. Use Queries for reads, Updates for exact confirmations, and Signals for fire-and-forget APIs.
4. **Code Organization**: Use the Two-File Activity pattern (contract vs. impl), Definitions File pattern for queries/signals, and strict module isolation to prevent Temporal runtime imports within Next.js.
5. **Client Operations**: Use unified domain-specific wrappers (e.g., `executeCartUpdate`) inside Next.js Server Actions to safely handle terminal errors and perform redemptive client-state clearing.
6. **Workflow IDs & Correlation (ported from nightheron-mono ADR-0011)**: Build workflow IDs with `buildWorkflowId(DEMO_STORE_ID, domain, entityId)` from `src/temporal/contracts/constants.ts` — never inline `{storeId}.{domain}.{entityId}` strings (lint-enforced). At workflow **starts**, spread `buildWorkflowStartOptions()` so the correlation Search Attributes (`CorrelationId`, `StoreId`, `Domain`, `OrderId`, `CartId`) and memo are set.
7. **Prepare → Decide → Finalize (ADR-0003/0009/0010)**: Domain state machines are authored with `defineDomain()/transitions()` from `src/temporal/framework`; each domain has a pure `*-decider.ts` (decide → facts, evolve as the sole state writer). `decide` is pure and synchronous — no activities, no clock (`meta.timestamp` / the `at` hook argument carry deterministic time; lint-enforced), no id generation (inject via the command from `prepare`). I/O belongs in `prepare`/`finalize`/hooks. Changes to decider/states files **require** co-located `*.test.ts` unit tests.
8. **Transition recording (ADR-0010)**: the framework records every transition to Cassandra `workflow_state_transitions` via the `persistWorkflowTransitions` activity — spread `transitionRecorderActivities` into any new domain worker. The order-trace dev tool (`/dev/order-trace`) reads these.
9. **State diagrams are generated, never hand-edited**: after changing any `states.ts` / `*-decider.ts` / `fulfiller-states.ts`, run `npm run docs:diagrams` and commit the regenerated `docs/reference/state-machine-diagrams.md` + `state-graph.json`. CI fails stale diagrams via `npm run docs:diagrams:check`; `src/temporal/state-graph.test.ts` asserts structural properties (reachability, no dead-end states) against the JSON.

---

## React & Next.js Patterns

1. Default to Server Components (`page.tsx`, `layout.tsx`) and restrict `'use client'` strictly to interactive leaf nodes. Place Server Actions in dedicated `*-actions.ts` files, not inlined.
2. Route Segmentation: `/api/admin/*` for store management, `/api/dev/*` for dev tools, `/api/auth/*` for auth, `/api/webhooks/*` for callbacks. Use `Zod` validation consistently for incoming route bodies.
3. Never mutate state within a `useEffect` that has the mutated state in its dependency array.

---

## Project Structure

```text
temporal-commerce-demo/
├── cassandra/              # CQL schema (single file: schema.cql)
├── deploy/                 # Cloud deployment artifacts
│   └── worker.Dockerfile   # Multi-stage Dockerfile for Temporal workers
├── docs/                   # Deployment and architecture docs
├── sample-data/            # Catalog seed data (catalog.json)
├── scripts/                # Dev orchestration + seed (seed.ts, init.sh, etc.)
├── src/
│   ├── app/
│   │   ├── admin/          # Admin panel (no auth — demo mode)
│   │   ├── api/            # API routes (seed, reindex, health)
│   │   └── shop/           # Storefront (catalog, cart, checkout)
│   ├── components/         # Shared React components
│   ├── context/            # Cart context provider
│   ├── lib/                # Infrastructure clients (Cassandra, ES, Temporal)
│   └── temporal/           # All 6 Temporal workflow domains
│       ├── cart/            # Shopping cart (entity workflow)
│       ├── checkout/        # Checkout (state machine + child workflows)
│       ├── fulfillment/     # Simulated fulfillment (timer-based)
│       ├── identity/        # User creation (minimal, no auth)
│       ├── inventory/       # CQRS inventory service
│       ├── oms/             # Order management (updates + signals)
│       ├── contracts/       # Shared type contracts
│       └── worker.ts        # Unified worker launcher (all domains)
├── docker-compose.yml      # Local: Cassandra + Elasticsearch + Temporal
├── package.json            # Canonical entry point for all dev operations
└── .env.example            # Environment variable template
```

---

## Key Commands

All canonical operations go through `npm run`.

```bash
npm run dev:up         # Start infrastructure + storefront + workers together
npm run dev:down       # Stop storefront, workers, and infrastructure containers
npm run dev:status     # Check status of all infrastructure and application services
npm run dev:init       # Full reset: stop app -> wipe docker -> start infra -> apply schema -> start app -> seed data
npm run dev:storefront # Start only the Next.js storefront (dev server)
npm run dev:worker     # Start only Temporal workers
npm run db:init        # Apply Cassandra schema (cassandra/schema.cql)
npm run dev:seed        # Seed catalog data (requires storefront + workers running)
npm run db:verify      # Verify Cassandra schema tables against code queries
npm run infra:up       # Start Docker infrastructure (Cassandra, Elasticsearch, Temporal) and check health
npm run infra:down     # Stop infrastructure containers
npm run infra:clean    # Stop + wipe all Docker data volumes (nuclear reset)
npm run infra:ps       # List running infrastructure containers
```

---

## Infrastructure Services

| Service | Port | Container Name |
| --- | --- | --- |
| Cassandra | 9042 | `demo-cassandra` |
| Elasticsearch | 9200 | `demo-elasticsearch` |
| Temporal Server | 7233 | `demo-temporal` |
| Temporal UI | 8233 | `demo-temporal-ui` |
| Jaeger UI | 16686 | `demo-jaeger` |
| Prometheus | 9090 | `demo-prometheus` |
| Grafana | 3200 | `demo-grafana` |
| Next.js Storefront | 3000 | (host process) |
| Temporal Workers | — | (host process) |

---

## Temporal Domains

All 6 domains run in a single unified worker process (`src/temporal/worker.ts`):

| Domain | Task Queue | Key Patterns |
| --- | --- | --- |
| Cart | `cart-queue` | Entity workflow, Updates, Continue-as-New |
| Checkout | `checkout-queue` | State machine, child workflows |
| Fulfillment | `fulfillment-queue` | Timer-based simulation, signals |
| Identity | `identity-queue` | User creation (simplified) |
| Inventory | `inventory-queue` | CQRS singleton service |
| OMS | `oms-queue` | Order lifecycle, Updates, status history |

---

## Environment Variables

See `.env.example` for all variables. The demo uses hardcoded defaults for local development:

| Variable | Default | Description |
| --- | --- | --- |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_TLS_CERT` | — | Base64 mTLS cert (Temporal Cloud only) |
| `TEMPORAL_TLS_KEY` | — | Base64 mTLS key (Temporal Cloud only) |
| `CASSANDRA_CONTACT_POINTS` | `localhost:9042` | Cassandra contact points |
| `CASSANDRA_KEYSPACE` | `catalog` | Cassandra keyspace |
| `ELASTICSEARCH_URL` | `http://localhost:9200` | Elasticsearch URL |
| `OTEL_ENABLED` | `false` | Enable distributed tracing via OTel (opt-in) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP HTTP endpoint (Jaeger) |

---

## Simplified Design Decisions

This demo differs from the full platform in several intentional ways:

1. **No authentication** — admin panel and all API routes are open (demo mode)
2. **Single store** — `DEMO_STORE_ID` is hardcoded (no multi-tenancy)
3. **Simulated fulfillment** — uses timer-based simulation + manual controls instead of real supplier APIs
4. **Single worker process** — all domains share one `NativeConnection` (no polyrepo, no `tsconfig-paths`)
5. **Single schema file** — `cassandra/schema.cql` replaces three separate platform files
6. **No external integrations** — no Stripe, no Printify, no Mailgun

---

## Gotchas

1. **Workflow Code Changes**: Workers do NOT auto-reload. After changing any file in `src/temporal/`, restart `npm run dev:worker` or `npm run dev:up`.
2. **Temporal UI Port**: The demo uses port `8233` (not `8080` like the full platform) to avoid conflicts.
3. **Docker Desktop Required**: `npm run infra:up` requires Docker Desktop running. It will auto-start Docker Desktop if not running.
4. **Seeding Order**: `npm run dev:seed` requires the Next.js app + workers to be running. Always start `npm run dev:up` first.
5. **Inventory Seeding**: The seed pipeline uses `InventoryCommandRepository.setFulfillerStock()` which flows through the inventory-service workflow (CQRS projections + ES sync). Workers must be running for this to work.

---

## Agent Behavior

1. After resolving a development issue or debugging session, proactively ask the user whether the incident should be documented in `docs/`.
2. When modifying Temporal workflow or activity code, remind the user to restart workers.
3. This is a demo project — prefer simplicity over production patterns. No auth guards, no multi-tenancy guards.
