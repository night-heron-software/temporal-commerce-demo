---
description: Verify Cassandra schema consistency with TypeScript types and workflow usage
---

# Cassandra Schema Verification Workflow

Verifies that `cassandra/schema.cql` creates all tables and columns used by the Temporal workers and API routes.

## Schema File

The demo uses a single consolidated schema file:

| File | Contents |
| --- | --- |
| `cassandra/schema.cql` | All tables: catalog, orders, inventory, suppliers, carts |

## Prerequisites

- Access to the file system to `grep` source files
- Cassandra running with schema applied (`make dev && make db-init`)

## Step 1: Extract DDL Table Definitions

// turbo

```bash
grep -E "^CREATE TABLE" cassandra/schema.cql | sed 's/CREATE TABLE IF NOT EXISTS catalog\.//' | sed 's/ (.*//' | sort
```

## Step 2: Extract Query Targets from Source

Find all tables referenced in TypeScript source:

// turbo

```bash
grep -rhoE "FROM [a-z_]+" src/ --include='*.ts' | sed 's/FROM //' | sort -u
```

Also check INSERT/UPDATE targets:

// turbo

```bash
grep -rhoE "(INSERT INTO|UPDATE) [a-z_]+" src/ --include='*.ts' | sed 's/INSERT INTO //' | sed 's/UPDATE //' | sort -u
```

## Step 3: Cross-Reference Tables

Compare tables defined in DDL with tables referenced in code:

```bash
# Tables in schema
schema_tables=$(grep -E "^CREATE TABLE" cassandra/schema.cql | sed 's/CREATE TABLE IF NOT EXISTS catalog\.//' | sed 's/ (.*//' | sort)

# Tables in code
code_tables=$(grep -rhoE "(FROM|INSERT INTO|UPDATE) [a-z_]+" src/ --include='*.ts' | sed 's/FROM //' | sed 's/INSERT INTO //' | sed 's/UPDATE //' | sort -u)

# Diff
echo "=== In code but NOT in schema (CRITICAL) ==="
comm -23 <(echo "$code_tables") <(echo "$schema_tables")

echo ""
echo "=== In schema but NOT in code (cleanup candidate) ==="
comm -13 <(echo "$code_tables") <(echo "$schema_tables")
```

## Step 4: Verify via CQL Shell

```bash
docker exec -it demo-cassandra cqlsh -e "DESCRIBE KEYSPACE catalog;"
```

## Step 5: Document Findings

1. **Critical:** Tables used in code but not in DDL
2. **Warning:** Columns used but not in DDL table definitions
3. **TypeScript/CQL type mismatches** (e.g., `INT` vs `number`, `TEXT` vs `string`)
4. **Unused tables** (candidates for removal from DDL)
