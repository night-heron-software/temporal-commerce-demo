# Agent Rules — temporal-commerce-demo

## What This Repo Is

`temporal-commerce-demo` is a **standalone monolithic e-commerce demo** showcasing Temporal durable execution patterns. It combines a Next.js storefront, admin panel, and all Temporal domain workers in a single deployable project. Built for open-source release and hackathon presentation.

---

## Development Preferences

1. Do not recommend adding unit tests unless explicitly requested.
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
│   ├── worker.Dockerfile   # Multi-stage Dockerfile for Temporal workers
│   └── ecs-task-definition.json  # ECS Fargate task template
├── docs/                   # Deployment and architecture docs
├── sample-data/            # Catalog seed data (catalog.json)
├── scripts/                # Seed orchestrator (seed.ts)
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
├── Makefile                # Canonical entry point for all dev operations
└── .env.example            # Environment variable template
```

---

## Key Commands

All canonical operations go through `make`. Do not bypass the Makefile.

```bash
make dev          # Start infrastructure (Cassandra, Elasticsearch, Temporal)
make init         # dev + db-init (schema creation) — first-time setup
make app-start    # Start storefront (3000) + all workers together
make workers      # Start only Temporal workers
make seed         # Seed catalog data (requires storefront + workers running)
make stop         # Stop infrastructure containers
make clean        # Stop + wipe all Docker data volumes
make app-stop     # Kill storefront and worker processes
make help         # Show all targets
```

---

## Infrastructure Services

| Service | Port | Container Name |
| --- | --- | --- |
| Cassandra | 9042 | `demo-cassandra` |
| Elasticsearch | 9200 | `demo-elasticsearch` |
| Temporal Server | 7233 | `demo-temporal` |
| Temporal UI | 8233 | `demo-temporal-ui` |
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

1. **Workflow Code Changes**: Workers do NOT auto-reload. After changing any file in `src/temporal/`, restart `make workers` or `make app-start`.
2. **Temporal UI Port**: The demo uses port `8233` (not `8080` like the full platform) to avoid conflicts.
3. **Docker Desktop Required**: `make dev` requires Docker Desktop running. It will not auto-start Docker.
4. **Seeding Order**: `make seed` requires the Next.js app + workers to be running. Always start `make app-start` first.
5. **Inventory Seeding**: The seed pipeline uses `InventoryCommandRepository.setSupplierStock()` which flows through the inventory-service workflow (CQRS projections + ES sync). Workers must be running for this to work.

---

## Agent Behavior

1. After resolving a development issue or debugging session, proactively ask the user whether the incident should be documented in `docs/`.
2. When modifying Temporal workflow or activity code, remind the user to restart workers.
3. This is a demo project — prefer simplicity over production patterns. No auth guards, no multi-tenancy guards.
