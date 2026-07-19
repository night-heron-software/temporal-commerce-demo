#!/bin/sh
# Register the custom Temporal Search Attributes used to correlate related workflows
# (cart → checkout → order → fulfillment → fulfiller-order).
#
# Runs as a one-shot sidecar after the namespace exists. Idempotent: an attribute that
# already exists is left untouched. The attribute names/types must match
# SEARCH_ATTRIBUTE_KEYS in src/temporal/contracts/constants.ts.
set -eu

: "${TEMPORAL_ADDRESS:?TEMPORAL_ADDRESS required}"
NS="${DEFAULT_NAMESPACE:-default}"

# All correlation attributes are Keyword (exact-match, filterable).
ATTRS="CorrelationId StoreId Domain OrderId CartId"

echo "Waiting for namespace ${NS} to exist at ${TEMPORAL_ADDRESS}..."
until temporal operator namespace describe --address "${TEMPORAL_ADDRESS}" "${NS}" >/dev/null 2>&1; do
  sleep 1
done
echo "Namespace ${NS} is present."

existing="$(temporal operator search-attribute list \
  --address "${TEMPORAL_ADDRESS}" --namespace "${NS}" 2>/dev/null || true)"

for name in ${ATTRS}; do
  if printf '%s\n' "${existing}" | grep -qw "${name}"; then
    echo "Search attribute ${name} already registered."
  else
    temporal operator search-attribute create \
      --address "${TEMPORAL_ADDRESS}" \
      --namespace "${NS}" \
      --name "${name}" \
      --type Keyword
    echo "Search attribute ${name} (Keyword) created."
  fi
done

echo "Search attribute registration complete."
