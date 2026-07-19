#!/bin/sh
# Elasticsearch visibility index setup for Temporal.
#
# Replaces auto-setup.sh's setup_es_index(). Runs in a curl-capable image because
# temporalio/admin-tools (Alpine/BusyBox) ships wget without PUT support. The ES v7
# schema files are extracted from the admin-tools image and committed under ./es,
# then mounted into this container at /es-schema.
set -eu

: "${ES_SEEDS:?ES_SEEDS required}"
ES_SCHEME="${ES_SCHEME:-http}"
ES_PORT="${ES_PORT:-9200}"
ES_VIS_INDEX="${ES_VIS_INDEX:-temporal_visibility_v1_dev}"
ES_SERVER="${ES_SCHEME}://${ES_SEEDS}:${ES_PORT}"
SETTINGS_FILE=/es-schema/cluster_settings_v7.json
TEMPLATE_FILE=/es-schema/index_template_v7.json

echo "Waiting for Elasticsearch at ${ES_SERVER}..."
until curl -s -f "${ES_SERVER}" >/dev/null; do sleep 1; done
echo "Elasticsearch is up."

curl -sf -X PUT "${ES_SERVER}/_cluster/settings" \
  -H 'Content-Type: application/json' --data-binary "@${SETTINGS_FILE}" -w '\n'
curl -sf -X PUT "${ES_SERVER}/_template/temporal_visibility_v1_template" \
  -H 'Content-Type: application/json' --data-binary "@${TEMPLATE_FILE}" -w '\n'
# Index creation is non-fatal when the index already exists (re-run case).
curl -s -X PUT "${ES_SERVER}/${ES_VIS_INDEX}" -w '\n' || true

echo "Elasticsearch visibility index '${ES_VIS_INDEX}' ready."
