#!/bin/sh
# Temporal PostgreSQL schema setup (main/default datastore).
#
# Replaces the schema-init that the deprecated temporalio/auto-setup image used to
# perform. Logic mirrors auto-setup.sh's setup_postgres_schema() for ENABLE_ES=true:
# visibility is served by Elasticsearch, so the SQL visibility datastore is NOT created
# here (see setup-es-index.sh).
#
# Idempotent: `create` and `setup-schema` only matter on first run and are tolerated
# on re-runs; `update-schema` is version-aware and safe to re-run, and brings an
# existing (e.g. 1.29-era) datastore forward to the current server version.
set -eu

: "${POSTGRES_SEEDS:?POSTGRES_SEEDS required}"
: "${POSTGRES_USER:?POSTGRES_USER required}"
: "${POSTGRES_PWD:?POSTGRES_PWD required}"
DB_PORT="${DB_PORT:-5432}"
DBNAME="${DBNAME:-temporal}"
SCHEMA_DIR=/etc/temporal/schema/postgresql/v12/temporal/versioned

# temporal-sql-tool reads the password from SQL_PASSWORD.
export SQL_PASSWORD="${POSTGRES_PWD}"

echo "Waiting for PostgreSQL at ${POSTGRES_SEEDS}:${DB_PORT}..."
until nc -z "${POSTGRES_SEEDS}" "${DB_PORT}"; do sleep 1; done
echo "PostgreSQL is up."

sql() {
  temporal-sql-tool \
    --plugin postgres12 \
    --ep "${POSTGRES_SEEDS}" \
    -u "${POSTGRES_USER}" \
    -p "${DB_PORT}" \
    --db "${DBNAME}" \
    "$@"
}

sql create || echo "Database ${DBNAME} already exists, continuing."
sql setup-schema -v 0.0 || echo "Schema already initialized, continuing."
sql update-schema -d "${SCHEMA_DIR}"

echo "SQL schema ready for database '${DBNAME}'."
