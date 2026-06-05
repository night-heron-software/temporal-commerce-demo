---
description: Check the status of all temporal-commerce-demo infrastructure and application services
---

# Demo Status

Reports the health of every component in the local development stack.

## Check Status

// turbo

```bash
echo "════════════════════════════════════════════════════════"
echo "  Temporal Commerce Demo — Status"
echo "════════════════════════════════════════════════════════"

# --- Docker ---
if ! docker info >/dev/null 2>&1; then
  echo "  ❌ Docker Desktop            NOT RUNNING"
  echo "════════════════════════════════════════════════════════"
  exit 0
fi

# Disable exit-on-error for probes
set +e
set +o pipefail

# --- Infrastructure ---
check_port() {
  lsof -i :"$1" >/dev/null 2>&1
}

cass="❌ DOWN"
if check_port 9042; then
  if docker exec demo-cassandra cqlsh -e "SELECT count(*) FROM system_schema.tables WHERE keyspace_name='catalog';" >/dev/null 2>&1; then
    tables=$(docker exec demo-cassandra cqlsh -e "SELECT count(*) FROM system_schema.tables WHERE keyspace_name='catalog';" 2>/dev/null | grep -oE '[0-9]+' | head -1)
    cass="✅ UP  (${tables:-?} tables)"
  else
    cass="⚠️  Port bound, CQL unresponsive"
  fi
fi

es="❌ DOWN"
if check_port 9200; then
  es_status=$(curl -sf http://localhost:9200/_cluster/health 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{d[\"status\"]}, {d[\"active_primary_shards\"]} shards')" 2>/dev/null || echo "")
  if [ -n "$es_status" ]; then
    products=$(curl -sf "http://localhost:9200/products/_count" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null || echo "0")
    es="✅ UP  (${es_status}, ${products:-0} products)"
  else
    es="⚠️  Port bound, not responding"
  fi
fi

temporal="❌ DOWN"
if check_port 7233; then temporal="✅ UP"; fi

temporal_ui="❌ DOWN"
if check_port 8233; then temporal_ui="✅ UP"; fi

# --- Observability ---
jaeger="❌ DOWN"
if check_port 16686; then jaeger="✅ UP"; fi

prometheus="❌ DOWN"
if check_port 9090; then prometheus="✅ UP"; fi

grafana="❌ DOWN"
if check_port 3200; then grafana="✅ UP"; fi

# --- Application ---
storefront="❌ DOWN"
if check_port 3000; then
  health=$(curl -sf http://localhost:3000/api/health 2>/dev/null)
  if [ -n "$health" ]; then
    health_status=$(echo "$health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','unknown'))" 2>/dev/null || echo "unknown")
    if [ "$health_status" = "healthy" ]; then
      storefront="✅ UP  (healthy)"
    else
      storefront="⚠️  UP (${health_status})"
    fi
  else
    storefront="⚠️  Starting..."
  fi
fi

workers="❌ DOWN"
if pgrep -f "tsx.*worker" >/dev/null 2>&1; then
  workers="✅ UP"
fi

# --- Output ---
echo ""
echo "  Infrastructure"
echo "  ──────────────────────────────────────────────────"
printf "  %-28s %s\n" "Cassandra (9042)" "$cass"
printf "  %-28s %s\n" "Elasticsearch (9200)" "$es"
printf "  %-28s %s\n" "Temporal Server (7233)" "$temporal"
printf "  %-28s %s\n" "Temporal UI (8233)" "$temporal_ui"
echo ""
  echo "  Observability (opt-in — set OTEL_ENABLED=true or run npm run infra:up:obs)"
  echo "  ──────────────────────────────────────────────────"
  printf "  %-28s %s\n" "Jaeger UI (16686)" "$jaeger"
  printf "  %-28s %s\n" "Prometheus (9090)" "$prometheus"
  printf "  %-28s %s\n" "Grafana (3200)" "$grafana"
echo ""
echo "  Application"
echo "  ──────────────────────────────────────────────────"
printf "  %-28s %s\n" "Storefront (3000)" "$storefront"
printf "  %-28s %s\n" "Temporal Workers" "$workers"
echo ""
echo "  URLs"
echo "  ──────────────────────────────────────────────────"
  echo "  Storefront     → http://localhost:3000/shop"
  echo "  Admin Panel    → http://localhost:3000/admin"
  echo "  Temporal UI    → http://localhost:8233"
  echo "  Jaeger UI      → http://localhost:16686  (only when OTEL_ENABLED=true)"
  echo "  Prometheus     → http://localhost:9090   (only when OTEL_ENABLED=true)"
  echo "  Grafana        → http://localhost:3200   (only when OTEL_ENABLED=true) (admin/admin)"
echo ""
echo "════════════════════════════════════════════════════════"
```
