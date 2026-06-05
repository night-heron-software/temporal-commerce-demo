#!/usr/bin/env bash
set -euo pipefail

# Ensure Docker is running
npm run infra:ready

echo "Starting local infrastructure..."
docker-compose up -d

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

echo ""
echo "✨ Infrastructure ready!"
echo "   Temporal UI  → http://localhost:8233"
echo "   Jaeger UI    → http://localhost:16686"
echo "   Prometheus   → http://localhost:9090"
echo "   Grafana      → http://localhost:3200  (admin/admin)"
