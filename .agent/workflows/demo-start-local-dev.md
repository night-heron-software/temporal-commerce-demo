---
description: Start and debug temporal-commerce-demo locally (normal startup)
---

# Local Development

Start all services when the database is already initialized and seeded.

## Prerequisites

- **Docker Desktop** - Will be auto-started by `npm run infra:up` if not running
- **Dependencies** - Run `npm install` if needed

## Startup

### 1. Start Infrastructure (Docker)

Starts Cassandra, Elasticsearch, and Temporal via `docker-compose.yml`.

// turbo

```bash
npm run infra:up
```

Services available after startup:

| Service | URL |
| --- | --- |
| Cassandra | `localhost:9042` |
| Elasticsearch | `http://localhost:9200` |
| Temporal Server | `localhost:7233` |
| Temporal UI | `http://localhost:8233` |

### 2. Start Storefront + Workers

**WAIT**: Do NOT automatically run `npm run dev:up`. Ask the user if they want you to run it, or if they prefer to start services separately.

```bash
npm run dev:up
```

This starts the Next.js dev server and all 6 Temporal domain workers concurrently via `npx concurrently`.

**Or launch them separately:**

```bash
npm run dev:storefront   # Next.js storefront only (or npm run dev)
npm run dev:worker       # Temporal workers only
```

---

> [!TIP]
> **Shortcut**: `npm run dev:up` combines both steps (infra:up + storefront/worker startup) in a single command.

> [!TIP]
> To stop all services, use `npm run dev:down` or `/demo-shutdown`.

## Quick Reference

```bash
npm run infra:up      # Start infrastructure (Docker)
npm run dev:up        # Start storefront + workers together
npm run dev:worker    # Start only Temporal workers
npm run infra:down    # Stop infrastructure containers
npm run dev:seed       # Seed demo data (requires app running)
npm run infra:ps      # List running containers
```

---

## Troubleshooting

| Problem | Solution |
| --- | --- |
| Port 9042 in use | `lsof -i :9042` then stop the conflicting process |
| Port 7233 in use | `docker ps` — check temporal container |
| Port 9200 in use | `lsof -i :9200` then stop the conflicting process |
| Workflows not processing | Workers not running — start `npm run dev:worker` |
| Storefront not loading | Check `npm run dev:storefront` output for errors |
| Docker not running | Start Docker Desktop first |
