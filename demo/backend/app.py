"""
MaaS Portal API — FastAPI backend for the self-service portal.
Proxies to RHOAI MaaS APIs, reads Kuadrant CRDs for tier limits,
queries Prometheus for usage dashboards.
"""

import os
import re
import io
import csv
import json
import time
import base64
import ssl
from datetime import datetime, timezone
import httpx
from fastapi import FastAPI, Request, Query
from fastapi.responses import StreamingResponse, JSONResponse, Response
from pydantic import BaseModel

# --- Configuration ---
K8S_API = "https://kubernetes.default.svc"
K8S_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
K8S_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
RL_NAMESPACE = os.environ.get("RL_NAMESPACE", "openshift-ingress")
MODEL_NAMESPACE = os.environ.get("MODEL_NAMESPACE", "llm")
PORTAL_NAMESPACE = os.environ.get("PORTAL_NAMESPACE", "maas-demo")
PROMETHEUS_URL = os.environ.get(
    "PROMETHEUS_URL",
    "https://thanos-querier.openshift-monitoring.svc:9091",
)

ADMIN_GROUP = os.environ.get("ADMIN_GROUP", "maas-portal-admins")

MAAS_GATEWAY = os.environ.get(
    "MAAS_GATEWAY_URL",
    "https://maas.apps.cluster-7gtng.7gtng.sandbox1630.opentlc.com",
)
GRAFANA_URL = os.environ.get(
    "GRAFANA_URL",
    "https://grafana-route-user-grafana.apps.cluster-7gtng.7gtng.sandbox1630.opentlc.com",
)

_tier_limits_cache: dict = {"data": None, "ts": 0}
CACHE_TTL = 60

# ConfigMap cache (catalog)
_catalog_cache: dict = {"data": None, "rv": None, "ts": 0}
CM_CACHE_TTL = 30

# Per-user tracking is now fully backed by Prometheus via Limitador metrics
# (authorized_hits with user/tier/model labels).

app = FastAPI(
    title="MaaS Portal API",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)


# --- Pydantic Models ---

class LoginRequest(BaseModel):
    ocp_token: str


class Session(BaseModel):
    ocp_token: str
    maas_token: str
    username: str
    tier: str
    req_limit: int
    req_window: str
    token_limit: int
    token_window: str
    is_admin: bool = False
    prompt_tokens: int = 0
    completion_tokens: int = 0
    requests: int = 0
    rate_limited: int = 0
    latencies: list[float] = []


class ChatRequest(BaseModel):
    session: Session
    message: str
    history: list[list[str]] = []
    model: str | None = None
    api_key: str | None = None  # Use API key instead of session maas_token


class CreateKeyRequest(BaseModel):
    name: str | None = None
    expiration: str | None = None


class CatalogEntry(BaseModel):
    display_name: str = ""
    description: str = ""
    category: str = "chat"
    provider: str = ""
    context_window: int = 0
    cost_per_1k_prompt_tokens: float = 0.0
    cost_per_1k_completion_tokens: float = 0.0
    tags: list[str] = []
    documentation_url: str = ""


# --- Kubernetes helpers ---

def _k8s_headers() -> dict[str, str]:
    try:
        with open(K8S_TOKEN_PATH) as f:
            return {"Authorization": f"Bearer {f.read().strip()}"}
    except FileNotFoundError:
        return {}


def _k8s_ssl_context():
    if os.path.exists(K8S_CA_PATH):
        return ssl.create_default_context(cafile=K8S_CA_PATH)
    return False


async def _read_configmap(name: str, key: str) -> tuple[dict, str | None]:
    """Read a ConfigMap from K8S API. Returns (parsed_data, resourceVersion)."""
    headers = _k8s_headers()
    if not headers:
        return {}, None
    ssl_ctx = _k8s_ssl_context()
    try:
        async with httpx.AsyncClient(verify=ssl_ctx if ssl_ctx else False, timeout=5) as client:
            resp = await client.get(
                f"{K8S_API}/api/v1/namespaces/{PORTAL_NAMESPACE}/configmaps/{name}",
                headers=headers,
            )
            if resp.status_code == 200:
                cm = resp.json()
                rv = cm.get("metadata", {}).get("resourceVersion")
                raw = cm.get("data", {}).get(key, "{}")
                return json.loads(raw), rv
    except Exception:
        pass
    return {}, None


async def _write_configmap(name: str, key: str, data: dict, resource_version: str | None = None) -> bool:
    """Write data to a ConfigMap via K8S API. PUT if resourceVersion given, POST (create) otherwise."""
    headers = _k8s_headers()
    if not headers:
        return False
    ssl_ctx = _k8s_ssl_context()
    payload = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": name, "namespace": PORTAL_NAMESPACE},
        "data": {key: json.dumps(data)},
    }
    if resource_version:
        payload["metadata"]["resourceVersion"] = resource_version
    try:
        async with httpx.AsyncClient(verify=ssl_ctx if ssl_ctx else False, timeout=5) as client:
            if resource_version:
                resp = await client.put(
                    f"{K8S_API}/api/v1/namespaces/{PORTAL_NAMESPACE}/configmaps/{name}",
                    headers={**headers, "Content-Type": "application/json"},
                    json=payload,
                )
            else:
                resp = await client.post(
                    f"{K8S_API}/api/v1/namespaces/{PORTAL_NAMESPACE}/configmaps",
                    headers={**headers, "Content-Type": "application/json"},
                    json=payload,
                )
            return resp.status_code in (200, 201)
    except Exception:
        return False


def _extract_username_from_token(token: str) -> str:
    """Extract username from a MaaS JWT token."""
    try:
        parts = token.split(".")
        if len(parts) >= 2:
            payload = parts[1] + "=" * (4 - len(parts[1]) % 4)
            claims = json.loads(base64.b64decode(payload))
            sa_name = claims.get("sub", "")
            return sa_name.split(":")[-1] if ":" in sa_name else sa_name
    except Exception:
        pass
    return "unknown"


async def _get_catalog() -> tuple[dict, str | None]:
    """Read model catalog ConfigMap with TTL cache."""
    now = time.time()
    if _catalog_cache["data"] is not None and now - _catalog_cache["ts"] < CM_CACHE_TTL:
        return _catalog_cache["data"], _catalog_cache["rv"]
    data, rv = await _read_configmap("maas-model-catalog", "catalog.json")
    _catalog_cache["data"] = data
    _catalog_cache["rv"] = rv
    _catalog_cache["ts"] = now
    return data, rv


def _invalidate_catalog_cache():
    _catalog_cache["data"] = None
    _catalog_cache["ts"] = 0


def _extract_tier(when_list: list[dict] | None) -> str | None:
    for w in (when_list or []):
        m = re.search(r'auth\.identity\.tier\s*==\s*"(\w+)"', w.get("predicate", ""))
        if m:
            return m.group(1)
    return None


def _format_window(window: str) -> str:
    """Format Go duration like '1m0s' to human-readable '1 min'."""
    m = re.match(r"(\d+)m(\d*)s?", window)
    if m:
        mins = int(m.group(1))
        secs = int(m.group(2)) if m.group(2) else 0
        if secs == 0:
            return f"{mins} min" if mins > 1 else "1 min"
        return f"{mins}m {secs}s"
    return window


async def _fetch_tier_limits() -> dict:
    now = time.time()
    if _tier_limits_cache["data"] and now - _tier_limits_cache["ts"] < CACHE_TTL:
        return _tier_limits_cache["data"]

    headers = _k8s_headers()
    if not headers:
        return {}

    ssl_ctx = _k8s_ssl_context()
    limits: dict = {}

    async with httpx.AsyncClient(verify=ssl_ctx if ssl_ctx else False, timeout=5) as client:
        try:
            resp = await client.get(
                f"{K8S_API}/apis/kuadrant.io/v1/namespaces/{RL_NAMESPACE}/ratelimitpolicies",
                headers=headers,
            )
            if resp.status_code == 200:
                for item in resp.json().get("items", []):
                    # Kuadrant v1: limits under spec.defaults.limits
                    # Older versions: spec.limits
                    spec = item.get("spec", {})
                    spec_limits = spec.get("defaults", {}).get("limits", {}) or spec.get("limits", {})
                    for lval in spec_limits.values():
                        tier = _extract_tier(lval.get("when", []))
                        if tier and lval.get("rates"):
                            limits.setdefault(tier, {})
                            limits[tier]["req_limit"] = lval["rates"][0].get("limit", 0)
                            limits[tier]["req_window"] = _format_window(
                                lval["rates"][0].get("window", "1m")
                            )
        except Exception:
            pass

        try:
            resp = await client.get(
                f"{K8S_API}/apis/kuadrant.io/v1alpha1/namespaces/{RL_NAMESPACE}/tokenratelimitpolicies",
                headers=headers,
            )
            if resp.status_code == 200:
                for item in resp.json().get("items", []):
                    spec = item.get("spec", {})
                    spec_limits = spec.get("defaults", {}).get("limits", {}) or spec.get("limits", {})
                    for lval in spec_limits.values():
                        tier = _extract_tier(lval.get("when", []))
                        if tier and lval.get("rates"):
                            limits.setdefault(tier, {})
                            limits[tier]["token_limit"] = lval["rates"][0].get("limit", 0)
                            limits[tier]["token_window"] = _format_window(
                                lval["rates"][0].get("window", "1m")
                            )
        except Exception:
            pass

    if limits:
        _tier_limits_cache["data"] = limits
        _tier_limits_cache["ts"] = now

    return limits


async def _get_user_groups(ocp_token: str) -> list[str]:
    headers = _k8s_headers()
    if not headers:
        return []

    ssl_ctx = _k8s_ssl_context()
    try:
        async with httpx.AsyncClient(verify=ssl_ctx if ssl_ctx else False, timeout=10) as client:
            resp = await client.post(
                f"{K8S_API}/apis/authentication.k8s.io/v1/tokenreviews",
                headers={**headers, "Content-Type": "application/json"},
                json={
                    "apiVersion": "authentication.k8s.io/v1",
                    "kind": "TokenReview",
                    "spec": {"token": ocp_token},
                },
            )
            if resp.status_code == 201:
                status = resp.json().get("status", {})
                if status.get("authenticated"):
                    return status.get("user", {}).get("groups", [])
    except Exception:
        pass
    return []


async def _exchange_token(ocp_token: str, groups: list[str] | None = None) -> tuple[dict | None, str | None]:
    async with httpx.AsyncClient(verify=False, timeout=10) as client:
        try:
            resp = await client.post(
                f"{MAAS_GATEWAY}/maas-api/v1/tokens",
                headers={"Authorization": f"Bearer {ocp_token}"},
            )
            if resp.status_code not in (200, 201):
                return None, f"HTTP {resp.status_code}: {resp.text[:200]}"
            maas_token = resp.json().get("token", "")
        except Exception as e:
            return None, str(e)

        username = "unknown"
        try:
            parts = maas_token.split(".")
            if len(parts) >= 2:
                payload = parts[1] + "=" * (4 - len(parts[1]) % 4)
                claims = json.loads(base64.b64decode(payload))
                sa_name = claims.get("sub", "")
                username = sa_name.split(":")[-1] if ":" in sa_name else sa_name
        except Exception:
            pass

        if groups is None:
            groups = await _get_user_groups(ocp_token)

        tier = "free"
        try:
            resp = await client.post(
                f"{MAAS_GATEWAY}/maas-api/v1/tiers/lookup",
                headers={"Authorization": f"Bearer {ocp_token}"},
                json={"groups": groups},
            )
            if resp.status_code == 200:
                tier = resp.json().get("tier", "free")
        except Exception:
            pass

    is_admin = ADMIN_GROUP in (groups or [])

    all_limits = await _fetch_tier_limits()
    tier_limits = all_limits.get(tier, {})

    session = {
        "ocp_token": ocp_token,
        "maas_token": maas_token,
        "username": username,
        "tier": tier,
        "req_limit": tier_limits.get("req_limit", 0),
        "req_window": tier_limits.get("req_window", "1 min"),
        "token_limit": tier_limits.get("token_limit", 0),
        "token_window": tier_limits.get("token_window", "1 min"),
        "is_admin": is_admin,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "requests": 0,
        "rate_limited": 0,
        "latencies": [],
    }
    return session, None


async def _is_admin_from_request(request: Request) -> bool:
    """Check if the request comes from an admin user.
    First checks X-Forwarded-Groups header, then falls back to TokenReview."""
    groups_header = request.headers.get("X-Forwarded-Groups", "")
    groups = [g.strip() for g in groups_header.split(",") if g.strip()]
    if groups:
        return ADMIN_GROUP in groups
    # Fallback: oauth-proxy doesn't forward groups, use TokenReview
    ocp_token = request.headers.get("X-Forwarded-Access-Token", "").strip()
    if ocp_token:
        groups = await _get_user_groups(ocp_token)
        return ADMIN_GROUP in groups
    return False


def _get_username_from_request(request: Request) -> str:
    """Get the username from the X-Forwarded-User header."""
    return request.headers.get("X-Forwarded-User", "").strip()


def _clean_user_label(user: str) -> str:
    """Strip Kuadrant hash suffix from Limitador user label.
    e.g. 'mouachani-3dbcf850' -> 'mouachani'"""
    if re.match(r'^.+-[0-9a-f]{8}$', user):
        return user.rsplit('-', 1)[0]
    return user


def _resolve_auth(request: Request) -> str:
    """Get the best available auth token from request headers."""
    maas_token = request.headers.get("X-MaaS-Token", "").strip()
    if maas_token:
        return maas_token
    ocp_token = request.headers.get("X-Forwarded-Access-Token", "").strip()
    if ocp_token:
        return ocp_token
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    return ""


# --- Auth routes ---

@app.post("/api/auto-login")
async def auto_login(request: Request):
    ocp_token = request.headers.get("X-Forwarded-Access-Token", "").strip()
    if not ocp_token:
        return {"success": False, "error": "No OAuth token forwarded."}

    forwarded_user = request.headers.get("X-Forwarded-User", "")
    forwarded_groups = request.headers.get("X-Forwarded-Groups", "")
    groups = [g.strip() for g in forwarded_groups.split(",") if g.strip()] if forwarded_groups else None

    session, error = await _exchange_token(ocp_token, groups=groups)
    if error:
        return {"success": False, "error": error}

    if forwarded_user:
        session["username"] = forwarded_user

    return {"success": True, "session": session}


@app.post("/api/login")
async def login(body: LoginRequest):
    ocp_token = body.ocp_token.strip()
    if not ocp_token:
        return {"success": False, "error": "Enter your token."}

    session, error = await _exchange_token(ocp_token)
    if error:
        return {"success": False, "error": error}

    return {"success": True, "session": session}


# --- Models ---

@app.get("/api/models")
async def list_models(request: Request):
    token = _resolve_auth(request)
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    async with httpx.AsyncClient(verify=False, timeout=15) as client:
        try:
            resp = await client.get(
                f"{MAAS_GATEWAY}/maas-api/v1/models",
                headers=headers,
            )
            data = resp.json()
            models = data.get("models") or data.get("data") or (data if isinstance(data, list) else [])
            catalog, _ = await _get_catalog()
            for m in models:
                model_id = m.get("id", "")
                if "/" not in model_id:
                    m["endpoint"] = f"{MODEL_NAMESPACE}/{model_id}/v1/chat/completions"
                else:
                    m["endpoint"] = f"{model_id}/v1/chat/completions"
                if model_id in catalog:
                    m["catalog"] = catalog[model_id]
            return JSONResponse(content={"models": models}, status_code=resp.status_code)
        except Exception as e:
            return JSONResponse(content={"error": str(e), "models": []}, status_code=502)


@app.get("/api/models/{model_id}/status")
async def model_status(model_id: str):
    """Live model metrics from Prometheus."""
    import asyncio
    p50_r, p95_r, p99_r, throughput_r, err_rate_r = await asyncio.gather(
        _prom_query(
            f'histogram_quantile(0.5, sum by (le) (rate(kserve_vllm:e2e_request_latency_seconds_bucket{{model_name="{model_id}"}}[5m])))'
        ),
        _prom_query(
            f'histogram_quantile(0.95, sum by (le) (rate(kserve_vllm:e2e_request_latency_seconds_bucket{{model_name="{model_id}"}}[5m])))'
        ),
        _prom_query(
            f'histogram_quantile(0.99, sum by (le) (rate(kserve_vllm:e2e_request_latency_seconds_bucket{{model_name="{model_id}"}}[5m])))'
        ),
        _prom_query(
            f'sum(rate(kserve_vllm:e2e_request_latency_seconds_count{{model_name="{model_id}"}}[5m]))'
        ),
        _prom_query(
            f'sum(rate(istio_request_duration_milliseconds_count{{response_code=~"5..",model_name="{model_id}"}}[5m]))'
            f' / sum(rate(istio_request_duration_milliseconds_count{{model_name="{model_id}"}}[5m]))'
        ),
    )
    p50 = round(_prom_scalar(p50_r), 3)
    p95 = round(_prom_scalar(p95_r), 3)
    p99 = round(_prom_scalar(p99_r), 3)
    throughput = round(_prom_scalar(throughput_r), 2)
    error_rate = round(_prom_scalar(err_rate_r), 4)

    if throughput > 0 and error_rate < 0.1:
        availability = "up"
    elif throughput > 0:
        availability = "degraded"
    else:
        availability = "down"

    return {
        "latency_p50": p50,
        "latency_p95": p95,
        "latency_p99": p99,
        "throughput_rps": throughput,
        "availability": availability,
        "error_rate": error_rate,
    }


@app.put("/api/catalog/{model_id}")
async def update_catalog(model_id: str, entry: CatalogEntry):
    """Update catalog metadata for a model (admin)."""
    catalog, rv = await _get_catalog()
    catalog[model_id] = entry.model_dump()
    ok = await _write_configmap("maas-model-catalog", "catalog.json", catalog, rv)
    if not ok:
        return JSONResponse(content={"error": "Failed to update catalog"}, status_code=500)
    _invalidate_catalog_cache()
    return {"success": True, "model_id": model_id}


# --- API Keys ---

@app.get("/api/keys")
async def list_keys(request: Request):
    token = _resolve_auth(request)
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    async with httpx.AsyncClient(verify=False, timeout=15) as client:
        try:
            resp = await client.get(
                f"{MAAS_GATEWAY}/maas-api/v1/api-keys",
                headers=headers,
            )
            data = resp.json()
            if isinstance(data, list):
                keys = data
            elif isinstance(data, dict):
                keys = data.get("keys") or data.get("data") or data.get("api_keys") or []
            else:
                keys = []
            return JSONResponse(content={"keys": keys}, status_code=200)
        except Exception as e:
            return JSONResponse(content={"error": str(e), "keys": []}, status_code=502)


@app.post("/api/keys")
async def create_key(body: CreateKeyRequest, request: Request):
    token = _resolve_auth(request)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"} if token else {"Content-Type": "application/json"}

    payload = {}
    if body.name:
        payload["name"] = body.name
    if body.expiration:
        payload["expiration"] = body.expiration

    async with httpx.AsyncClient(verify=False, timeout=15) as client:
        try:
            resp = await client.post(
                f"{MAAS_GATEWAY}/maas-api/v1/api-keys",
                headers=headers,
                json=payload,
            )
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        except Exception as e:
            return JSONResponse(content={"error": str(e)}, status_code=502)


@app.delete("/api/keys/{key_id}")
async def delete_key(key_id: str, request: Request):
    token = _resolve_auth(request)
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    async with httpx.AsyncClient(verify=False, timeout=15) as client:
        try:
            resp = await client.delete(
                f"{MAAS_GATEWAY}/maas-api/v1/api-keys/{key_id}",
                headers=headers,
            )
            if resp.status_code == 204:
                return JSONResponse(content={"success": True}, status_code=200)
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        except Exception as e:
            return JSONResponse(content={"error": str(e)}, status_code=502)


# --- Tier limits ---

@app.get("/api/tier-limits")
async def tier_limits():
    return await _fetch_tier_limits()


# --- Config ---

@app.get("/api/config")
async def config():
    return {
        "grafana_url": GRAFANA_URL,
        "gateway_url": MAAS_GATEWAY,
        "model_namespace": MODEL_NAMESPACE,
    }


# --- Admin endpoints ---

@app.get("/api/admin/users")
async def admin_list_users(request: Request, range: str = Query("30d", alias="range")):
    """List all users with usage stats. Admin only."""
    if not await _is_admin_from_request(request):
        return JSONResponse(content={"error": "Forbidden"}, status_code=403)
    prom_range = RANGE_MAP.get(range, "30d")
    user_stats = await _build_user_stats_prom(prom_range)
    all_limits = await _fetch_tier_limits()
    for u in user_stats:
        tier = u.get("tier", "")
        tier_info = all_limits.get(tier, {})
        u["limits"] = tier_info
    return {"users": user_stats}


@app.get("/api/admin/users/{username}")
async def admin_user_detail(username: str, request: Request, range: str = Query("30d", alias="range")):
    """Get detailed usage for a specific user. Admin only."""
    if not await _is_admin_from_request(request):
        return JSONResponse(content={"error": "Forbidden"}, status_code=403)
    prom_range = RANGE_MAP.get(range, "30d")
    user_stats = await _build_user_stats_prom(prom_range)
    all_limits = await _fetch_tier_limits()
    for u in user_stats:
        if u["user"] == username:
            tier = u.get("tier", "")
            u["limits"] = all_limits.get(tier, {})
            return u
    return JSONResponse(content={"error": "User not found"}, status_code=404)


# --- Prometheus helpers ---

async def _prom_query(query: str) -> list[dict]:
    """Execute an instant PromQL query and return results."""
    headers = _k8s_headers()
    if not headers:
        return []
    try:
        async with httpx.AsyncClient(verify=False, timeout=15) as client:
            resp = await client.get(
                f"{PROMETHEUS_URL}/api/v1/query",
                headers=headers,
                params={"query": query},
            )
            if resp.status_code == 200:
                return resp.json().get("data", {}).get("result", [])
    except Exception:
        pass
    return []


async def _prom_query_range(query: str, start: float, end: float, step: str) -> list[dict]:
    """Execute a range PromQL query and return results."""
    headers = _k8s_headers()
    if not headers:
        return []
    try:
        async with httpx.AsyncClient(verify=False, timeout=15) as client:
            resp = await client.get(
                f"{PROMETHEUS_URL}/api/v1/query_range",
                headers=headers,
                params={"query": query, "start": str(start), "end": str(end), "step": step},
            )
            if resp.status_code == 200:
                return resp.json().get("data", {}).get("result", [])
    except Exception:
        pass
    return []


def _prom_scalar(results: list[dict], default: float = 0) -> float:
    """Extract a single scalar value from Prometheus instant query results."""
    if results and results[0].get("value"):
        try:
            v = float(results[0]["value"][1])
            # Guard against Inf/NaN which are not JSON-serializable
            if v != v or v == float("inf") or v == float("-inf"):
                return default
            return v
        except (IndexError, ValueError, TypeError):
            pass
    return default


# --- Usage stats (Prometheus-powered) ---

async def _build_user_stats_prom(prom_range: str = "24h") -> list[dict]:
    """Build per-user stats from Prometheus (Limitador metrics).

    Uses increase() over the given range to account for counter resets
    (Limitador counters reset on pod restart).

    Kuadrant 1.3+ metrics:
    - authorized_calls{user,tier}: request count per user (from RateLimitPolicy)
    - authorized_hits{user,tier}: token count per user (from TokenRateLimitPolicy)
    Note: the 'model' label is no longer present on Limitador metrics.
    """
    import asyncio
    JOB = 'limitador-limitador'
    req_r, tok_r = await asyncio.gather(
        _prom_query(f'sum by (user, tier) (increase(authorized_calls{{job="{JOB}",user!=""}}[{prom_range}]))'),
        _prom_query(f'sum by (user, tier) (increase(authorized_hits{{job="{JOB}",user!=""}}[{prom_range}]))'),
    )

    users: dict[str, dict] = {}
    for r in req_r:
        user = r["metric"].get("user", "unknown")
        tier = r["metric"].get("tier", "")
        reqs = int(float(r["value"][1]))
        if user in users:
            users[user]["requests"] += reqs
            if tier and not users[user]["tier"]:
                users[user]["tier"] = tier
        else:
            users[user] = {"user": user, "tier": tier, "requests": reqs, "tokens": 0, "models": {}}

    for r in tok_r:
        user = r["metric"].get("user", "unknown")
        tier = r["metric"].get("tier", "")
        tokens = int(float(r["value"][1]))
        if user in users:
            users[user]["tokens"] += tokens
            if tier and not users[user]["tier"]:
                users[user]["tier"] = tier
        else:
            users[user] = {"user": user, "tier": tier, "requests": 0, "tokens": tokens, "models": {}}

    # Merge entries with same clean username (strip Kuadrant hash suffix)
    merged: dict[str, dict] = {}
    for u in users.values():
        clean = _clean_user_label(u["user"])
        if clean in merged:
            merged[clean]["requests"] += u["requests"]
            merged[clean]["tokens"] += u["tokens"]
            if u.get("tier") and not merged[clean]["tier"]:
                merged[clean]["tier"] = u["tier"]
        else:
            merged[clean] = {
                "user": clean,
                "tier": u.get("tier", ""),
                "requests": u["requests"],
                "tokens": u["tokens"],
                "models": [],
            }
    return sorted(merged.values(), key=lambda x: x["requests"], reverse=True)


async def _build_model_users_prom() -> dict[str, list[dict]]:
    """Build per-model per-user breakdown from Prometheus.

    Kuadrant 1.3+ no longer provides per-model per-user Limitador metrics.
    Returns empty dict — model-level stats come from kserve_vllm metrics instead.
    """
    return {}


RANGE_MAP = {
    "1h": "1h",
    "6h": "6h",
    "24h": "24h",
    "7d": "7d",
    "30d": "30d",
}

@app.get("/api/usage/stats")
async def usage_stats(request: Request, range: str = Query("24h", alias="range")):
    """Return aggregated usage statistics from Prometheus."""
    prom_range = RANGE_MAP.get(range, "24h")

    # Run all Prometheus queries concurrently
    import asyncio

    (
        total_requests_r,
        total_prompt_r,
        total_completion_r,
        avg_latency_r,
        rate_limited_r,
        req_by_model_r,
        prompt_by_model_r,
        completion_by_model_r,
        req_by_tier_r,
    ) = await asyncio.gather(
        _prom_query(f"sum(increase(kserve_vllm:e2e_request_latency_seconds_count[{prom_range}]))"),
        _prom_query(f"sum(increase(kserve_vllm:request_prompt_tokens_sum[{prom_range}]))"),
        _prom_query(f"sum(increase(kserve_vllm:request_generation_tokens_sum[{prom_range}]))"),
        _prom_query(
            f"sum(increase(kserve_vllm:e2e_request_latency_seconds_sum[{prom_range}]))"
            f" / sum(increase(kserve_vllm:e2e_request_latency_seconds_count[{prom_range}]))"
        ),
        _prom_query(
            f'sum(increase(istio_request_duration_milliseconds_count{{response_code="429"}}[{prom_range}]))'
        ),
        _prom_query(f"sum by (model_name) (increase(kserve_vllm:e2e_request_latency_seconds_count[{prom_range}]))"),
        _prom_query(f"sum by (model_name) (increase(kserve_vllm:request_prompt_tokens_sum[{prom_range}]))"),
        _prom_query(f"sum by (model_name) (increase(kserve_vllm:request_generation_tokens_sum[{prom_range}]))"),
        _prom_query(f'sum by (tier) (increase(authorized_calls{{job="limitador-limitador",tier!=""}}[{prom_range}]))'),
    )

    total_requests = int(_prom_scalar(total_requests_r))
    total_prompt = int(_prom_scalar(total_prompt_r))
    total_completion = int(_prom_scalar(total_completion_r))
    avg_latency = round(_prom_scalar(avg_latency_r), 2)
    rate_limited = int(_prom_scalar(rate_limited_r))

    # By model — merge requests + prompt + completion
    model_data: dict[str, dict] = {}
    for r in req_by_model_r:
        m = r["metric"].get("model_name", "unknown")
        model_data.setdefault(m, {"model": m, "requests": 0, "prompt_tokens": 0, "completion_tokens": 0})
        model_data[m]["requests"] = int(float(r["value"][1]))
    for r in prompt_by_model_r:
        m = r["metric"].get("model_name", "unknown")
        model_data.setdefault(m, {"model": m, "requests": 0, "prompt_tokens": 0, "completion_tokens": 0})
        model_data[m]["prompt_tokens"] = int(float(r["value"][1]))
    for r in completion_by_model_r:
        m = r["metric"].get("model_name", "unknown")
        model_data.setdefault(m, {"model": m, "requests": 0, "prompt_tokens": 0, "completion_tokens": 0})
        model_data[m]["completion_tokens"] = int(float(r["value"][1]))

    # By tier (from Istio metrics)
    requests_by_tier = []
    for r in req_by_tier_r:
        tier = r["metric"].get("tier", "unknown")
        requests_by_tier.append({
            "tier": tier,
            "requests": int(float(r["value"][1])),
        })

    # By day — use query_range with 1d step
    now = time.time()
    days = 7 if prom_range in ("7d", "30d") else 1
    if prom_range == "30d":
        days = 30
    start_ts = now - days * 86400
    step = "1d" if days > 1 else "1h"

    req_range_r, prompt_range_r, completion_range_r = await asyncio.gather(
        _prom_query_range(
            "sum(increase(kserve_vllm:e2e_request_latency_seconds_count[1d]))",
            start_ts, now, step,
        ) if days > 1 else _prom_query_range(
            "sum(increase(kserve_vllm:e2e_request_latency_seconds_count[1h]))",
            start_ts, now, step,
        ),
        _prom_query_range(
            "sum(increase(kserve_vllm:request_prompt_tokens_sum[1d]))",
            start_ts, now, step,
        ) if days > 1 else _prom_query_range(
            "sum(increase(kserve_vllm:request_prompt_tokens_sum[1h]))",
            start_ts, now, step,
        ),
        _prom_query_range(
            "sum(increase(kserve_vllm:request_generation_tokens_sum[1d]))",
            start_ts, now, step,
        ) if days > 1 else _prom_query_range(
            "sum(increase(kserve_vllm:request_generation_tokens_sum[1h]))",
            start_ts, now, step,
        ),
    )

    # Build by-day/by-hour series
    requests_by_day = []
    if req_range_r:
        for ts, val in req_range_r[0].get("values", []):
            label = datetime.fromtimestamp(ts, tz=timezone.utc).strftime(
                "%Y-%m-%d" if days > 1 else "%H:%M"
            )
            requests_by_day.append({"date": label, "requests": int(float(val))})

    tokens_by_day = []
    prompt_vals = {v[0]: float(v[1]) for v in (prompt_range_r[0].get("values", []) if prompt_range_r else [])}
    completion_vals = {v[0]: float(v[1]) for v in (completion_range_r[0].get("values", []) if completion_range_r else [])}
    all_ts = sorted(set(list(prompt_vals.keys()) + list(completion_vals.keys())))
    for ts in all_ts:
        label = datetime.fromtimestamp(ts, tz=timezone.utc).strftime(
            "%Y-%m-%d" if days > 1 else "%H:%M"
        )
        tokens_by_day.append({
            "date": label,
            "prompt_tokens": int(prompt_vals.get(ts, 0)),
            "completion_tokens": int(completion_vals.get(ts, 0)),
        })

    # Per-user and per-model-user data from Prometheus (Limitador metrics)
    user_stats, model_users = await asyncio.gather(
        _build_user_stats_prom(prom_range),
        _build_model_users_prom(),
    )

    # Enrich model data with per-user breakdown
    for m_entry in model_data.values():
        m_entry["users"] = model_users.get(m_entry["model"], [])

    # Filter for non-admin: only show current user's data
    # User labels are now cleaned (hash suffix stripped) so exact match works
    is_admin = await _is_admin_from_request(request)
    filtered_user_stats = user_stats
    if not is_admin:
        current_user = _get_username_from_request(request)
        filtered_user_stats = [u for u in user_stats if u["user"] == current_user]

    return {
        "total_requests": total_requests,
        "total_prompt_tokens": total_prompt,
        "total_completion_tokens": total_completion,
        "total_tokens": total_prompt + total_completion,
        "avg_latency": avg_latency,
        "rate_limited": rate_limited,
        "requests_by_model": sorted(model_data.values(), key=lambda x: x["requests"], reverse=True),
        "requests_by_day": requests_by_day,
        "tokens_by_day": tokens_by_day,
        "requests_by_tier": requests_by_tier if is_admin else [],
        "requests_by_user": filtered_user_stats,
    }


# --- SLO Metrics (advanced) ---

@app.get("/api/usage/slo")
async def usage_slo(request: Request, range: str = Query("24h", alias="range"), model: str = Query("", alias="model")):
    """Advanced SLO metrics from Prometheus. Optionally filter by model_name."""
    import asyncio

    is_admin = await _is_admin_from_request(request)
    # Scale rate window for over-time charts
    rate_window_map = {"1h": "15m", "6h": "30m", "24h": "1h", "7d": "6h", "30d": "1d"}
    rate_window = rate_window_map.get(range, "1h")

    # Compute time range for range queries (charts)
    now = time.time()
    range_map = {"1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800, "30d": 2592000}
    range_seconds = range_map.get(range, 86400)
    start_ts = now - range_seconds
    step = "5m" if range_seconds <= 21600 else ("15m" if range_seconds <= 86400 else ("1h" if range_seconds <= 604800 else "6h"))

    # For instant KPI queries, use a minimum of 6h lookback so that
    # percentiles are meaningful even during idle periods
    slo_range_map = {"1h": "6h", "6h": "6h", "24h": "24h", "7d": "7d", "30d": "30d"}
    slo_range = slo_range_map.get(range, "24h")
    slo_range_seconds = {"6h": 21600, "24h": 86400, "7d": 604800, "30d": 2592000}.get(slo_range, 86400)
    prom_range = range  # for error breakdown increase() queries

    # Model filter: inject model_name label selector if specified
    mf = f',model_name="{model}"' if model else ""

    # --- SLO metrics (histogram-based), optionally per-model ---
    # Instant KPIs use increase() over full range (survives periods of inactivity).
    # Over-time charts use rate() with rate_window to show trends.
    (
        p50_r, p95_r, p99_r,
        ttft_p50_r, ttft_p95_r, ttft_p99_r,
        tpot_p95_r,
        throughput_r,
        prompt_tps_r, completion_tps_r,
        error_total_r, success_total_r,
        queue_p95_r,
        running_r, waiting_r,
        kv_cache_r,
        # Latency over time (P50/P95/P99 range queries)
        lat_p50_ts_r, lat_p95_ts_r, lat_p99_ts_r,
        # TTFT over time
        ttft_p95_ts_r,
        # Throughput over time
        throughput_ts_r,
        # Error breakdown
        err_stop_r, err_length_r, err_abort_r, err_error_r,
    ) = await asyncio.gather(
        # E2E latency percentiles — increase() over slo_range (min 6h)
        _prom_query(f'histogram_quantile(0.5, sum by (le) (increase(kserve_vllm:e2e_request_latency_seconds_bucket{{{mf.lstrip(",")}}}[{slo_range}])))'),
        _prom_query(f'histogram_quantile(0.95, sum by (le) (increase(kserve_vllm:e2e_request_latency_seconds_bucket{{{mf.lstrip(",")}}}[{slo_range}])))'),
        _prom_query(f'histogram_quantile(0.99, sum by (le) (increase(kserve_vllm:e2e_request_latency_seconds_bucket{{{mf.lstrip(",")}}}[{slo_range}])))'),
        # TTFT percentiles — increase() over slo_range
        _prom_query(f'histogram_quantile(0.5, sum by (le) (increase(kserve_vllm:time_to_first_token_seconds_bucket{{{mf.lstrip(",")}}}[{slo_range}])))'),
        _prom_query(f'histogram_quantile(0.95, sum by (le) (increase(kserve_vllm:time_to_first_token_seconds_bucket{{{mf.lstrip(",")}}}[{slo_range}])))'),
        _prom_query(f'histogram_quantile(0.99, sum by (le) (increase(kserve_vllm:time_to_first_token_seconds_bucket{{{mf.lstrip(",")}}}[{slo_range}])))'),
        # TPOT P95 — increase() over slo_range
        _prom_query(f'histogram_quantile(0.95, sum by (le) (increase(kserve_vllm:request_time_per_output_token_seconds_bucket{{{mf.lstrip(",")}}}[{slo_range}])))'),
        # Throughput (avg req/s over slo_range)
        _prom_query(f'sum(increase(kserve_vllm:e2e_request_latency_seconds_count{{{mf.lstrip(",")}}}[{slo_range}])) / {slo_range_seconds}'),
        # Token throughput (avg tokens/s over slo_range)
        _prom_query(f'sum(increase(kserve_vllm:request_prompt_tokens_sum{{{mf.lstrip(",")}}}[{slo_range}])) / {slo_range_seconds}'),
        _prom_query(f'sum(increase(kserve_vllm:request_generation_tokens_sum{{{mf.lstrip(",")}}}[{slo_range}])) / {slo_range_seconds}'),
        # Error / success counts — increase() over slo_range
        _prom_query(f'sum(increase(kserve_vllm:request_success_total{{finished_reason=~"error|abort"{mf}}}[{slo_range}]))'),
        _prom_query(f'sum(increase(kserve_vllm:request_success_total{{{mf.lstrip(",")}}}[{slo_range}]))'),
        # Queue wait P95 — increase() over slo_range
        _prom_query(f'histogram_quantile(0.95, sum by (le) (increase(kserve_vllm:request_queue_time_seconds_bucket{{{mf.lstrip(",")}}}[{slo_range}])))'),
        # Running / Waiting requests (instant gauges — no rate/increase needed)
        _prom_query(f'sum(kserve_vllm:num_requests_running{{{mf.lstrip(",")}}})'),
        _prom_query(f'sum(kserve_vllm:num_requests_waiting{{{mf.lstrip(",")}}})'),
        # KV cache (instant gauge)
        _prom_query(f'avg(kserve_vllm:kv_cache_usage_perc{{{mf.lstrip(",")}}})'),
        # Latency over time (range queries — keep rate() for trend charts)
        _prom_query_range(f'histogram_quantile(0.5, sum by (le) (rate(kserve_vllm:e2e_request_latency_seconds_bucket{{{mf.lstrip(",")}}}[{rate_window}])))', start_ts, now, step),
        _prom_query_range(f'histogram_quantile(0.95, sum by (le) (rate(kserve_vllm:e2e_request_latency_seconds_bucket{{{mf.lstrip(",")}}}[{rate_window}])))', start_ts, now, step),
        _prom_query_range(f'histogram_quantile(0.99, sum by (le) (rate(kserve_vllm:e2e_request_latency_seconds_bucket{{{mf.lstrip(",")}}}[{rate_window}])))', start_ts, now, step),
        # TTFT over time
        _prom_query_range(f'histogram_quantile(0.95, sum by (le) (rate(kserve_vllm:time_to_first_token_seconds_bucket{{{mf.lstrip(",")}}}[{rate_window}])))', start_ts, now, step),
        # Throughput over time
        _prom_query_range(f'sum(rate(kserve_vllm:e2e_request_latency_seconds_count{{{mf.lstrip(",")}}}[{rate_window}]))', start_ts, now, step),
        # Error breakdown by reason — use slo_range
        _prom_query(f'sum(increase(kserve_vllm:request_success_total{{finished_reason="stop"{mf}}}[{slo_range}]))'),
        _prom_query(f'sum(increase(kserve_vllm:request_success_total{{finished_reason="length"{mf}}}[{slo_range}]))'),
        _prom_query(f'sum(increase(kserve_vllm:request_success_total{{finished_reason="abort"{mf}}}[{slo_range}]))'),
        _prom_query(f'sum(increase(kserve_vllm:request_success_total{{finished_reason="error"{mf}}}[{slo_range}]))'),
    )

    p50 = round(_prom_scalar(p50_r), 3)
    p95 = round(_prom_scalar(p95_r), 3)
    p99 = round(_prom_scalar(p99_r), 3)

    ttft_p50 = round(_prom_scalar(ttft_p50_r), 3)
    ttft_p95 = round(_prom_scalar(ttft_p95_r), 3)
    ttft_p99 = round(_prom_scalar(ttft_p99_r), 3)

    tpot_p95 = round(_prom_scalar(tpot_p95_r), 4)

    throughput = round(_prom_scalar(throughput_r), 2)
    prompt_tps = round(_prom_scalar(prompt_tps_r), 1)
    completion_tps = round(_prom_scalar(completion_tps_r), 1)

    error_total = _prom_scalar(error_total_r)
    success_total = _prom_scalar(success_total_r)
    error_rate = round(error_total / success_total, 4) if success_total > 0 else 0

    queue_p95 = round(_prom_scalar(queue_p95_r), 3)
    running = int(_prom_scalar(running_r))
    waiting = int(_prom_scalar(waiting_r))
    kv_cache = round(_prom_scalar(kv_cache_r) * 100, 1)

    # Build latency over time series
    latency_over_time = _merge_range_series({
        "p50": lat_p50_ts_r,
        "p95": lat_p95_ts_r,
        "p99": lat_p99_ts_r,
    })

    ttft_over_time = _build_range_series(ttft_p95_ts_r, "ttft_p95")
    throughput_over_time = _build_range_series(throughput_ts_r, "rps")

    # Error breakdown
    error_breakdown = [
        {"reason": "stop", "count": int(_prom_scalar(err_stop_r))},
        {"reason": "length", "count": int(_prom_scalar(err_length_r))},
        {"reason": "abort", "count": int(_prom_scalar(err_abort_r))},
        {"reason": "error", "count": int(_prom_scalar(err_error_r))},
    ]

    result = {
        "latency": {"p50": p50, "p95": p95, "p99": p99},
        "ttft": {"p50": ttft_p50, "p95": ttft_p95, "p99": ttft_p99},
        "tpot_p95": tpot_p95,
        "throughput_rps": throughput,
        "token_throughput": {"prompt_tps": prompt_tps, "completion_tps": completion_tps, "total_tps": round(prompt_tps + completion_tps, 1)},
        "error_rate": error_rate,
        "error_breakdown": error_breakdown,
        "queue_time_p95": queue_p95,
        "running_requests": running,
        "waiting_requests": waiting,
        "kv_cache_pct": kv_cache,
        "latency_over_time": latency_over_time,
        "ttft_over_time": ttft_over_time,
        "throughput_over_time": throughput_over_time,
    }

    # For non-admin, only return a subset (no per-user breakdown needed since these are model-level metrics)
    if not is_admin:
        # Users can still see model-level SLOs (latency, throughput) since those are public
        return {
            "latency": result["latency"],
            "ttft": result["ttft"],
            "tpot_p95": result["tpot_p95"],
            "throughput_rps": result["throughput_rps"],
            "error_rate": result["error_rate"],
        }

    return result


def _build_range_series(prom_results: list[dict], value_key: str) -> list[dict]:
    """Convert a Prometheus range query result into a time series list.
    prom_results is already a list[dict] as returned by _prom_query_range."""
    series = []
    if prom_results:
        for ts, val in prom_results[0].get("values", []):
            try:
                v = float(val)
                if v != float("inf") and v != float("-inf") and v == v:  # skip NaN/Inf
                    series.append({"date": _ts_to_label(ts), value_key: round(v, 4)})
            except (ValueError, TypeError):
                pass
    return series


def _merge_range_series(named_results: dict[str, list[dict]]) -> list[dict]:
    """Merge multiple range query results into a single time series with named columns.
    Each value is a list[dict] as returned by _prom_query_range."""
    by_ts: dict[float, dict] = {}
    for name, prom_results in named_results.items():
        if prom_results:
            for ts, val in prom_results[0].get("values", []):
                try:
                    v = float(val)
                    if v != float("inf") and v != float("-inf") and v == v:
                        if ts not in by_ts:
                            by_ts[ts] = {"date": _ts_to_label(ts)}
                        by_ts[ts][name] = round(v, 3)
                except (ValueError, TypeError):
                    pass
    return sorted(by_ts.values(), key=lambda x: x["date"])


def _ts_to_label(ts: float) -> str:
    """Convert a Unix timestamp to a human-readable label."""
    from datetime import datetime, timezone
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return dt.strftime("%H:%M")


# --- Chat (SSE streaming) ---

@app.post("/api/chat/stream")
async def chat_stream(body: ChatRequest):
    s = body.session.model_dump()
    message = body.message
    hist = body.history
    model = body.model
    # Use API key if provided, otherwise fall back to session maas_token
    auth_token = body.api_key or s.get("maas_token", "")

    if not auth_token:
        async def err_gen():
            yield "data: " + json.dumps({"type": "error", "content": "Please login first or provide an API key."}) + "\n\n"
            yield "data: " + json.dumps({"type": "done", "session": s, "meta": ""}) + "\n\n"
        return StreamingResponse(err_gen(), media_type="text/event-stream")

    msgs = []
    for pair in hist:
        if len(pair) >= 2:
            msgs.append({"role": "user", "content": pair[0]})
            if pair[1]:
                msgs.append({"role": "assistant", "content": pair[1]})
    msgs.append({"role": "user", "content": message})

    # Resolve full model path (prepend namespace if needed)
    model_path = model or os.environ.get(
        "MODEL_PATH", f"{MODEL_NAMESPACE}/redhataillama-4-scout-17b-16e-instruct-quantizedw4a16"
    )
    if "/" not in model_path:
        model_path = f"{MODEL_NAMESPACE}/{model_path}"
    model_name = model_path.split("/")[-1]

    async def generate():
        t0 = time.time()
        s["requests"] += 1
        completion_tokens = 0
        prompt_tokens = 0
        status = "success"

        async with httpx.AsyncClient(verify=False, timeout=180) as client:
            try:
                async with client.stream(
                    "POST",
                    f"{MAAS_GATEWAY}/{model_path}/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {auth_token}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": model_name,
                        "messages": msgs,
                        "max_tokens": 512,
                        "temperature": 0.7,
                        "stream": True,
                        "stream_options": {"include_usage": True},
                    },
                ) as resp:
                    lat_first = None

                    if resp.status_code == 429:
                        await resp.aread()
                        s["rate_limited"] += 1
                        lat = time.time() - t0
                        s["latencies"].append(round(lat, 3))
                        status = "rate_limited"
                        rl_msg = f"RATE LIMITED (429) -- {s['tier']} tier limit reached."
                        try:
                            body_json = resp.json()
                            if body_json.get("message"):
                                rl_msg = body_json["message"]
                        except Exception:
                            pass
                        yield "data: " + json.dumps({"type": "error", "content": rl_msg}) + "\n\n"
                        yield "data: " + json.dumps({"type": "done", "session": s, "meta": f"Latency: {lat:.2f}s"}) + "\n\n"
                        return

                    if resp.status_code != 200:
                        await resp.aread()
                        lat = time.time() - t0
                        s["latencies"].append(round(lat, 3))
                        status = "error"
                        yield "data: " + json.dumps({"type": "error", "content": f"Error ({resp.status_code}): {resp.text[:300]}"}) + "\n\n"
                        yield "data: " + json.dumps({"type": "done", "session": s, "meta": f"Latency: {lat:.2f}s"}) + "\n\n"
                        return

                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        payload = line[6:]
                        if payload.strip() == "[DONE]":
                            break
                        try:
                            chunk = json.loads(payload)
                            if lat_first is None:
                                lat_first = time.time() - t0

                            usage = chunk.get("usage")
                            if usage:
                                prompt_tokens = usage.get("prompt_tokens", prompt_tokens)
                                completion_tokens = usage.get("completion_tokens", completion_tokens)

                            delta = chunk.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                yield "data: " + json.dumps({"type": "token", "content": content}) + "\n\n"
                        except Exception:
                            pass

                    lat = time.time() - t0
                    s["latencies"].append(round(lat, 3))
                    s["prompt_tokens"] += prompt_tokens
                    s["completion_tokens"] += completion_tokens

                    ttft = f"TTFT: {lat_first:.2f}s | " if lat_first else ""
                    meta = f"{ttft}{prompt_tokens} prompt + {completion_tokens} completion tokens | Total: {lat:.2f}s"
                    yield "data: " + json.dumps({"type": "done", "session": s, "meta": meta}) + "\n\n"

            except httpx.TimeoutException:
                lat = time.time() - t0
                s["latencies"].append(round(lat, 3))
                yield "data: " + json.dumps({"type": "error", "content": "Timeout -- Model did not respond within 180s."}) + "\n\n"
                yield "data: " + json.dumps({"type": "done", "session": s, "meta": ""}) + "\n\n"
            except Exception as e:
                lat = time.time() - t0
                s["latencies"].append(round(lat, 3))
                yield "data: " + json.dumps({"type": "error", "content": f"Error: {str(e)[:300]}"}) + "\n\n"
                yield "data: " + json.dumps({"type": "done", "session": s, "meta": ""}) + "\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- Chargeback / Metering ---

@app.get("/api/usage/costs")
async def usage_costs(request: Request, range: str = Query("24h", alias="range")):
    """Estimated costs based on Prometheus usage * catalog pricing."""
    import asyncio
    prom_range = RANGE_MAP.get(range, "24h")
    catalog, _ = await _get_catalog()

    JOB = 'limitador-limitador'
    # Kuadrant 1.3+: authorized_calls = requests, authorized_hits = tokens
    # Neither has model label anymore; use kserve_vllm for model breakdown
    tok_by_user, req_by_user, tok_by_model = await asyncio.gather(
        _prom_query(f'sum by (user, tier) (increase(authorized_hits{{job="{JOB}",user!=""}}[{prom_range}]))'),
        _prom_query(f'sum by (user, tier) (increase(authorized_calls{{job="{JOB}",user!=""}}[{prom_range}]))'),
        _prom_query(f'sum by (model_name) (increase(kserve_vllm:request_generation_tokens_sum[{prom_range}]))'),
    )

    # Default pricing (average across catalog or fallback)
    all_pricing = [c.get("cost_per_1k_completion_tokens", 0.03) for c in catalog.values()]
    default_cost_per_1k = sum(all_pricing) / len(all_pricing) if all_pricing else 0.03

    # Build per-user breakdown (tokens come from authorized_hits)
    # Use clean user labels (strip Kuadrant hash suffix) and merge duplicates
    user_data: dict[str, dict] = {}
    for r in tok_by_user:
        user = _clean_user_label(r["metric"].get("user", "unknown"))
        tier = r["metric"].get("tier", "")
        tokens = int(float(r["value"][1]))
        cost = (tokens / 1000) * default_cost_per_1k
        user_data.setdefault(user, {"user": user, "tier": tier, "total_tokens": 0, "estimated_cost": 0.0, "models": {}})
        user_data[user]["total_tokens"] += tokens
        user_data[user]["estimated_cost"] += cost
        if tier and not user_data[user]["tier"]:
            user_data[user]["tier"] = tier

    # Ensure users from req_by_user also appear (may have requests but 0 tokens)
    for r in req_by_user:
        user = _clean_user_label(r["metric"].get("user", "unknown"))
        tier = r["metric"].get("tier", "")
        user_data.setdefault(user, {"user": user, "tier": tier, "total_tokens": 0, "estimated_cost": 0.0, "models": {}})
        if tier and not user_data[user]["tier"]:
            user_data[user]["tier"] = tier

    # Aggregate by model (from kserve_vllm) and tier (from user data)
    cost_by_model: dict[str, dict] = {}
    cost_by_tier: dict[str, float] = {}
    total_cost = 0.0
    for u in user_data.values():
        total_cost += u["estimated_cost"]
        tier = u["tier"]
        cost_by_tier[tier] = cost_by_tier.get(tier, 0) + u["estimated_cost"]

    # Model cost breakdown from kserve_vllm completion tokens
    for r in tok_by_model:
        model_name = r["metric"].get("model_name", "unknown")
        tokens = int(float(r["value"][1]))
        if tokens == 0:
            continue
        pricing = catalog.get(model_name, {})
        cost_per_1k = pricing.get("cost_per_1k_completion_tokens", default_cost_per_1k)
        cost = (tokens / 1000) * cost_per_1k
        cost_by_model[model_name] = {"model": model_name, "total_tokens": tokens, "estimated_cost": round(cost, 4)}

    # Cost over time (daily or hourly)
    days = 7 if prom_range in ("7d", "30d") else 1
    if prom_range == "30d":
        days = 30
    now = time.time()
    start_ts = now - days * 86400
    step = "1d" if days > 1 else "1h"
    window = "1d" if days > 1 else "1h"

    tok_range_r = await _prom_query_range(
        f'sum(increase(kserve_vllm:request_generation_tokens_sum[{window}]))',
        start_ts, now, step,
    )

    cost_over_time = []
    if tok_range_r:
        for ts_val in tok_range_r[0].get("values", []):
            ts, val = ts_val
            tokens = float(val)
            label = datetime.fromtimestamp(ts, tz=timezone.utc).strftime(
                "%Y-%m-%d" if days > 1 else "%H:%M"
            )
            cost_over_time.append({
                "date": label,
                "estimated_cost": round((tokens / 1000) * default_cost_per_1k, 4),
            })

    cost_by_user_list = sorted(
        [
            {
                "user": u["user"],
                "tier": u["tier"],
                "total_tokens": u["total_tokens"],
                "estimated_cost": round(u["estimated_cost"], 4),
                "models": sorted(u["models"].values(), key=lambda x: x["estimated_cost"], reverse=True),
            }
            for u in user_data.values()
        ],
        key=lambda x: x["estimated_cost"],
        reverse=True,
    )

    # Filter for non-admin: only show current user's cost data
    is_admin = await _is_admin_from_request(request)
    filtered_cost_by_user = cost_by_user_list
    if not is_admin:
        current_user = _get_username_from_request(request)
        filtered_cost_by_user = [u for u in cost_by_user_list if u["user"] == current_user]
        total_cost = sum(u["estimated_cost"] for u in filtered_cost_by_user)

    return {
        "total_cost": round(total_cost, 4),
        "currency": "USD",
        "range": range,
        "cost_by_user": filtered_cost_by_user,
        "cost_by_model": sorted(
            [{"model": m["model"], "total_tokens": m["total_tokens"], "estimated_cost": round(m["estimated_cost"], 4)} for m in cost_by_model.values()],
            key=lambda x: x["estimated_cost"],
            reverse=True,
        ),
        "cost_by_tier": [{"tier": t, "estimated_cost": round(c, 4)} for t, c in cost_by_tier.items()] if is_admin else [],
        "cost_over_time": cost_over_time,
    }


@app.get("/api/usage/export")
async def usage_export(request: Request, range: str = Query("24h", alias="range")):
    """Export usage data as CSV."""
    costs = await usage_costs(request, range)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["user", "tier", "model", "total_tokens", "estimated_cost"])
    for user in costs["cost_by_user"]:
        for model in user["models"]:
            writer.writerow([
                user["user"],
                user["tier"],
                model["model"],
                model["total_tokens"],
                model["estimated_cost"],
            ])

    csv_content = output.getvalue()
    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=maas-usage-{range}.csv"},
    )
