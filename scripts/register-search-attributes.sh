#!/usr/bin/env bash
# Register the custom Temporal Search Attributes used to correlate related workflows
# (cart → checkout → order → fulfillment → fulfiller-order), ported from nightheron-mono
# (ADR-0011).
#
# Runs against the local demo-temporal container via docker exec (the auto-setup image
# ships the `temporal` CLI). Idempotent: an attribute that already exists is left
# untouched. The attribute names/types must match SEARCH_ATTRIBUTE_KEYS in
# src/temporal/contracts/constants.ts.
#
# For Temporal Cloud, register the same five Keyword attributes once via the Cloud UI
# (Namespace → Search Attributes) or:
#   tcld namespace search-attributes add --namespace <ns> \
#     --search-attribute "CorrelationId=Keyword" --search-attribute "StoreId=Keyword" \
#     --search-attribute "Domain=Keyword" --search-attribute "OrderId=Keyword" \
#     --search-attribute "CartId=Keyword"
set -euo pipefail

CONTAINER="${TEMPORAL_CONTAINER:-demo-temporal}"
NS="${TEMPORAL_NAMESPACE:-default}"
# The auto-setup server binds to the container's network IP, not loopback, so the
# in-container CLI must be pointed at the container hostname explicitly.
ADDR="${TEMPORAL_CONTAINER_ADDRESS:-${CONTAINER}:7233}"

# All correlation attributes are Keyword (exact-match, filterable).
ATTRS="CorrelationId StoreId Domain OrderId CartId"

echo "Waiting for namespace ${NS} to exist in ${CONTAINER}..."
until docker exec "${CONTAINER}" temporal operator namespace describe --address "${ADDR}" -n "${NS}" >/dev/null 2>&1; do
  sleep 1
done

existing="$(docker exec "${CONTAINER}" temporal operator search-attribute list --address "${ADDR}" --namespace "${NS}" 2>/dev/null || true)"

for name in ${ATTRS}; do
  if printf '%s\n' "${existing}" | grep -qw "${name}"; then
    echo "Search attribute ${name} already registered."
  else
    docker exec "${CONTAINER}" temporal operator search-attribute create \
      --address "${ADDR}" \
      --namespace "${NS}" \
      --name "${name}" \
      --type Keyword
    echo "Search attribute ${name} (Keyword) created."
  fi
done

echo "✓ Search attribute registration complete."
