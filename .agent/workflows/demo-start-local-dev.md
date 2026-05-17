---
description: Start and debug temporal-commerce-demo locally (normal startup)
---

# Local Development

Start all services when the database is already initialized and seeded.

## Prerequisites

- **Docker Desktop** - Will be auto-started by `npm run infra:start` if not running
- **Dependencies** - Run `npm install` if needed

## Startup

### 1. Start Infrastructure (Docker)

Starts Cassandra, Elasticsearch, and Temporal via `docker-compose.yml`.

// turbo

```bash
npm run infra:start
```

Services available after startup:

| Service | URL |
| --- | --- |
| Cassandra | `localhost:9042` |
| Elasticsearch | `http://localhost:9200` |
| Temporal Server | `localhost:7233` |
| Temporal UI | `http://localhost:8233` |

### 2. Start Storefront + Workers

**WAIT**: Do NOT automatically run `npm run start:all`. Ask the user if they want you to run it, or if they prefer to start services separately.

```bash
npm run start:all
```

This starts the Next.js dev server and all 6 Temporal domain workers concurrently via `npx concurrently`.

**Or launch them separately:**

```bash
npm run dev              # Next.js storefront only
npm run temporal:worker  # Temporal workers only
```

---

> [!TIP]
> **Shortcut**: `npm run up` combines both steps (infra:start + start:all) in a single command.

> [!TIP]
> To stop all services, use `npm run shutdown` or `/demo-shutdown`.

## Quick Reference

```bash
npm run infra:start   # Start infrastructure (Docker)
npm run start:all     # Start storefront + workers together
npm run temporal:worker # Start only Temporal workers
npm run infra:stop    # Stop infrastructure containers
npm run seed          # Seed demo data (requires app running)
npm run infra:ps      # List running containers
```

---

## Troubleshooting

| Problem | Solution |
| --- | --- |
| Port 9042 in use | `lsof -i :9042` then stop the conflicting process |
| Port 7233 in use | `docker ps` — check temporal container |
| Port 9200 in use | `lsof -i :9200` then stop the conflicting process |
| Workflows not processing | Workers not running — start `npm run temporal:worker` |
| Storefront not loading | Check `npm run dev` output for errors |
| Docker not running | Start Docker Desktop first |
