---
description: Stop all services started by local-development (Cassandra, Elasticsearch, Temporal)
---

# Shutdown

Stop all infrastructure and application processes in reverse order.

## Steps

### 1. Stop Storefront and Workers

If running `make app-start`, press **Ctrl+C** in that terminal. Otherwise:

// turbo

```bash
make app-stop
```

### 2. Stop Infrastructure

// turbo

```bash
make stop
```

### 3. Verify

```bash
docker ps --filter "name=demo-" --format "table {{.Names}}\t{{.Status}}"
```

All containers should show as `Exited` or not appear.

---

> [!TIP]
> To wipe all data volumes as well (nuclear reset), run `make clean` instead of `make stop`.

> [!TIP]
> To start services again, use `/demo-start-local-dev`.
