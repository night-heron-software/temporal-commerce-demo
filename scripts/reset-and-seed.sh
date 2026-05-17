#!/usr/bin/env bash
set -euo pipefail

echo "════════════════════════════════════════════════════════"
echo "  Temporal Commerce Demo — Full Reset & Seed"
echo "════════════════════════════════════════════════════════"
echo ""

# --- Step 1: Stop any running app processes ---
echo "🛑 Stopping any running app processes..."
npm run stop:all 2>/dev/null || true

# --- Step 2: Wipe and rebuild infrastructure ---
echo ""
echo "🧹 Wiping Docker volumes..."
npm run infra:clean

echo ""
echo "🏗️  Starting infrastructure + applying schema..."
npm run init

# --- Step 3: Start app in background ---
echo ""
echo "🚀 Starting storefront + workers in background..."
npm run start:all &
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
until curl -sf http://localhost:3000 > /dev/null 2>&1; do
  sleep 2
  echo "  Storefront starting..."
done
echo "✓ Storefront ready"

# --- Step 5: Seed ---
echo ""
echo "🌱 Seeding demo data..."
npm run seed

# --- Done ---
echo ""
echo "════════════════════════════════════════════════════════"
echo "  ✨ Full reset complete!"
echo ""
echo "  The storefront + workers are running in this terminal."
echo "  Press Ctrl+C to stop."
echo ""
echo "  Storefront  → http://localhost:3000/shop"
echo "  Admin       → http://localhost:3000/admin"
echo "  Temporal UI → http://localhost:8233"
echo "════════════════════════════════════════════════════════"

# Keep the script alive so the background app stays running
# Remove the EXIT trap since we want the app to keep running
trap - EXIT
wait $APP_PID
