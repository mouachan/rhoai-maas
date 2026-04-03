#!/bin/bash
# Deploy MaaS Portal to OpenShift (frontend + backend + RBAC groups)
# Usage: ./deploy.sh [--build]
#
# Prerequisites:
#   - oc CLI logged in to the cluster
#   - podman (only if --build is specified)
#
# Environment variables (optional):
#   FRONTEND_IMAGE  - Frontend image (default: quay.io/mouachan/maas/maas-portal-frontend:v2)
#   BACKEND_IMAGE   - Backend image (default: quay.io/mouachan/maas/maas-portal-api:v2)
#   NAMESPACE       - Deployment namespace (default: maas-demo)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_IMAGE="${FRONTEND_IMAGE:-quay.io/mouachan/maas/maas-portal-frontend:v2}"
BACKEND_IMAGE="${BACKEND_IMAGE:-quay.io/mouachan/maas/maas-portal-api:v2}"
NAMESPACE="${NAMESPACE:-maas-demo}"

# Detect cluster domain
CLUSTER_DOMAIN=$(oc get ingresses.config.openshift.io cluster -o jsonpath='{.spec.domain}')
GATEWAY_URL="https://maas.${CLUSTER_DOMAIN}"
GRAFANA_URL="https://grafana-route-user-grafana.${CLUSTER_DOMAIN}"

echo "=== MaaS Portal Deployment ==="
echo "  Cluster domain  : ${CLUSTER_DOMAIN}"
echo "  Gateway URL     : ${GATEWAY_URL}"
echo "  Grafana URL     : ${GRAFANA_URL}"
echo "  Frontend image  : ${FRONTEND_IMAGE}"
echo "  Backend image   : ${BACKEND_IMAGE}"
echo "  Namespace       : ${NAMESPACE}"
echo ""

# Build and push if --build flag is set
if [[ "${1:-}" == "--build" ]]; then
  echo ">>> Building backend image..."
  podman build --platform linux/amd64 -t "${BACKEND_IMAGE}" "${SCRIPT_DIR}/backend"
  echo ">>> Pushing backend image..."
  podman push "${BACKEND_IMAGE}"
  echo ">>> Backend image pushed: ${BACKEND_IMAGE}"
  echo ""

  echo ">>> Building frontend image..."
  podman build --platform linux/amd64 -t "${FRONTEND_IMAGE}" "${SCRIPT_DIR}/frontend"
  echo ">>> Pushing frontend image..."
  podman push "${FRONTEND_IMAGE}"
  echo ">>> Frontend image pushed: ${FRONTEND_IMAGE}"
  echo ""
fi

# --- Step 1: OpenShift Groups (RBAC + tier mapping) ---
echo ">>> Applying OpenShift groups..."
oc apply -f "${SCRIPT_DIR}/openshift/groups.yaml"

# --- Step 2: Create namespace ---
echo ">>> Creating namespace ${NAMESPACE}..."
oc create namespace "${NAMESPACE}" --dry-run=client -o yaml | oc apply -f -

# --- Step 3: Generate cookie secret and deploy manifests ---
COOKIE_SECRET=$(openssl rand -hex 16)

echo ">>> Deploying application..."
sed -e "s|REPLACE_GATEWAY_URL|${GATEWAY_URL}|g" \
    -e "s|REPLACE_GRAFANA_URL|${GRAFANA_URL}|g" \
    -e "s|REPLACE_COOKIE_SECRET|${COOKIE_SECRET}|g" \
    -e "s|quay.io/mouachan/maas/maas-portal-api:v2|${BACKEND_IMAGE}|g" \
    -e "s|quay.io/mouachan/maas/maas-portal-frontend:v2|${FRONTEND_IMAGE}|g" \
    "${SCRIPT_DIR}/openshift/deployment.yaml" | oc apply -f -

# --- Step 4: OAuth proxy RBAC ---
echo ">>> Setting up OAuth proxy RBAC..."
oc adm policy add-cluster-role-to-user system:auth-delegator \
    "system:serviceaccount:${NAMESPACE}:maas-portal"

# --- Step 5: Wait for rollouts ---
echo ">>> Waiting for backend rollout..."
oc rollout status deployment/maas-portal-api -n "${NAMESPACE}" --timeout=120s

echo ">>> Waiting for frontend rollout..."
oc rollout status deployment/maas-portal-frontend -n "${NAMESPACE}" --timeout=120s

# --- Done ---
ROUTE_URL=$(oc get route maas-portal -n "${NAMESPACE}" -o jsonpath='https://{.spec.host}')
echo ""
echo "=== Deployment complete ==="
echo "  Portal URL: ${ROUTE_URL}"
echo ""
echo "Open the URL in your browser -- OpenShift OAuth login will be used automatically."
echo ""
echo "Users and roles:"
echo "  mouachani   - enterprise tier, admin"
echo "  ptruong     - free tier, admin"
echo "  hkenniche   - premium tier"
echo "  atiouajni   - restricted tier (no model access)"
