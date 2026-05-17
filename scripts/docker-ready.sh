#!/usr/bin/env bash
set -euo pipefail

if ! docker info > /dev/null 2>&1; then
  echo "⚠️  Docker is not running. Starting Docker Desktop..."
  open -a 'Docker'
  until docker info > /dev/null 2>&1; do sleep 2; done
  echo "✓ Docker is ready."
else
  echo "✓ Docker is already running."
fi
