---
description: Completely wipe, re-initialize, and seed the Demo database from scratch
---

# Demo Database Initialization

Set up Cassandra, Elasticsearch, Temporal, and seed all catalog data on a fresh install or after a full reset.

## Prerequisites

- **Node.js 20+** - Installed
- **Dependencies** - `npm install` completed
- **Docker Desktop** - Will be auto-started if not running

## Automated Initialization

> [!TIP]
> **Shortcut**: `npm run dev:init` automates the entire sequence below (clean → init → start → seed → shutdown) in a single command.

```bash
npm run infra:ready
```

```bash
npm run infra:clean
```

Then:

```bash
npm run dev:init
```

> [!NOTE]
> `npm run dev:init` internally manages stopping any running apps, wiping docker volumes, starting infrastructure (which calls `infra:ready`), applying the database schema, starting the application, and running the seeds.

This will:

1. `npm run infra:up` — Start Cassandra, Elasticsearch, Temporal containers
2. `npm run db:init` — Apply `cassandra/schema.cql` to the `demo-cassandra` container
3. `npm run dev:seed` — Load catalog data

### After Init: Start and Run

Start the app in one terminal:

```bash
npm run dev:up
```

Then seed in another terminal (if not doing a full `dev:init`):

```bash
npm run dev:seed
```

The seed script (`scripts/seed.ts`) calls the running app's APIs in order:

1. `POST /api/dev/init/es-indices` — Create ES index mappings
2. `POST /api/seed-cassandra` — Load catalog data (products, variants, collections) from `sample-data/catalog.json`
3. `POST /api/seed-inventory` — Seed inventory stock (100 units per unique blank_sku)
4. `POST /api/dev/reindex` (collections) — Sync collections to ES
5. `POST /api/dev/reindex` (products) — Sync products to ES

---

## Manual Steps (Reference)

If you need to run steps individually:

### 1. Start Infrastructure

```bash
npm run infra:up
```

### 2. Initialize Cassandra Schema

```bash
npm run db:init
```

This runs:

```bash
docker exec -i demo-cassandra cqlsh < cassandra/schema.cql
```

### 3. Start App (Required for Seeding)

All seed steps call app API routes. Workers must be running for Temporal operations:

```bash
npm run dev:up
```

### 4. Seed Data

```bash
npm run dev:seed
```

### 5. Verify

Open the storefront at `http://localhost:3000/shop` and confirm products are visible.

---

## Troubleshooting

| Problem | Solution |
| --- | --- |
| Cassandra connection refused | Run `npm run infra:up` and wait for healthy status |
| Schema errors on `db-init` | Ensure `demo-cassandra` container is healthy before running |
| Seed shows "fetch failed" | Storefront not running — start `npm run dev:up` first |
| ES sync shows 0 records | Ensure `npm run dev:seed` completed successfully |
| No products in storefront | Check `npm run dev:seed` output for errors; try `npm run dev:seed` again |

---

## NPM Scripts Reference

| Script | Description |
| --- | --- |
| `npm run dev:init` | Wipe, spin up, initialize Cassandra keyspace, start apps and seed |
| `npm run infra:up` | Start Docker infrastructure |
| `npm run infra:down` | Stop infrastructure containers |
| `npm run infra:clean` | Stop + wipe Docker volumes (nuclear reset) |
| `npm run db:init` | Apply Cassandra schema |
| `npm run dev:seed` | Run full API seed pipeline (requires app running) |
| `npm run dev:up` | Start storefront + workers |
| `npm run dev:down` | Kill storefront, worker, and infra processes |
