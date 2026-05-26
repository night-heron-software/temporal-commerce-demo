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

# --- Step 3: Start app in background ---
echo ""
echo "🚀 Starting storefront + workers in background..."
npm run dev:up &
APP_PID=$!

# Ensure background processes are cleaned up on exit
cleanup() {
  echo ""
  echo "🛑 Stopping background app (PID $APP_PID)..."
  kill $APP_PID 2>/dev/null || true
  wait $APP_PID 2>/dev/null || true
}
trap cleanup EXIT

# --- Step 4: Wait for app to be healthy ---
echo "⏳ Waiting for storefront to be ready at http://localhost:3000..."
until curl -sf http://localhost:3000/shop > /dev/null 2>&1; do
  sleep 2
  echo "  Storefront starting..."
done
echo "✓ Storefront ready"

# --- Step 5: Seed ---
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
