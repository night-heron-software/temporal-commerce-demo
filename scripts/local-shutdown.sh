#!/usr/bin/env bash
set -e

# Change to the project root directory
cd "$(dirname "$0")/.."

echo "🛑 Stopping Temporal Commerce Demo Infrastructure..."

# Stop all containers whose name starts with "demo-" regardless of which
# compose files (base or observability override) were used to start them.
running=$(docker ps -q --filter "name=demo-")
if [ -n "$running" ]; then
    # shellcheck disable=SC2086
    docker stop $running
    echo "✓ Infrastructure stopped successfully."
else
    echo "✓ No demo containers were running."
fi
