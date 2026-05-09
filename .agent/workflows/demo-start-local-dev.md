---
description: Start and debug temporal-commerce-demo locally (normal startup)
---

# Local Development

Start all services when the database is already initialized and seeded.

## Prerequisites

- **Docker Desktop** - Will be auto-started by `make dev` if not running
- **Dependencies** - Run `npm install` if needed

## Startup

### 1. Start Infrastructure (Docker)

Starts Cassandra, Elasticsearch, and Temporal via `docker-compose.yml`.

// turbo

```bash
make dev
```

Services available after startup:

| Service | URL |
| --- | --- |
| Cassandra | `localhost:9042` |
| Elasticsearch | `http://localhost:9200` |
| Temporal Server | `localhost:7233` |
| Temporal UI | `http://localhost:8233` |

### 2. Start Storefront + Workers

**WAIT**: Do NOT automatically run `make app-start`. Ask the user if they want you to run it, or if they prefer to start services separately.

```bash
make app-start
```

This starts the Next.js dev server and all 6 Temporal domain workers concurrently via `npx concurrently`.

**Or launch them separately:**

```bash
npm run dev              # Next.js storefront only
npm run temporal:worker  # Temporal workers only
```

---

> [!TIP]
> To stop all services, use `/demo-shutdown`.

## Quick Reference

```bash
make dev          # Start infrastructure (Docker)
make app-start    # Start storefront + workers together
make workers      # Start only Temporal workers
make stop         # Stop infrastructure containers
make seed         # Seed demo data (requires app running)
make help         # Show all make targets
```

---

## Troubleshooting

| Problem | Solution |
| --- | --- |
| Port 9042 in use | `lsof -i :9042` then stop the conflicting process |
| Port 7233 in use | `docker ps` — check temporal container |
| Port 9200 in use | `lsof -i :9200` then stop the conflicting process |
| Workflows not processing | Workers not running — start `make workers` |
| Storefront not loading | Check `npm run dev` output for errors |
| Docker not running | Start Docker Desktop first |
