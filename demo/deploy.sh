#!/bin/bash
# Deploy MaaS Demo App to OpenShift
# Usage: ./deploy.sh [--build]
#
# Prerequisites:
#   - oc CLI logged in to the cluster
#   - podman (only if --build is specified)
#
# Environment variables (optional):
#   IMAGE_REPO    - Container image repository (default: quay.io/mouachan/maas/maas-demo)
#   IMAGE_TAG     - Image tag (default: latest)
#   MODEL_PATH    - Model path (default: llm/redhataillama-4-scout-17b-16e-instruct-quantizedw4a16)
#   NAMESPACE     - Deployment namespace (default: maas-demo)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_REPO="${IMAGE_REPO:-quay.io/mouachan/maas/maas-demo}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE="${IMAGE_REPO}:${IMAGE_TAG}"
MODEL_PATH="${MODEL_PATH:-llm/redhataillama-4-scout-17b-16e-instruct-quantizedw4a16}"
NAMESPACE="${NAMESPACE:-maas-demo}"

# Detect cluster domain
CLUSTER_DOMAIN=$(oc get ingresses.config.openshift.io cluster -o jsonpath='{.spec.domain}')
GATEWAY_URL="https://maas.${CLUSTER_DOMAIN}"
GRAFANA_URL="https://grafana-route-user-grafana.${CLUSTER_DOMAIN}"

echo "=== MaaS Demo Deployment ==="
echo "  Cluster domain : ${CLUSTER_DOMAIN}"
echo "  Gateway URL    : ${GATEWAY_URL}"
echo "  Grafana URL    : ${GRAFANA_URL}"
echo "  Model path     : ${MODEL_PATH}"
echo "  Image          : ${IMAGE}"
echo "  Namespace      : ${NAMESPACE}"
echo ""

# Build and push if --build flag is set
if [[ "${1:-}" == "--build" ]]; then
  echo ">>> Building container image..."
  podman build --platform linux/amd64 -t "${IMAGE}" "${SCRIPT_DIR}"
  echo ">>> Pushing image..."
  podman push "${IMAGE}"
  echo ">>> Image pushed: ${IMAGE}"
  echo ""
fi

# Create namespace
echo ">>> Creating namespace ${NAMESPACE}..."
oc create namespace "${NAMESPACE}" --dry-run=client -o yaml | oc apply -f -

# Apply manifests with substituted values
echo ">>> Deploying application..."
sed -e "s|REPLACE_GATEWAY_URL|${GATEWAY_URL}|g" \
    -e "s|REPLACE_GRAFANA_URL|${GRAFANA_URL}|g" \
    -e "s|quay.io/mouachan/maas/maas-demo:latest|${IMAGE}|g" \
    -e "s|llm/redhataillama-4-scout-17b-16e-instruct-quantizedw4a16|${MODEL_PATH}|g" \
    "${SCRIPT_DIR}/openshift/deployment.yaml" | oc apply -f -

# Wait for rollout
echo ">>> Waiting for rollout..."
oc rollout status deployment/maas-demo -n "${NAMESPACE}" --timeout=120s

# Get route URL
ROUTE_URL=$(oc get route maas-demo -n "${NAMESPACE}" -o jsonpath='https://{.spec.host}')
echo ""
echo "=== Deployment complete ==="
echo "  Demo URL: ${ROUTE_URL}"
echo ""
echo "Login with your OpenShift token:"
echo "  oc whoami -t"
