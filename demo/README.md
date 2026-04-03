# MaaS Self-Service Portal

Web portal for Red Hat OpenShift AI Models-as-a-Service (MaaS). Provides model catalog browsing, API key management, usage monitoring, and an AI playground — all behind OpenShift OAuth with tier-based RBAC.

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  OpenShift Route (maas-portal)                                │
│  ┌─────────────────────┐    ┌──────────────────────────────┐  │
│  │ OAuth Proxy (8443)  │───►│ Frontend - nginx (8080)      │  │
│  │ OpenShift SSO       │    │ React + PatternFly 6         │  │
│  │ X-Forwarded-User    │    │ /api/* → backend proxy       │  │
│  │ X-Forwarded-Groups  │    └──────────┬───────────────────┘  │
│  └─────────────────────┘               │                      │
│                                        ▼                      │
│                            ┌───────────────────────┐          │
│                            │ Backend - FastAPI      │          │
│                            │ (7860)                 │          │
│                            │ ├─ K8S API (CRDs)     │          │
│                            │ ├─ Prometheus metrics  │          │
│                            │ └─ MaaS Gateway (LLM)  │          │
│                            └───────────────────────┘          │
└───────────────────────────────────────────────────────────────┘
```

**Frontend** — React 18 + PatternFly 6, built with Vite, served by nginx. Proxies `/api/*` to backend.

**Backend** — FastAPI (Python). Handles authentication (OCP token exchange), reads Kuadrant CRDs for tier limits, queries Prometheus for usage/SLO metrics, proxies chat to the MaaS gateway.

**OAuth Proxy** — OpenShift oauth-proxy sidecar. Handles SSO login and injects `X-Forwarded-User` / `X-Forwarded-Groups` headers.

## RBAC

Access control is based on OpenShift groups (defined in `openshift/groups.yaml`):

| Group | Role | Capabilities |
|---|---|---|
| `maas-portal-admins` | Admin | Full dashboard, all users' usage, SLO metrics, user management |
| `maas-portal-users` | User | Personal usage only, model catalog, playground, API keys |

Tier-based rate limiting is handled by Kuadrant at the gateway level:

| Group | Tier | Request limit | Token limit |
|---|---|---|---|
| `tier-enterprise-users` | Enterprise | 600 req/min | 50,000 tokens/min |
| `tier-premium-users` | Premium | 60 req/min | 5,000 tokens/min |
| `tier-free-users` | Free | 5 req/min | 500 tokens/min |
| `tier-restricted-users` | Restricted | No access | No access |

## Prerequisites

- OpenShift 4.19+ cluster with RHOAI 3.3 and Kuadrant 1.3+ configured
- LLM models deployed via `LLMInferenceService` in the `llm` namespace
- Kuadrant gateway, AuthPolicy, and RateLimitPolicy resources in place
- Prometheus (OpenShift monitoring stack) with Limitador and kserve/vLLM metrics
- `oc` CLI logged in with cluster-admin privileges
- `podman` (only if building images with `--build`)

## Deployment

### Quick deploy (pre-built images)

```bash
./deploy.sh
```

### Build and deploy

```bash
./deploy.sh --build
```

### What `deploy.sh` does

1. Detects the cluster domain from `ingresses.config.openshift.io`
2. Creates OpenShift groups for admin/user roles and tier assignments
3. Creates the `maas-demo` namespace
4. Generates a random cookie secret for the OAuth proxy session
5. Templates and applies the deployment manifests (replaces gateway URL, Grafana URL, cookie secret, image references)
6. Grants `system:auth-delegator` to the portal service account
7. Waits for backend and frontend rollouts
8. Prints the portal URL

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `FRONTEND_IMAGE` | `quay.io/mouachan/maas/maas-portal-frontend:v2` | Frontend container image |
| `BACKEND_IMAGE` | `quay.io/mouachan/maas/maas-portal-api:v2` | Backend container image |
| `NAMESPACE` | `maas-demo` | Target namespace |

## Portal pages

- **Dashboard** — KPIs (requests, tokens, cost), tier limits. Admins see platform-wide stats and per-user breakdown.
- **Models** — Catalog of available LLMs with status indicators (latency, throughput, availability).
- **API Keys** — Create and manage MaaS API keys for programmatic access.
- **Playground** — Interactive chat with any available model using streaming (SSE).
- **Usage** — Detailed usage analytics with time range selection (1h/6h/24h/7d/30d). Admins see SLO metrics and per-user/per-tier breakdown. Users see their own usage only.

## Project structure

```
demo/
├── deploy.sh                   # Automated deployment script
├── backend/
│   ├── app.py                  # FastAPI application
│   ├── requirements.txt        # Python dependencies
│   └── Dockerfile              # UBI9 Python 3.11
├── frontend/
│   ├── src/
│   │   ├── api.ts              # API client functions
│   │   ├── types.ts            # TypeScript interfaces
│   │   ├── AuthContext.tsx      # Auth provider (session + isAdmin)
│   │   ├── pages/              # Dashboard, Models, ApiKeys, Playground, Usage
│   │   └── components/         # AppLayout, ModelCard, ModelDetailDrawer, TierBadge
│   ├── nginx.conf              # Reverse proxy config (frontend + /api/* → backend)
│   ├── Dockerfile              # Multi-stage build (Node 20 + nginx)
│   └── package.json
└── openshift/
    ├── deployment.yaml         # All K8S manifests (namespace, RBAC, deployments, services, route)
    └── groups.yaml             # OpenShift groups (admin, user, tier assignments)
```

## Backend API endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auto-login` | OAuth headers | Auto-login via forwarded OCP token |
| POST | `/api/login` | Body token | Manual login with OCP token |
| GET | `/api/models` | MaaS token | List available models with catalog + status |
| GET | `/api/models/{id}/status` | - | Real-time model status from Prometheus |
| GET | `/api/keys` | MaaS token | List user's API keys |
| POST | `/api/keys` | MaaS token | Create a new API key |
| DELETE | `/api/keys/{id}` | MaaS token | Delete an API key |
| GET | `/api/config` | - | Portal configuration (gateway URL, Grafana URL) |
| GET | `/api/usage/stats` | OAuth headers | Usage statistics (filtered for non-admins) |
| GET | `/api/usage/costs` | OAuth headers | Cost estimates (filtered for non-admins) |
| GET | `/api/usage/slo` | OAuth headers | SLO metrics (admin only) |
| GET | `/api/usage/export` | OAuth headers | CSV export of usage data |
| GET | `/api/admin/users` | Admin only | List all users with usage stats |
| GET | `/api/admin/users/{user}` | Admin only | User detail with tier and limits |
| POST | `/api/chat/stream` | MaaS token | SSE streaming chat with LLM |
