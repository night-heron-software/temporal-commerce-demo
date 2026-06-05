#!/usr/bin/env bash
set -euo pipefail

echo "════════════════════════════════════════════════════════"
echo "  Temporal Commerce Demo — Full Reset & Seed"
echo "════════════════════════════════════════════════════════"
echo ""

# --- Step 1: Stop any running app processes ---
echo "🛑 Stopping any running app processes..."
npm run dev:down 2>/dev/null || true

# --- Step 2: Wipe and rebuild infrastructure ---
echo ""
echo "🧹 Wiping Docker volumes..."
npm run infra:clean

echo ""
echo "🏗️  Starting infrastructure + applying schema..."
npm run infra:up && npm run db:init

# --- Step 3: Start storefront and workers separately ---
# Using separate background processes avoids concurrently's --kill-others-on-fail
# which terminates the storefront if the worker crashes on first connect attempt.
echo ""
echo "🚀 Starting storefront in background..."
npm run dev:storefront &
STOREFRONT_PID=$!

# Ensure background processes are cleaned up on exit
cleanup() {
  echo ""
  echo "🛑 Stopping background processes..."
  kill $STOREFRONT_PID $WORKER_PID 2>/dev/null || true
  npm run dev:down > /dev/null 2>&1 || true
}
WORKER_PID=""
trap cleanup EXIT

# --- Step 4: Wait for storefront to be ready ---
# Use the root URL for initial readiness (faster, no DB dependency)
echo "⏳ Waiting for storefront to be ready at http://localhost:3000..."
until curl -sf http://localhost:3000 > /dev/null 2>&1; do
  sleep 2
  echo "  Storefront starting..."
done
echo "✓ Storefront ready"

# --- Step 5: Start workers (after storefront is up) ---
echo ""
echo "🚀 Starting workers in background..."
npm run dev:worker &
WORKER_PID=$!

# --- Step 6: Wait for workers to register pollers ---
echo "⏳ Waiting for Temporal workers to register..."
npm run workers-wait
echo "✓ All workers ready"

# --- Step 7: Verify deep health ---
echo "⏳ Verifying deep health..."
until curl -sf http://localhost:3000/api/health > /dev/null 2>&1; do
  sleep 2
  echo "  Waiting for health check..."
done
echo "✓ All services healthy"

# --- Step 8: Seed ---
echo ""
echo "🌱 Seeding demo data..."
npm run dev:seed

# --- Done ---
echo ""
cleanup
trap - EXIT

echo ""
echo "════════════════════════════════════════════════════════"
echo "  ✨ Full reset & seeding complete!"
echo ""
echo "  The database infrastructure is running in Docker."
echo ""
echo "  How to start the application storefront and workers:"
echo "    - Run: npm run dev:up"
echo "    - Or launch the debugger in VS Code (using 'Debug: Storefront & Workers')"
echo ""
echo "  How to shut down the database infrastructure:"
echo "    - Run: npm run dev:down"
echo "════════════════════════════════════════════════════════"
