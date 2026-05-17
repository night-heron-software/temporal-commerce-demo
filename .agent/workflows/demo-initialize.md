---
description: Completely wipe, re-initialize, and seed the Demo database from scratch
---

# Demo Database Initialization

Set up Cassandra, Elasticsearch, Temporal, and seed all catalog data on a fresh install or after a full reset.

## Prerequisites

- **Node.js 20+** - Installed
- **Dependencies** - `npm install` completed
- **Docker Desktop** - Will be auto-started if not running

## Automated Full Reset

> [!TIP]
> **Shortcut**: `npm run reset:seed` automates the entire sequence below (clean → init → start → seed) in a single command.

// turbo

```bash
npm run docker:ready
```

// turbo

```bash
npm run infra:clean
```

Then:

// turbo

```bash
npm run init
```

> [!NOTE]
> `npm run init` calls `npm run infra:start`, which calls `npm run docker:ready`. If Docker Desktop is not running, it will be started automatically.

This will:

1. `npm run infra:start` — Start Cassandra, Elasticsearch, Temporal containers
2. `npm run db:init` — Apply `cassandra/schema.cql` to the `demo-cassandra` container

### After Init: Start and Seed

Start the app in one terminal:

```bash
npm run start:all
```

Then seed in another terminal:

// turbo

```bash
npm run seed
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
npm run infra:start
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
npm run start:all
```

### 4. Seed Data

```bash
npm run seed
```

### 5. Verify

Open the storefront at `http://localhost:3000/shop` and confirm products are visible.

---

## Troubleshooting

| Problem | Solution |
| --- | --- |
| Cassandra connection refused | Run `npm run infra:start` and wait for healthy status |
| Schema errors on `db-init` | Ensure `demo-cassandra` container is healthy before running |
| Seed shows "fetch failed" | Storefront not running — start `npm run start:all` first |
| ES sync shows 0 records | Ensure `npm run seed` completed successfully |
| No products in storefront | Check `npm run seed` output for errors; try `npm run seed` again |

---

## NPM Scripts Reference

| Script | Description |
| --- | --- |
| `npm run init` | `infra:start` + `db:init` (infrastructure + schema) |
| `npm run infra:start` | Start Docker infrastructure |
| `npm run infra:stop` | Stop infrastructure containers |
| `npm run infra:clean` | Stop + wipe Docker volumes (nuclear reset) |
| `npm run db:init` | Apply Cassandra schema |
| `npm run seed` | Run full API seed pipeline (requires app running) |
| `npm run start:all` | Start storefront + workers |
| `npm run stop:all` | Kill storefront and worker processes |
