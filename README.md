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

## Rate Limiting

MaaS uses two Kuadrant policies for rate limiting:

### Request Rate Limits (RateLimitPolicy)

Controls the number of requests per minute per tier:

| Tier | Limit |
|------|-------|
| Free | 5 req/min |
| Premium | 60 req/min |
| Enterprise | 600 req/min |

```bash
oc apply -f grafana/ratelimitpolicy.yaml
```

### Token Rate Limits (TokenRateLimitPolicy)

Controls the number of LLM tokens consumed per 24h per user within each tier. This uses the `kuadrant.io/v1alpha1` API:

| Tier | Limit |
|------|-------|
| Free | 10,000 tokens/24h |
| Premium | 100,000 tokens/24h |
| Enterprise | 1,000,000 tokens/24h |

```bash
oc apply -f grafana/tokenratelimitpolicy.yaml
```

Both policies target the `maas-default-gateway` and use `auth.metadata.matchedTier.tier` predicates to match users to their tier. Token limits use `auth.identity.userid` as a per-user counter.

### User and Tier Setup

```bash
# Create tier groups
oc adm groups new tier-free-users
oc adm groups new tier-premium-users
oc adm groups new tier-enterprise-users

# Add users to tiers
oc adm groups add-users tier-premium-users <username>

# Verify tier for a user
OCP_TOKEN=$(oc whoami -t)
curl -sk "https://maas.${CLUSTER_DOMAIN}/maas-api/v1/tiers/lookup" \
  -H "Authorization: Bearer $OCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"groups": ["tier-premium-users"]}'
```

## Demo Application

An interactive demo app (Flask + vanilla JS) with SSE streaming for testing the MaaS platform.

### Features

- Login with OpenShift token (two-step token exchange)
- Real-time streaming chat with SSE (Server-Sent Events)
- Per-session tracking: tokens, requests, latency (TTFT, TPOT)
- Tier-aware rate limit display (color-coded by tier)
- Rate limit alert on HTTP 429
- Link to Grafana dashboards

### Deploy the Demo

**Automated (recommended):**

```bash
cd demo
./deploy.sh
```

To rebuild the container image before deploying:

```bash
./deploy.sh --build
```

**Manual:**

```bash
CLUSTER_DOMAIN=$(oc get ingresses.config.openshift.io cluster -o jsonpath='{.spec.domain}')

# Create namespace and deploy
oc create namespace maas-demo
sed -e "s|REPLACE_GATEWAY_URL|https://maas.${CLUSTER_DOMAIN}|g" \
    -e "s|REPLACE_GRAFANA_URL|https://grafana-route-user-grafana.${CLUSTER_DOMAIN}|g" \
    demo/openshift/deployment.yaml | oc apply -f -

# Wait for deployment
oc rollout status deployment/maas-demo -n maas-demo

# Get the URL
oc get route maas-demo -n maas-demo -o jsonpath='https://{.spec.host}'
```

### Build from Source

```bash
cd demo
podman build --platform linux/amd64 -t quay.io/mouachan/maas/maas-demo:latest .
podman push quay.io/mouachan/maas/maas-demo:latest
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAAS_GATEWAY_URL` | (required) | MaaS gateway URL (e.g., `https://maas.apps.cluster-xxx...`) |
| `GRAFANA_URL` | (optional) | Grafana dashboard URL for the sidebar link |
| `MODEL_PATH` | `llm/redhataillama-4-scout-17b-16e-instruct-quantizedw4a16` | Model path for inference requests |

## Monitoring with Grafana

### Metrics Architecture

When deploying a model via `LLMInferenceService` (llm-d), RHOAI automatically creates:

- A **PodMonitor** `kserve-llm-isvc-vllm-engine` that scrapes the vLLM engine pods on port 8000 (HTTPS)
- A **ServiceMonitor** `kserve-llm-isvc-scheduler` that scrapes the kserve router/scheduler

The PodMonitor applies a `metricRelabeling` that renames all scraped metrics with a `kserve_` prefix:

| vLLM native metric | In Prometheus |
|---------------------|---------------|
| `vllm:time_to_first_token_seconds` | `kserve_vllm:time_to_first_token_seconds` |
| `vllm:e2e_request_latency_seconds` | `kserve_vllm:e2e_request_latency_seconds` |
| `vllm:request_time_per_output_token_seconds` | `kserve_vllm:request_time_per_output_token_seconds` |
| `vllm:inter_token_latency_seconds` | `kserve_vllm:inter_token_latency_seconds` |
| `vllm:generation_tokens_total` | `kserve_vllm:generation_tokens_total` |

This means **an existing vLLM Grafana dashboard (querying `vllm:*`) will NOT show llm-d metrics**. You need dashboards that query `kserve_vllm:*`.

### Deploy Monitoring Resources

```bash
# ServiceMonitors and PodMonitors
oc apply -f grafana/authorino-server-metrics-servicemonitor.yaml
oc apply -f grafana/limitador-servicemonitor.yaml
oc apply -f grafana/gateway-podmonitor.yaml

# Telemetry and rate limiting policies
oc apply -f grafana/istio-telemetry.yaml
oc apply -f grafana/telemetry-policy.yaml
oc apply -f grafana/ratelimitpolicy.yaml
oc apply -f grafana/tokenratelimitpolicy.yaml

# Grafana dashboards
oc apply -f grafana/llm-d-dashboard.yaml
oc apply -f grafana/dashboard-platform-admin.yaml
oc apply -f grafana/dashboard-ai-engineer.yaml
```

### Dashboards

Three dashboards are provided:

#### 1. llm-d Dashboard (`grafana/llm-d-dashboard.yaml`)

Deep-dive vLLM inference performance metrics:

| Panel | Metric | Description |
|-------|--------|-------------|
| Time to First Token (TTFT) | `kserve_vllm:time_to_first_token_seconds` | Time from request received to first token generated (p50/p95/p99) |
| Time Per Output Token (TPOT) | `kserve_vllm:request_time_per_output_token_seconds` | Average time to generate each output token (p50/p95/p99) |
| E2E Request Latency | `kserve_vllm:e2e_request_latency_seconds` | Total request duration (p50/p95/p99) |
| Inter-Token Latency (ITL) | `kserve_vllm:inter_token_latency_seconds` | Time between consecutive tokens (p50/p95/p99) |
| Token Throughput | `kserve_vllm:generation_tokens_total`, `prompt_tokens_total` | Tokens per second (generation and prompt) |
| Scheduler State | `kserve_vllm:num_requests_running`, `num_requests_waiting` | Requests currently being processed or queued |
| KV Cache Utilization | `kserve_vllm:kv_cache_usage_perc` | GPU KV cache usage |
| Prefix Cache Hit Rate | `kserve_vllm:prefix_cache_hits_total` / `prefix_cache_queries_total` | Effectiveness of prefix caching |

#### 2. Platform Admin Dashboard (`grafana/dashboard-platform-admin.yaml`)

Platform-wide operational view:

- **Model Metrics**: Requests running/waiting, GPU cache usage, total requests, inference latency, token throughput, queue wait time
- **Service Health**: P50 response latency, inference success rate, error rate
- **Model Rankings**: Top models by token usage, auth evaluations by status
- **Detailed Breakdown**: Token rate by model, request volume by model & status
- **Resource Allocation**: CPU, memory, GPU per model pod
- **Usage Tracking**: Token usage & errors over time
- **Per-Model Breakdown**: Latency percentiles (P50/P95/P99), token volume by model

#### 3. AI Engineer Dashboard (`grafana/dashboard-ai-engineer.yaml`)

User-facing consumption metrics:

- **Usage Summary**: Total tokens, total requests, token rate, request rate, inference success rate
- **Usage Trends**: Token rate by model, usage vs rate limits over time
- **Hourly Patterns**: Hourly token usage by model (stacked bars)
- **Detailed Analysis**: Token volume by model, usage summary table

### Monitoring Components

| File | Purpose |
|------|---------|
| `authorino-server-metrics-servicemonitor.yaml` | Scrapes Authorino auth metrics (evaluations, latency) |
| `limitador-servicemonitor.yaml` | Scrapes Limitador rate limit metrics |
| `gateway-podmonitor.yaml` | Scrapes Envoy gateway metrics (`istio_requests_total`, `kuadrant_*`) |
| `istio-telemetry.yaml` | Istio telemetry for tracing |
| `telemetry-policy.yaml` | Kuadrant TelemetryPolicy for per-user metric labels (user, tier, model) |

### Known Limitation: Per-User Metrics

The `TelemetryPolicy` configures Limitador to add `user`, `tier`, and `model` labels to rate limit metrics (`authorized_hits`, `limited_calls`). However, in RHOAI 3.3, **the Kuadrant wasm plugin does not forward requests to Limitador** (`failureMode: allow` silently skips rate limiting). As a result:

- Per-user token tracking is **not available** in Prometheus
- The dashboards use `kserve_vllm:*` metrics (per-model granularity) as a workaround
- Rate limiting panels show `vector(0)` (no data) since Limitador is not called

This is a known Kuadrant platform limitation that will be resolved in future releases.

### Prerequisites

1. **User Workload Monitoring** must be enabled on the cluster (provides `prometheus-user-workload` in `openshift-user-workload-monitoring`)
2. **Grafana Operator v5** installed in the `user-grafana` namespace
3. A **Grafana instance** with label `dashboards: grafana`
4. A **GrafanaDatasource** pointing to Thanos Querier (`https://thanos-querier.openshift-monitoring.svc.cluster.local:9091`) with a ServiceAccount token that has the `cluster-monitoring-view` ClusterRole

### Setting Up Grafana from Scratch

If you don't have a Grafana instance yet:

```bash
# 1. Create namespace and install Grafana operator
oc new-project user-grafana

# Install Grafana Operator v5 from OperatorHub (community-operators)
# or via CLI:
cat <<EOF | oc apply -f -
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: grafana-operator
  namespace: user-grafana
spec:
  channel: v5
  name: grafana-operator
  source: community-operators
  sourceNamespace: openshift-marketplace
EOF

# 2. Create ServiceAccount with monitoring access
oc create sa grafana-sa -n user-grafana
oc adm policy add-cluster-role-to-user cluster-monitoring-view -z grafana-sa -n user-grafana

# Create a long-lived token for the SA
cat <<EOF | oc apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: grafana-sa-token
  namespace: user-grafana
  annotations:
    kubernetes.io/service-account.name: grafana-sa
type: kubernetes.io/service-account-token
EOF

# 3. Create Grafana instance
cat <<EOF | oc apply -f -
apiVersion: grafana.integreatly.org/v1beta1
kind: Grafana
metadata:
  name: grafana
  namespace: user-grafana
  labels:
    dashboards: grafana
spec:
  route:
    spec: {}
  config:
    auth:
      disable_signout_menu: "true"
    auth.anonymous:
      enabled: "true"
    log:
      mode: console
EOF

# 4. Create Prometheus datasource
SA_TOKEN=$(oc get secret grafana-sa-token -n user-grafana -o jsonpath='{.data.token}' | base64 -d)
cat <<EOF | oc apply -f -
apiVersion: grafana.integreatly.org/v1beta1
kind: GrafanaDatasource
metadata:
  name: prometheus-grafanadatasource
  namespace: user-grafana
spec:
  instanceSelector:
    matchLabels:
      dashboards: grafana
  datasource:
    name: Prometheus
    type: prometheus
    access: proxy
    isDefault: true
    url: https://thanos-querier.openshift-monitoring.svc.cluster.local:9091
    editable: true
    jsonData:
      httpHeaderName1: Authorization
      timeInterval: 5s
      tlsSkipVerify: true
    secureJsonData:
      httpHeaderValue1: "Bearer ${SA_TOKEN}"
EOF

# 5. Deploy monitoring resources and dashboards
oc apply -f grafana/authorino-server-metrics-servicemonitor.yaml
oc apply -f grafana/limitador-servicemonitor.yaml
oc apply -f grafana/gateway-podmonitor.yaml
oc apply -f grafana/telemetry-policy.yaml
oc apply -f grafana/ratelimitpolicy.yaml
oc apply -f grafana/tokenratelimitpolicy.yaml
oc apply -f grafana/llm-d-dashboard.yaml
oc apply -f grafana/dashboard-platform-admin.yaml
oc apply -f grafana/dashboard-ai-engineer.yaml

# 6. Get the Grafana URL
oc get route grafana-route -n user-grafana -o jsonpath='https://{.spec.host}'
```

## Project Structure

```
rhoai-maas/
├── README.md                               # This file
├── demo/                                   # Interactive demo application
│   ├── app.py                              # Flask + SSE streaming app
│   ├── Dockerfile                          # UBI9 Python 3.11 container image
│   ├── requirements.txt                    # Python dependencies
│   ├── deploy.sh                           # Automated deploy script
│   └── openshift/
│       └── deployment.yaml                 # Deployment + Service + Route
├── grafana/                                # Monitoring & observability
│   ├── llm-d-dashboard.yaml                # vLLM inference performance dashboard
│   ├── dashboard-platform-admin.yaml       # Platform admin dashboard
│   ├── dashboard-ai-engineer.yaml          # AI engineer dashboard
│   ├── authorino-server-metrics-servicemonitor.yaml
│   ├── limitador-servicemonitor.yaml
│   ├── gateway-podmonitor.yaml             # Gateway Envoy metrics scraping
│   ├── istio-telemetry.yaml
│   ├── telemetry-policy.yaml               # Per-user metric labels
│   ├── ratelimitpolicy.yaml                # Request rate limits per tier
│   └── tokenratelimitpolicy.yaml           # Token rate limits per tier
└── helm/rhoai-maas/                        # Helm chart for model deployment
    ├── Chart.yaml
    ├── values.yaml
    └── templates/
        ├── _helpers.tpl
        ├── namespace.yaml
        ├── gateway-rbac.yaml
        ├── llminferenceservice.yaml
        └── post-install-config.yaml
```

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
| `maas-tier-rate-limits` (RateLimitPolicy) | openshift-ingress | Manual / this repo |
| `maas-tier-token-limits` (TokenRateLimitPolicy) | openshift-ingress | Manual / this repo |
| `maas-gateway-envoy` (PodMonitor) | openshift-ingress | Manual / this repo |
| LLMInferenceService | llm | Helm chart / manual |
| `maas-gateway-wildcard-tls` (Secret) | openshift-ingress | Helm chart / manual |
| `maas-gateway-reader` (ClusterRole) | cluster-scoped | Helm chart / manual |

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

### Grafana dashboards show "No data"

1. **Check metric prefix**: All vLLM metrics are renamed with a `kserve_` prefix by the PodMonitor. Use `kserve_vllm:*` in queries, not `vllm:*`.
2. **Verify PodMonitor exists**: `oc get podmonitor -n llm kserve-llm-isvc-vllm-engine`
3. **Verify metrics in Prometheus**: Port-forward Thanos and query `kserve_vllm:e2e_request_latency_seconds_count`
4. **Check datasource**: The Grafana datasource must point to `thanos-querier.openshift-monitoring.svc.cluster.local:9091` with a valid SA token.

### GPU nodes NotReady

If GPU nodes show `NotReady` with "Kubelet stopped posting node status", the EC2 instances may have been stopped (common in sandbox environments):

```bash
# Check instance state
oc get machines -n openshift-machine-api | grep gpu

# If instance state is "stopped", start them via AWS CLI
aws ec2 start-instances --instance-ids <instance-id-1> <instance-id-2> --region <region>
```

## Known Issues (RHOAI 3.3)

1. **Gateway created without listener hostname** — The `ModelsAsService` operator creates the Gateway without a hostname on the HTTPS listener. The `gen-ai-ui` BFF relies on this hostname for autodiscovery. Must be patched manually.

2. **Conflicting AuthPolicy from odh-model-controller** — When deploying a model with "Publish as MaaS endpoint", the `odh-model-controller` creates a `maas-default-gateway-authn` AuthPolicy that overrides the `gateway-auth-policy`. Fix: label the Gateway with `opendatahub.io/managed: "false"` (label, not annotation).

3. **Dashboard SA missing Gateway RBAC** — The `rhods-dashboard` ServiceAccount doesn't have permissions to read Gateway API resources, preventing BFF autodiscovery. Must add a ClusterRole/ClusterRoleBinding manually.

4. **Tiers annotation empty after UI deployment** — Deploying a model from the dashboard UI with "All tiers" selected sets `alpha.maas.opendatahub.io/tiers: "[]"` instead of the actual tier names. Must be patched manually.

5. **BFF MaaS URL prefix mismatch** ([RHOAIENG-37237](https://issues.redhat.com/browse/RHOAIENG-37237)) — The BFF calls `/v1/tokens` instead of `/maas-api/v1/tokens` when using autodiscovery.

6. **Limitador not called by wasm plugin** — The Kuadrant wasm plugin has `failureMode: allow` and never sends gRPC requests to Limitador. Rate limiting is silently bypassed. Per-user metrics (`authorized_hits`, `limited_calls`) are not populated. The `RateLimitPolicy` and `TokenRateLimitPolicy` show "Accepted/Enforced" but have no effect.

7. **Tier limits not displayed in dashboard UI** — The RHOAI Tiers page shows "No token limits / No request limits" even when `RateLimitPolicy` and `TokenRateLimitPolicy` are deployed and enforced. The dashboard does not read Kuadrant CRDs directly.
