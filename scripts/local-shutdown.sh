#!/usr/bin/env bash
set -e

# Change to the project root directory
cd "$(dirname "$0")/.."

echo "🛑 Stopping Temporal Commerce Demo Infrastructure..."

# Explicit list of all containers across both compose files.
# Core stack (docker-compose.yml):
CORE_CONTAINERS=(
  demo-cassandra
  demo-elasticsearch
  demo-temporal
  demo-temporal-ui
  demo-temporal-postgresql
  demo-temporal-elasticsearch
)

# Observability stack (docker-compose.observability.yml — opt-in):
OBS_CONTAINERS=(
  demo-jaeger
  demo-prometheus
  demo-grafana
)

ALL_CONTAINERS=("${CORE_CONTAINERS[@]}" "${OBS_CONTAINERS[@]}")

stopped=0
for name in "${ALL_CONTAINERS[@]}"; do
  if docker ps -q --filter "name=^${name}$" | grep -q .; then
    docker stop "$name"
    echo "  ✓ Stopped $name"
    stopped=$((stopped + 1))
  fi
done

if [ "$stopped" -eq 0 ]; then
  echo "✓ No demo containers were running."
else
  echo "✓ Infrastructure stopped successfully ($stopped container(s))."
fi
