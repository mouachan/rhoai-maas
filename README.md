# RHOAI Models-as-a-Service (MaaS) - Deployment Guide

End-to-end deployment and configuration of Models-as-a-Service on Red Hat OpenShift AI 3.3 with Kuadrant-based authentication and tier-based access control.

## How MaaS Works

Models-as-a-Service (MaaS) is a Tech Preview feature in RHOAI 3.3 that provides governed, multi-tenant access to LLM inference endpoints. Instead of giving users direct access to model serving endpoints, MaaS introduces a gateway layer with authentication, authorization, and tier-based rate limiting.

### Architecture Overview

```
                                    ┌─────────────────────────┐
                                    │   RHOAI Dashboard       │
                                    │  ┌──────────┐           │
                                    │  │ maas-ui  │ (port 8243)  ← Tier management UI
                                    │  └──────────┘           │
                                    │  ┌──────────┐           │
                                    │  │gen-ai-ui │ (port 8143)  ← Model listing, token gen
                                    │  └──────────┘           │
                                    └──────────┬──────────────┘
                                               │ autodiscovers URL from
                                               │ Gateway listener hostname
                                               ▼
User ── OCP Token ──► maas-api ──► MaaS SA Token ──► Gateway (Envoy + Kuadrant)
              │          (token                          │
              │           exchange)                      │ AuthPolicy validates
              │                                          │ audience + tier RBAC
              ▼                                          ▼
        POST /v1/tokens                         ┌──────────────┐
        GET  /v1/models                         │ LLMInference │
                                                │   Service    │
                                                │  (vLLM pod)  │
                                                └──────────────┘
```

### Token Flow

MaaS uses a two-step token exchange to access model inference endpoints:

1. **OCP Token → MaaS SA Token**: The user sends their OpenShift token to `POST /maas-api/v1/tokens`. The `maas-api` validates the OCP token via Kubernetes TokenReview, looks up the user's tier based on their group membership, creates a ServiceAccount in the tier namespace, and returns a short-lived SA JWT with audience `maas-default-gateway-sa`.

2. **MaaS SA Token → Inference**: The user sends the MaaS SA token as `Authorization: Bearer <token>` to the model inference endpoint (e.g., `POST /llm/<model-name>/v1/chat/completions`). The Kuadrant `gateway-auth-policy` validates the token via Kubernetes TokenReview with audience `maas-default-gateway-sa`, checks RBAC authorization (tier-based SubjectAccessReview), and forwards the request to the vLLM pod.

### Kuadrant AuthPolicy Hierarchy

MaaS relies on two AuthPolicies managed by the `ModelsAsService` operator:

| Policy | Scope | Target | Purpose |
|--------|-------|--------|---------|
| `gateway-auth-policy` | Gateway-level | `maas-default-gateway` | Validates MaaS SA tokens (audience `maas-default-gateway-sa`), checks tier-based RBAC, injects tier metadata |
| `maas-api-auth-policy` | Route-level | `maas-api-route` HTTPRoute | Validates OCP tokens OR MaaS SA tokens (dual audience), injects `X-MaaS-Username` and `X-MaaS-Group` headers |

The route-level `maas-api-auth-policy` overrides the gateway-level policy for the `maas-api-route`, allowing the maas-api to accept standard OCP tokens while the inference endpoints require MaaS SA tokens.

### Tier System

Tiers map OpenShift groups to access levels. The `tier-to-group-mapping` ConfigMap in `redhat-ods-applications` defines the mapping:

```yaml
tiers:
  - name: free
    displayName: Free Tier
    level: 0          # lower = less privileged
    groups:
      - tier-free-users
      - system:authenticated    # all authenticated users get free tier by default

  - name: premium
    level: 1
    groups:
      - tier-premium-users

  - name: enterprise
    level: 2
    groups:
      - tier-enterprise-users
```

When a user requests a MaaS token, the `maas-api` calls `/v1/tiers/lookup` with the user's groups to determine their highest tier. The token is then scoped to a ServiceAccount in the tier namespace with appropriate RBAC.

### Gateway and Dashboard Autodiscovery

The RHOAI dashboard includes a `gen-ai-ui` container (BFF - Backend For Frontend) that serves the "AI asset endpoints" page. This BFF autodiscovers the MaaS API URL by:

1. Reading the `maas-default-gateway` Gateway resource
2. Extracting the **listener hostname** from the Gateway spec
3. Constructing the URL as `https://<listener-hostname>/maas-api/...`

**This is why setting a hostname on the Gateway listener is critical** — without it, the BFF cannot construct the URL and the dashboard shows "MaaS service is not available".

## Prerequisites

- OpenShift 4.17+
- RHOAI 3.3 operator installed
- Red Hat Connectivity Link (RHCL/Kuadrant) operator v1.3.0+ installed
- Kuadrant CR created in `kuadrant-system` namespace
- GPU nodes available (4x NVIDIA L40 for Llama-4-Scout)
- `data-science-gateway-class` GatewayClass present (created by RHOAI)
- `modelsAsService.managementState: Managed` in the DataScienceCluster

## Quick Start with Helm

### 1. Get the cluster domain

```bash
CLUSTER_DOMAIN=$(oc get ingresses.config.openshift.io cluster -o jsonpath='{.spec.domain}')
echo $CLUSTER_DOMAIN
```

### 2. Install the Helm chart

```bash
helm install rhoai-maas ./helm/rhoai-maas \
  --set clusterDomain=$CLUSTER_DOMAIN
```

### 3. Wait for the model to be ready

```bash
oc wait --for=condition=Ready llminferenceservice \
  -n llm redhataillama-4-scout-17b-16e-instruct-quantizedw4a16 \
  --timeout=600s
```

### 4. Verify the setup

```bash
# Get a MaaS token
OCP_TOKEN=$(oc whoami -t)
GATEWAY_HOST=$(oc get gateway maas-default-gateway -n openshift-ingress \
  -o jsonpath='{.spec.listeners[0].hostname}')

MAAS_TOKEN=$(curl -sk "https://${GATEWAY_HOST}/maas-api/v1/tokens" \
  -H "Authorization: Bearer $OCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq -r '.token')

# List models
curl -sk "https://${GATEWAY_HOST}/v1/models" \
  -H "Authorization: Bearer $MAAS_TOKEN" | jq .

# Chat completion
curl -sk "https://${GATEWAY_HOST}/llm/redhataillama-4-scout-17b-16e-instruct-quantizedw4a16/v1/chat/completions" \
  -H "Authorization: Bearer $MAAS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "redhataillama-4-scout-17b-16e-instruct-quantizedw4a16",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 50
  }' | jq .choices[0].message.content
```

## Manual Step-by-Step Setup

If you prefer to set things up manually instead of using the Helm chart:

### Step 1: Enable ModelsAsService in the DataScienceCluster

```bash
oc patch datasciencecluster default-dsc --type='merge' -p '{
  "spec": {
    "components": {
      "kserve": {
        "modelsAsService": {
          "managementState": "Managed"
        }
      }
    }
  }
}'
```

This triggers the RHOAI operator to deploy:
- `maas-api` (Deployment, Service, HTTPRoute)
- `maas-default-gateway` (Gateway)
- `gateway-auth-policy` and `maas-api-auth-policy` (AuthPolicies)
- `tier-to-group-mapping` (ConfigMap)
- `maas-parameters` (ConfigMap)
- Dashboard sidecar containers (`gen-ai-ui`, `maas-ui`)

### Step 2: Enable modelAsService in the dashboard config

```bash
oc patch odhdashboardconfig odh-dashboard-config \
  -n redhat-ods-applications --type='merge' \
  -p '{"spec":{"dashboardConfig":{"modelAsService":true}}}'
```

### Step 3: Patch the Gateway listener with a hostname

The Gateway is created without a hostname, which breaks the dashboard BFF autodiscovery. You must set the hostname and use a valid TLS certificate.

```bash
CLUSTER_DOMAIN=$(oc get ingresses.config.openshift.io cluster -o jsonpath='{.spec.domain}')
GATEWAY_HOSTNAME="maas.${CLUSTER_DOMAIN}"

# Copy the wildcard cert to the gateway namespace
oc get secret cert-manager-ingress-cert -n openshift-ingress -o json \
  | jq 'del(.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.annotations,.metadata.ownerReferences) | .metadata.name = "maas-gateway-wildcard-tls"' \
  | oc apply -n openshift-ingress -f -

# Patch the Gateway listener
oc patch gateway maas-default-gateway -n openshift-ingress --type='json' -p="[
  {\"op\":\"replace\",\"path\":\"/spec/listeners/0/hostname\",\"value\":\"${GATEWAY_HOSTNAME}\"},
  {\"op\":\"replace\",\"path\":\"/spec/listeners/0/tls/certificateRefs/0/name\",\"value\":\"maas-gateway-wildcard-tls\"}
]"
```

### Step 4: Label the Gateway to prevent conflicting AuthPolicy

The `odh-model-controller` automatically creates an AuthPolicy `maas-default-gateway-authn` on the Gateway when a model is deployed. This policy conflicts with the `gateway-auth-policy` by using a different token audience (`https://kubernetes.default.svc` instead of `maas-default-gateway-sa`), causing the MaaS auth flow to break.

To prevent this, label the Gateway with `opendatahub.io/managed: "false"`:

```bash
oc label gateway maas-default-gateway -n openshift-ingress \
  opendatahub.io/managed=false
```

> **Important**: This must be a **label**, not an annotation. The `odh-model-controller` checks labels (not annotations) for this flag. See [PR #559](https://github.com/opendatahub-io/odh-model-controller/pull/559).

### Step 5: Grant the dashboard SA permission to read Gateways

The dashboard `gen-ai-ui` BFF needs to read the Gateway resource to autodiscover the MaaS API URL. The dashboard ServiceAccount does not have this permission by default.

```bash
oc create clusterrole maas-gateway-reader \
  --verb=get,list,watch \
  --resource=gateways.gateway.networking.k8s.io

oc create clusterrolebinding maas-dashboard-gateway-reader \
  --clusterrole=maas-gateway-reader \
  --serviceaccount=redhat-ods-applications:rhods-dashboard
```

### Step 6: Create the model namespace and deploy the model

```bash
oc create namespace llm

# Deploy from the RHOAI dashboard UI:
# 1. Go to Model Catalog → select the model
# 2. Click "Deploy" → choose namespace "llm"
# 3. Check "Publish as MaaS endpoint"
# 4. Select "All tiers" and enable "Token authentication"
# 5. Deploy
```

Or apply the LLMInferenceService YAML directly (see the Helm chart template for the full spec).

### Step 7: Verify the tiers annotation

After deploying from the UI, the tiers annotation may be empty. Verify and fix:

```bash
# Check current tiers
oc get llminferenceservice -n llm \
  -o jsonpath='{.items[0].metadata.annotations.alpha\.maas\.opendatahub\.io/tiers}'

# If empty, patch it
oc annotate llminferenceservice -n llm \
  redhataillama-4-scout-17b-16e-instruct-quantizedw4a16 \
  'alpha.maas.opendatahub.io/tiers=["free","premium","enterprise"]' \
  --overwrite
```

### Step 8: Restart the dashboard pods

After all configuration changes, restart the dashboard to pick up the Gateway hostname:

```bash
oc rollout restart deployment/rhods-dashboard -n redhat-ods-applications
oc rollout status deployment/rhods-dashboard -n redhat-ods-applications
```

## Troubleshooting

### Dashboard shows "No models available as a service"

**Root cause**: The `gen-ai-ui` BFF cannot autodiscover the MaaS API URL.

Check the BFF startup logs:
```bash
oc logs deployment/rhods-dashboard -n redhat-ods-applications \
  -c gen-ai-ui --tail=20 | grep -v "TLS handshake"
```

Look for:
```
"Using real MaaS client factory" url=""
```

If `url=""`, the autodiscovery failed. Verify:

1. **Gateway has a hostname**: `oc get gateway maas-default-gateway -n openshift-ingress -o jsonpath='{.spec.listeners[0].hostname}'`
2. **Dashboard SA can read Gateways**: `oc auth can-i get gateways.gateway.networking.k8s.io --as=system:serviceaccount:redhat-ods-applications:rhods-dashboard -n openshift-ingress`
3. **TLS cert matches hostname**: Check the cert SAN covers the Gateway hostname

**Workaround** (if autodiscovery still fails): Set the `MAAS_URL` env var directly (will be reverted by operator on reconciliation):
```bash
GATEWAY_HOST=$(oc get gateway maas-default-gateway -n openshift-ingress \
  -o jsonpath='{.spec.listeners[0].hostname}')
oc set env deployment/rhods-dashboard -n redhat-ods-applications \
  -c gen-ai-ui MAAS_URL="https://${GATEWAY_HOST}/maas-api"
```

> **Known bug**: [RHOAIENG-37237](https://issues.redhat.com/browse/RHOAIENG-37237) - BFF MaaS token generation uses incorrect autodiscovered URL prefix.

### gateway-auth-policy shows Enforced: False

**Root cause**: The `maas-default-gateway-authn` AuthPolicy created by `odh-model-controller` overrides the gateway-level policy.

```bash
# Check if conflicting policy exists
oc get authpolicy -n openshift-ingress

# If maas-default-gateway-authn exists, delete it and label the Gateway
oc delete authpolicy maas-default-gateway-authn -n openshift-ingress
oc label gateway maas-default-gateway -n openshift-ingress \
  opendatahub.io/managed=false
```

### Token returns AUTH_FAILURE

The `maas-api` requires the `X-MaaS-Username` header, which is injected by Authorino via the `maas-api-auth-policy`. If calling maas-api directly (bypassing the Gateway), this header will be missing.

Always access maas-api through the Gateway endpoint:
```bash
curl -sk "https://${GATEWAY_HOST}/maas-api/v1/tokens" \
  -H "Authorization: Bearer $(oc whoami -t)"
```

### TLS certificate errors

If the BFF logs show TLS errors when connecting to the Gateway:
1. Verify the wildcard cert secret exists: `oc get secret maas-gateway-wildcard-tls -n openshift-ingress`
2. Verify the cert covers the hostname: `oc get secret maas-gateway-wildcard-tls -n openshift-ingress -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -ext subjectAltName`
3. The cert should have a SAN matching `*.apps.cluster-xxx...`

## Key Resources Reference

| Resource | Namespace | Managed By |
|----------|-----------|------------|
| `maas-default-gateway` (Gateway) | openshift-ingress | ModelsAsService operator |
| `gateway-auth-policy` (AuthPolicy) | openshift-ingress | ModelsAsService operator |
| `maas-api-auth-policy` (AuthPolicy) | redhat-ods-applications | ModelsAsService operator |
| `maas-api` (Deployment) | redhat-ods-applications | ModelsAsService operator |
| `maas-api-route` (HTTPRoute) | redhat-ods-applications | ModelsAsService operator |
| `tier-to-group-mapping` (ConfigMap) | redhat-ods-applications | ModelsAsService operator |
| `maas-parameters` (ConfigMap) | redhat-ods-applications | ModelsAsService operator |
| `rhods-dashboard` (Deployment) | redhat-ods-applications | Dashboard operator |
| LLMInferenceService | llm | User-created |
| `maas-gateway-wildcard-tls` (Secret) | openshift-ingress | Helm chart / manual |
| `maas-gateway-reader` (ClusterRole) | cluster-scoped | Helm chart / manual |

## Known Issues (RHOAI 3.3)

1. **Gateway created without listener hostname** — The `ModelsAsService` operator creates the Gateway without a hostname on the HTTPS listener. The `gen-ai-ui` BFF relies on this hostname for autodiscovery. Must be patched manually.

2. **Conflicting AuthPolicy from odh-model-controller** — When deploying a model with "Publish as MaaS endpoint", the `odh-model-controller` creates a `maas-default-gateway-authn` AuthPolicy that overrides the `gateway-auth-policy`. Fix: label the Gateway with `opendatahub.io/managed: "false"` (label, not annotation).

3. **Dashboard SA missing Gateway RBAC** — The `rhods-dashboard` ServiceAccount doesn't have permissions to read Gateway API resources, preventing BFF autodiscovery. Must add a ClusterRole/ClusterRoleBinding manually.

4. **Tiers annotation empty after UI deployment** — Deploying a model from the dashboard UI with "All tiers" selected sets `alpha.maas.opendatahub.io/tiers: "[]"` instead of the actual tier names. Must be patched manually.

5. **BFF MaaS URL prefix mismatch** ([RHOAIENG-37237](https://issues.redhat.com/browse/RHOAIENG-37237)) — The BFF calls `/v1/tokens` instead of `/maas-api/v1/tokens` when using autodiscovery.
