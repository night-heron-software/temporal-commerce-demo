#!/bin/sh
# Register the demo namespace after the Temporal server is serving.
#
# The temporalio/server image (unlike the deprecated auto-setup image) does not
# create namespaces, so this one-shot sidecar does it. Idempotent: skips creation
# if the namespace already exists.
set -eu

: "${TEMPORAL_ADDRESS:?TEMPORAL_ADDRESS required}"
NS="${DEFAULT_NAMESPACE:-default}"
RETENTION="${NAMESPACE_RETENTION:-24h}"

echo "Waiting for Temporal server at ${TEMPORAL_ADDRESS} to be SERVING..."
until temporal operator cluster health --address "${TEMPORAL_ADDRESS}" 2>/dev/null | grep -q SERVING; do
  sleep 1
done
echo "Temporal server is SERVING."

if temporal operator namespace describe --address "${TEMPORAL_ADDRESS}" "${NS}" >/dev/null 2>&1; then
  echo "Namespace ${NS} already registered."
else
  temporal operator namespace create \
    --address "${TEMPORAL_ADDRESS}" \
    --retention "${RETENTION}" \
    --description "temporal-commerce-demo development namespace." \
    "${NS}"
  echo "Namespace ${NS} created."
fi
