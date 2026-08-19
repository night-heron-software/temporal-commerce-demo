#!/usr/bin/env bash
set -euo pipefail

# Change to repo root so script works from any directory
cd "$(dirname "$0")/.."

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

# Tables referenced in TypeScript source code.
# R8 (remediation ledger): the old extraction grepped raw text, so prose comments
# ("a blind UPDATE would upsert…" → `would`) and keyspace-qualified system reads
# (`FROM system_schema.tables` → `system_schema`) surfaced as phantom "missing tables".
#  - comment lines (// and *) are stripped before matching
#  - dotted tokens are dropped: src/ queries are session-keyspace unqualified, so a
#    dotted reference is another keyspace (system_schema) — not a catalog table
code_tables=$(grep -rh --include='*.ts' -E "(FROM|INSERT INTO|UPDATE) [a-z_.]+" src/ \
  | grep -vE '^\s*(//|\*|/\*)' \
  | grep -oE "(FROM|INSERT INTO|UPDATE) [a-z_.]+" \
  | sed -E 's/(FROM|INSERT INTO|UPDATE) //' \
  | grep -v '\.' \
  | sort -u)

missing=$(comm -23 <(echo "$code_tables") <(echo "$schema_tables"))
unused=$(comm -13 <(echo "$code_tables") <(echo "$schema_tables"))

echo ""
echo "=== In code but NOT in schema (CRITICAL MISSING TABLES) ==="
echo "${missing:-  (none)}"

echo ""
echo "=== In schema but NOT in code (UNUSED TABLES — informational) ==="
echo "${unused:-  (none)}"

echo ""
echo "════════════════════════════════════════════════════════"

# R8: the gate must be able to FAIL (F1's lesson — a check that always exits 0 is a
# no-op). Missing tables are the critical class; unused tables stay informational.
if [ -n "$missing" ]; then
  echo "❌ FAIL: code references tables the schema does not define."
  exit 1
fi
echo "✓ schema and code agree"
