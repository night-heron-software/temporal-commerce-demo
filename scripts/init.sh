#!/usr/bin/env bash
set -euo pipefail

# ── Progress Reporting Helpers ─────────────────────────────────────────────
INIT_START=$(date +%s)
STEP_START=$INIT_START
CURRENT_STEP=0
TOTAL_STEPS=8
declare -a STEP_NAMES=()
declare -a STEP_DURATIONS=()

step() {
  local now=$(date +%s)
  # Record duration of previous step (if any)
  if [ $CURRENT_STEP -gt 0 ]; then
    STEP_DURATIONS+=( $(( now - STEP_START )) )
  fi
  CURRENT_STEP=$(( CURRENT_STEP + 1 ))
  STEP_START=$now
  local elapsed=$(( now - INIT_START ))
  STEP_NAMES+=( "$1" )
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  printf "  [%d/%d] %s  (elapsed: %dm %ds)\n" "$CURRENT_STEP" "$TOTAL_STEPS" "$1" $(( elapsed / 60 )) $(( elapsed % 60 ))
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

echo "════════════════════════════════════════════════════════"
echo "  Temporal Commerce Demo — Full Reset & Seed"
echo "════════════════════════════════════════════════════════"

# --- Step 1: Stop any running app processes ---
step "Stopping running processes"
npm run dev:down 2>/dev/null || true
echo "✓ Processes stopped"

# --- Step 2: Wipe Docker volumes ---
step "Wiping Docker volumes"
npm run infra:clean
echo "✓ Volumes wiped"

# --- Step 3: Start infrastructure + apply schema ---
step "Starting infrastructure + applying schema"
npm run infra:up && npm run db:init

# --- Step 4: Start storefront ---
step "Starting storefront"

# Fail fast if port 3000 is already in use (prevents concurrent init races)
if lsof -iTCP:3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "❌ Port 3000 is already in use. Another dev:init or dev:up may be running."
  echo "   Stop it first with: npm run dev:down"
  exit 1
fi

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

echo "⏳ Waiting for storefront at http://localhost:3000..."
until curl -sf http://localhost:3000 > /dev/null 2>&1; do
  sleep 2
done
echo "✓ Storefront ready"

# --- Step 5: Start workers ---
step "Starting Temporal workers"
npm run dev:worker &
WORKER_PID=$!

echo "⏳ Waiting for workers to register pollers..."
npm run workers-wait
echo "✓ All workers ready"

# --- Step 6: Verify deep health ---
step "Verifying deep health"
until curl -sf http://localhost:3000/api/health > /dev/null 2>&1; do
  sleep 2
done
echo "✓ All services healthy (Cassandra, Elasticsearch, Temporal)"

# --- Step 7: Seed data ---
step "Seeding demo data"
npm run dev:seed

# --- Step 8: Shutdown temporary processes ---
step "Cleaning up"
cleanup
trap - EXIT
echo "✓ Storefront and workers stopped"

# ── Final Summary ──────────────────────────────────────────────────────────
DONE=$(date +%s)
STEP_DURATIONS+=( $(( DONE - STEP_START )) )
TOTAL_ELAPSED=$(( DONE - INIT_START ))

echo ""
echo "════════════════════════════════════════════════════════"
echo "  ✨ Full reset & seeding complete!"
echo ""
echo "  Timing breakdown:"
for i in "${!STEP_NAMES[@]}"; do
  dur=${STEP_DURATIONS[$i]}
  printf "    %d. %-40s %dm %02ds\n" $(( i + 1 )) "${STEP_NAMES[$i]}" $(( dur / 60 )) $(( dur % 60 ))
done
echo "    ────────────────────────────────────────────────"
printf "    Total                                          %dm %02ds\n" $(( TOTAL_ELAPSED / 60 )) $(( TOTAL_ELAPSED % 60 ))
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
