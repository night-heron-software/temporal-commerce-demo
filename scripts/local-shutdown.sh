#!/usr/bin/env bash
set -e

# Change to the project root directory
cd "$(dirname "$0")/.."

echo "🛑 Stopping Temporal Commerce Demo Infrastructure..."

if [ -f "docker-compose.yml" ]; then
    docker-compose stop
    echo "✓ Infrastructure stopped successfully."
else
    echo "⚠️  docker-compose.yml not found. Are you in the right directory?"
    exit 1
fi
