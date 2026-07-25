---
description: Open missing temporal-commerce-demo app and infrastructure URLs in the browser
---

# Open Demo Browser Tabs

Open standard application and infrastructure URLs for the `temporal-commerce-demo` local development environment in the Antigravity browser (using the `browser_subagent` tool). Only tabs that are not already open will be opened.

## Target URLs

| Tab | URL | Notes |
| --- | --- | --- |
| Storefront | `http://localhost:3000/shop` | Shopper catalog storefront |
| Admin Panel | `http://localhost:3000/admin` | Merchant order & catalog management |
| Temporal UI | `http://localhost:8233` | Temporal workflow & execution web UI |
| Jaeger UI | `http://localhost:16686` | OpenTelemetry distributed tracing (if OTEL enabled) |
| Prometheus | `http://localhost:9090` | Metrics & monitoring (if OTEL enabled) |
| Grafana | `http://localhost:3200` | Dashboards (admin/admin, if OTEL enabled) |

## Steps

### 1. Check OTEL Status

// turbo

```bash
grep -q "^OTEL_ENABLED=true" .env.local 2>/dev/null && echo "otel=true" || echo "otel=false"
```

### 2. Inspect Currently Open Tabs

Check the active Browser State / open pages in context to identify which of the target URLs (or host:port endpoints) are already open.

### 3. Open Missing URLs in the Antigravity Browser

Use the `browser_subagent` tool to open **only** the target URLs that are **not currently open**:

Target set:
1. `http://localhost:3000/shop` — Storefront (check if `http://localhost:3000` or `/shop` open)
2. `http://localhost:3000/admin` — Admin Panel (check if `http://localhost:3000/admin` or `/dev` open)
3. `http://localhost:8233` — Temporal UI (check if `http://localhost:8233` open)

If OTEL is enabled (`otel=true`), also check:
4. `http://localhost:16686` — Jaeger UI
5. `http://localhost:9090` — Prometheus
6. `http://localhost:3200` — Grafana (admin/admin)

Skip any tab that is already open. For each missing URL, open a new tab, navigate to the URL, and confirm the page renders. Return a summary showing which tabs were already open and which new tabs were opened.


