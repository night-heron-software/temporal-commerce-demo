#!/usr/bin/env bash
set -euo pipefail

# Ensure Docker is running
npm run infra:ready

# ── Observability opt-in ───────────────────────────────────────────────────
# By default only the core stack starts (Cassandra, Elasticsearch, Temporal).
# Set OTEL_ENABLED=true in .env.local to also start Jaeger, Prometheus, and
# Grafana. You can also run the full stack manually with:
#   docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
# or via:
#   npm run infra:up:obs
#
if [ -f .env.local ]; then
  eval "$(grep -E '^OTEL_ENABLED=' .env.local 2>/dev/null || true)"
fi
OTEL_ENABLED="${OTEL_ENABLED:-false}"

if [ "$OTEL_ENABLED" = "true" ]; then
  echo "🔭 OTEL_ENABLED=true — starting with observability stack (Jaeger + Prometheus + Grafana)"
  COMPOSE_CMD="docker compose -f docker-compose.yml -f docker-compose.observability.yml"
else
  echo "Starting core infrastructure (no observability). Set OTEL_ENABLED=true in .env.local to include tracing."
  COMPOSE_CMD="docker compose"
fi

echo "Starting local infrastructure..."
$COMPOSE_CMD up -d

echo "⏳ Waiting for Cassandra..."
until docker inspect --format='{{.State.Health.Status}}' demo-cassandra 2>/dev/null | grep -q healthy; do
  sleep 5; echo "  Cassandra starting..."
done
echo "✓ Cassandra ready"

echo "⏳ Waiting for Elasticsearch..."
until curl -sf http://localhost:9200/_cluster/health > /dev/null 2>&1; do
  sleep 5; echo "  ES starting..."
done
echo "✓ Elasticsearch ready"

echo "⏳ Waiting for Temporal..."
until docker inspect --format='{{.State.Health.Status}}' demo-temporal 2>/dev/null | grep -q healthy; do
  sleep 5; echo "  Temporal starting..."
done
echo "✓ Temporal ready"

echo "⏳ Registering correlation Search Attributes (ADR-0011)..."
bash "$(dirname "$0")/register-search-attributes.sh"

if [ "$OTEL_ENABLED" = "true" ]; then
  echo "⏳ Waiting for Jaeger..."
  until docker inspect --format='{{.State.Health.Status}}' demo-jaeger 2>/dev/null | grep -q healthy; do
    sleep 3; echo "  Jaeger starting..."
  done
  echo "✓ Jaeger ready"

  echo "⏳ Waiting for Prometheus..."
  until docker inspect --format='{{.State.Health.Status}}' demo-prometheus 2>/dev/null | grep -q healthy; do
    sleep 3; echo "  Prometheus starting..."
  done
  echo "✓ Prometheus ready"

  echo "⏳ Waiting for Grafana..."
  until curl -sf http://localhost:3200/api/health > /dev/null 2>&1; do
    sleep 3; echo "  Grafana starting..."
  done
  echo "✓ Grafana ready"
fi

echo ""
echo "✨ Infrastructure ready!"
echo "   Temporal UI  → http://localhost:8233"
if [ "$OTEL_ENABLED" = "true" ]; then
  echo "   Jaeger UI    → http://localhost:16686"
  echo "   Prometheus   → http://localhost:9090"
  echo "   Grafana      → http://localhost:3200  (admin/admin)"
fi
