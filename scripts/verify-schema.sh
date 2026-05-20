#!/usr/bin/env bash
set -eo pipefail

echo "════════════════════════════════════════════════════════"
echo "  Cassandra Schema Verification Tool"
echo "════════════════════════════════════════════════════════"

# Files check
if [ ! -f cassandra/schema.cql ]; then
  echo "❌ Error: cassandra/schema.cql not found"
  exit 1
fi

# Tables defined in schema (DDL)
schema_tables=$(grep -E "^CREATE TABLE" cassandra/schema.cql | sed -E 's/CREATE TABLE (IF NOT EXISTS )?//; s/ \(.*//; s/catalog\.//' | sort)

# Tables referenced in TypeScript source code
code_tables=$(grep -rhoE "(FROM|INSERT INTO|UPDATE) [a-z_]+" src/ --include='*.ts' | sed 's/FROM //' | sed 's/INSERT INTO //' | sed 's/UPDATE //' | sort -u)

echo ""
echo "=== In code but NOT in schema (CRITICAL MISSING TABLES) ==="
comm -23 <(echo "$code_tables") <(echo "$schema_tables")

echo ""
echo "=== In schema but NOT in code (UNUSED TABLES) ==="
comm -13 <(echo "$code_tables") <(echo "$schema_tables")

echo ""
echo "════════════════════════════════════════════════════════"
