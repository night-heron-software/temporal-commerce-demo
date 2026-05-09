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
  es_status=$(curl -sf http://localhost:9200/_cluster/health 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{d[\"status\"]}, {d[\"active_primary_shards\"]} shards')" 2>/dev/null)
  if [ -n "$es_status" ]; then
    products=$(curl -sf "http://localhost:9200/products/_count" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null)
    es="✅ UP  (${es_status}, ${products:-0} products)"
  else
    es="⚠️  Port bound, not responding"
  fi
fi

temporal="❌ DOWN"
check_port 7233 && temporal="✅ UP"

temporal_ui="❌ DOWN"
check_port 8233 && temporal_ui="✅ UP"

# --- Application ---
storefront="❌ DOWN"
if check_port 3000; then
  health=$(curl -sf http://localhost:3000 2>/dev/null)
  if [ -n "$health" ]; then
    storefront="✅ UP"
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
echo ""
echo "════════════════════════════════════════════════════════"
```
