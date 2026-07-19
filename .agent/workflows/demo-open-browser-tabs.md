---
description: Open all temporal-commerce-demo app and infrastructure URLs in the browser
---

# Open Demo Browser Tabs

Open all relevant URLs for the temporal-commerce-demo local development environment in the
Antigravity browser (using the `browser_subagent` tool, not the system `open` command).

## Steps

### 1. Check OTEL

// turbo

```bash
grep -q "^OTEL_ENABLED=true" .env.local 2>/dev/null && echo "otel=true" || echo "otel=false"
```

### 2. Open URLs in the Antigravity browser

Use the `browser_subagent` tool to open each URL as a new tab. Open the following tabs in order:

1. `http://localhost:3000/shop` — Storefront
2. `http://localhost:3000/admin` — Admin Panel
3. `http://localhost:8233` — Temporal UI

If the OTEL check above returned `otel=true`, also open:

4. `http://localhost:16686` — Jaeger UI
5. `http://localhost:9090` — Prometheus
6. `http://localhost:3200` — Grafana (admin/admin)

For each URL, instruct the subagent to navigate to the URL and confirm the page loaded (title
visible or any content rendered). Return a summary of which pages loaded successfully.

## URL Reference

| Service | URL |
| --- | --- |
| Storefront | http://localhost:3000/shop |
| Admin Panel | http://localhost:3000/admin |
| Temporal UI | http://localhost:8233 |
| Jaeger UI | http://localhost:16686 |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3200 (admin/admin) |
