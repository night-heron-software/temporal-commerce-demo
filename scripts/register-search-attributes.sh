#!/usr/bin/env bash
# Register the custom Temporal Search Attributes used to correlate related workflows
# (cart → checkout → order → fulfillment → fulfiller-order), ported from nightheron-mono
# (ADR-0011).
#
# Registration normally happens automatically: docker-compose runs the
# temporal-register-search-attributes one-shot sidecar after namespace creation.
# This host-side script exists for manual (re-)registration and as the belt to that
# suspender — it runs the same idempotent sidecar script in a throwaway admin-tools
# container on the compose network (the temporalio/server image ships no temporal CLI).
#
# For Temporal Cloud, register the same five Keyword attributes once via the Cloud UI
# (Namespace → Search Attributes) or:
#   tcld namespace search-attributes add --namespace <ns> \
#     --search-attribute "CorrelationId=Keyword" --search-attribute "StoreId=Keyword" \
#     --search-attribute "Domain=Keyword" --search-attribute "OrderId=Keyword" \
#     --search-attribute "CartId=Keyword"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
NS="${TEMPORAL_NAMESPACE:-default}"
ADMIN_TOOLS_IMAGE="${ADMIN_TOOLS_IMAGE:-temporalio/admin-tools:1.31.1}"

NET="$(docker network ls --format '{{.Name}}' | grep 'demo-net$' | head -1)"
if [ -z "${NET}" ]; then
  echo "ERROR: demo-net docker network not found — is the infrastructure running (npm run infra:up)?" >&2
  exit 1
fi

docker run --rm \
  --network "${NET}" \
  -v "${REPO_ROOT}/infra/temporal/scripts:/scripts:ro" \
  -e TEMPORAL_ADDRESS=temporal:7233 \
  -e DEFAULT_NAMESPACE="${NS}" \
  "${ADMIN_TOOLS_IMAGE}" \
  /bin/sh /scripts/register-search-attributes.sh
