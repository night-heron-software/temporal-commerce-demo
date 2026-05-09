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

// turbo

```bash
make docker-ready
```

// turbo

```bash
make clean
```

Then:

// turbo

```bash
make init
```

> [!NOTE]
> `make init` calls `make dev`, which calls `make docker-ready`. If Docker Desktop is not running, it will be started automatically.

This will:

1. `make dev` — Start Cassandra, Elasticsearch, Temporal containers
2. `make db-init` — Apply `cassandra/schema.cql` to the `demo-cassandra` container

### After Init: Start and Seed

Start the app in one terminal:

```bash
make app-start
```

Then seed in another terminal:

// turbo

```bash
make seed
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
make dev
```

### 2. Initialize Cassandra Schema

```bash
make db-init
```

This runs:

```bash
docker exec -i demo-cassandra cqlsh < cassandra/schema.cql
```

### 3. Start App (Required for Seeding)

All seed steps call app API routes. Workers must be running for Temporal operations:

```bash
make app-start
```

### 4. Seed Data

```bash
make seed
```

### 5. Verify

Open the storefront at `http://localhost:3000/shop` and confirm products are visible.

---

## Troubleshooting

| Problem | Solution |
| --- | --- |
| Cassandra connection refused | Run `make dev` and wait for healthy status |
| Schema errors on `db-init` | Ensure `demo-cassandra` container is healthy before running |
| Seed shows "fetch failed" | Storefront not running — start `make app-start` first |
| ES sync shows 0 records | Ensure `make seed` completed successfully |
| No products in storefront | Check `make seed` output for errors; try `make seed` again |

---

## Make Targets Reference

| Target | Description |
| --- | --- |
| `make init` | `dev` + `db-init` (infrastructure + schema) |
| `make dev` | Start Docker infrastructure |
| `make stop` | Stop infrastructure containers |
| `make clean` | Stop + wipe Docker volumes (nuclear reset) |
| `make db-init` | Apply Cassandra schema |
| `make seed` | Run full API seed pipeline (requires app running) |
| `make app-start` | Start storefront + workers |
| `make app-stop` | Kill storefront and worker processes |
