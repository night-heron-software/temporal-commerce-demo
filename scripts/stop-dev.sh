#!/bin/bash

# 1. Remove Lock File
LOCK_FILE=".next/dev/lock"
if [ -f "$LOCK_FILE" ]; then
  echo "Removing lock file: $LOCK_FILE"
  rm "$LOCK_FILE"
fi

# 2. Kill Node Processes
echo "Stopping temporal-commerce-demo app processes..."
pkill -f 'next dev' || true
pkill -f 'next-server' || true
pkill -f 'tsx.*worker\.ts' || true

# 3. Verify Ports are Free
PORTS=(3000)
TIMEOUT=10
start_time=$(date +%s)

for port in "${PORTS[@]}"; do
  echo "Checking port $port..."
  while lsof -i :$port > /dev/null 2>&1; do
      current_time=$(date +%s)
      elapsed=$((current_time - start_time))
      
      if [ $elapsed -ge $TIMEOUT ]; then
         echo "WARNING: Port $port is still in use after $TIMEOUT seconds. Attempting force kill..."
         # Find PID using port and kill -9
         lsof -ti :$port | xargs kill -9 2>/dev/null || true
         sleep 1
         break
      fi
      
      echo "  Waiting for port $port to free up..."
      sleep 1
  done
  
  # Final check
  if ! lsof -i :$port > /dev/null 2>&1; then
      echo "✓ Port $port is free"
  else
      echo "⨯ Port $port is still occupied"
  fi
done

echo "✓ Dev environment stopped"
