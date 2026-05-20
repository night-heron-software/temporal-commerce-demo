---
description: Stop all services started by local-development (Cassandra, Elasticsearch, Temporal)
---

# Shutdown

Stop all infrastructure and application processes in reverse order.

> [!TIP]
> **Shortcut**: `npm run dev:down` does both steps below in a single command.

## Steps

### 1. Stop Storefront and Workers

If running `npm run dev:up`, press **Ctrl+C** in that terminal. Otherwise:

```bash
npm run dev:down
```

### 2. Stop Infrastructure

// turbo

```bash
npm run infra:down
```

### 3. Verify

```bash
docker ps --filter "name=demo-" --format "table {{.Names}}\t{{.Status}}"
```

All containers should show as `Exited` or not appear.

---

> [!TIP]
> To wipe all data volumes as well (nuclear reset), run `npm run infra:clean` instead of `npm run infra:down`.

> [!TIP]
> To start services again, use `/demo-start-local-dev`.
