"""
MaaS Portal API — FastAPI backend for the self-service portal.
Proxies to RHOAI MaaS APIs, reads Kuadrant CRDs for tier limits,
queries Prometheus for usage dashboards.
"""

import os
import re
import json
import time
import base64
import ssl
from datetime import datetime, timezone
import httpx
from fastapi import FastAPI, Request, Query
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

# --- Configuration ---
K8S_API = "https://kubernetes.default.svc"
K8S_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
K8S_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
RL_NAMESPACE = os.environ.get("RL_NAMESPACE", "openshift-ingress")
MODEL_NAMESPACE = os.environ.get("MODEL_NAMESPACE", "llm")
PROMETHEUS_URL = os.environ.get(
    "PROMETHEUS_URL",
    "https://thanos-querier.openshift-monitoring.svc:9091",
)

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

# --- Per-user usage tracking (in-memory, supplements Prometheus) ---
# Prometheus doesn't have per-user labels, so we track user→model stats here.
_user_usage: dict[str, dict[str, dict]] = {}  # {user: {model: {requests, prompt, completion}}}


def _track_user(username: str, model: str, prompt_tokens: int, completion_tokens: int):
    """Track per-user per-model usage in memory."""
    _user_usage.setdefault(username, {})
    _user_usage[username].setdefault(model, {"requests": 0, "prompt_tokens": 0, "completion_tokens": 0})
    _user_usage[username][model]["requests"] += 1
    _user_usage[username][model]["prompt_tokens"] += prompt_tokens
    _user_usage[username][model]["completion_tokens"] += completion_tokens

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


class CreateKeyRequest(BaseModel):
    name: str | None = None
    expiration: str | None = None


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
                    spec_limits = item.get("spec", {}).get("limits", {})
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
                    spec_limits = item.get("spec", {}).get("limits", {})
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
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "requests": 0,
        "rate_limited": 0,
        "latencies": [],
    }
    return session, None


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
            # Enrich model objects with full endpoint path
            models = data.get("models") or data.get("data") or (data if isinstance(data, list) else [])
            for m in models:
                model_id = m.get("id", "")
                if "/" not in model_id:
                    m["endpoint"] = f"{MODEL_NAMESPACE}/{model_id}/v1/chat/completions"
                else:
                    m["endpoint"] = f"{model_id}/v1/chat/completions"
            return JSONResponse(content={"models": models}, status_code=resp.status_code)
        except Exception as e:
            return JSONResponse(content={"error": str(e), "models": []}, status_code=502)


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
            return float(results[0]["value"][1])
        except (IndexError, ValueError, TypeError):
            pass
    return default


# --- Usage stats (Prometheus-powered) ---

def _build_user_stats() -> list[dict]:
    """Build per-user per-model stats from in-memory tracking."""
    result = []
    for user, models in _user_usage.items():
        total_req = sum(m["requests"] for m in models.values())
        total_tok = sum(m["prompt_tokens"] + m["completion_tokens"] for m in models.values())
        model_breakdown = [
            {"model": model, **stats}
            for model, stats in sorted(models.items(), key=lambda x: x[1]["requests"], reverse=True)
        ]
        result.append({
            "user": user,
            "requests": total_req,
            "tokens": total_tok,
            "models": model_breakdown,
        })
    return sorted(result, key=lambda x: x["requests"], reverse=True)


def _build_model_users() -> dict[str, list[dict]]:
    """Build per-model per-user breakdown from in-memory tracking."""
    model_users: dict[str, list[dict]] = {}
    for user, models in _user_usage.items():
        for model, stats in models.items():
            model_users.setdefault(model, [])
            model_users[model].append({
                "user": user,
                "requests": stats["requests"],
                "prompt_tokens": stats["prompt_tokens"],
                "completion_tokens": stats["completion_tokens"],
            })
    for model in model_users:
        model_users[model].sort(key=lambda x: x["requests"], reverse=True)
    return model_users


RANGE_MAP = {
    "1h": "1h",
    "6h": "6h",
    "24h": "24h",
    "7d": "7d",
    "30d": "30d",
}

@app.get("/api/usage/stats")
async def usage_stats(range: str = Query("24h", alias="range")):
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
        _prom_query(f'sum by (tier) (increase(istio_request_duration_milliseconds_count[{prom_range}]))'),
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

    # Enrich model data with per-user breakdown from in-memory tracking
    model_users = _build_model_users()
    for m_entry in model_data.values():
        m_entry["users"] = model_users.get(m_entry["model"], [])

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
        "requests_by_tier": requests_by_tier,
        "requests_by_user": _build_user_stats(),
    }


# --- Chat (SSE streaming) ---

@app.post("/api/chat/stream")
async def chat_stream(body: ChatRequest):
    s = body.session.model_dump()
    message = body.message
    hist = body.history
    model = body.model

    if not s.get("maas_token"):
        async def err_gen():
            yield "data: " + json.dumps({"type": "error", "content": "Please login first."}) + "\n\n"
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
                        "Authorization": f"Bearer {s['maas_token']}",
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
                    _track_user(s.get("username", "unknown"), model_name, prompt_tokens, completion_tokens)

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
