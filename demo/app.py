"""
MaaS Demo App — Models as a Service interactive demo.
Flask + vanilla JS with SSE streaming.
"""

import os
import re
import json
import time
import base64

from flask import Flask, request, jsonify, Response
import requests as http_requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# --- Kubernetes API helpers (in-cluster) ---
K8S_API = "https://kubernetes.default.svc"
K8S_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
K8S_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
RL_NAMESPACE = os.environ.get("RL_NAMESPACE", "openshift-ingress")

_tier_limits_cache = {"data": None, "ts": 0}
CACHE_TTL = 60  # seconds


def _k8s_headers():
    try:
        with open(K8S_TOKEN_PATH) as f:
            return {"Authorization": f"Bearer {f.read().strip()}"}
    except FileNotFoundError:
        return {}


def _extract_tier(when_list):
    """Extract tier name from CEL predicate like 'auth.identity.tier == \"free\"'."""
    for w in (when_list or []):
        m = re.search(r'auth\.identity\.tier\s*==\s*"(\w+)"', w.get("predicate", ""))
        if m:
            return m.group(1)
    return None


def _fetch_tier_limits():
    """Read RateLimitPolicy and TokenRateLimitPolicy CRDs from the cluster."""
    now = time.time()
    if _tier_limits_cache["data"] and now - _tier_limits_cache["ts"] < CACHE_TTL:
        return _tier_limits_cache["data"]

    headers = _k8s_headers()
    if not headers:
        return {}

    ca = K8S_CA_PATH if os.path.exists(K8S_CA_PATH) else False
    limits = {}  # tier -> {"req_limit": N, "req_window": "1m", "token_limit": N, "token_window": "1m"}

    # Fetch RateLimitPolicies
    try:
        resp = http_requests.get(
            f"{K8S_API}/apis/kuadrant.io/v1/namespaces/{RL_NAMESPACE}/ratelimitpolicies",
            headers=headers, verify=ca, timeout=5,
        )
        if resp.status_code == 200:
            for item in resp.json().get("items", []):
                spec_limits = item.get("spec", {}).get("limits", {})
                for lname, lval in spec_limits.items():
                    tier = _extract_tier(lval.get("when", []))
                    if tier and lval.get("rates"):
                        limits.setdefault(tier, {})
                        limits[tier]["req_limit"] = lval["rates"][0].get("limit", 0)
                        limits[tier]["req_window"] = lval["rates"][0].get("window", "1m")
    except Exception:
        pass

    # Fetch TokenRateLimitPolicies
    try:
        resp = http_requests.get(
            f"{K8S_API}/apis/kuadrant.io/v1alpha1/namespaces/{RL_NAMESPACE}/tokenratelimitpolicies",
            headers=headers, verify=ca, timeout=5,
        )
        if resp.status_code == 200:
            for item in resp.json().get("items", []):
                spec_limits = item.get("spec", {}).get("limits", {})
                for lname, lval in spec_limits.items():
                    tier = _extract_tier(lval.get("when", []))
                    if tier and lval.get("rates"):
                        limits.setdefault(tier, {})
                        limits[tier]["token_limit"] = lval["rates"][0].get("limit", 0)
                        limits[tier]["token_window"] = lval["rates"][0].get("window", "1m")
    except Exception:
        pass

    if limits:
        _tier_limits_cache["data"] = limits
        _tier_limits_cache["ts"] = now

    return limits

MAAS_GATEWAY = os.environ.get(
    "MAAS_GATEWAY_URL",
    "https://maas.apps.cluster-7gtng.7gtng.sandbox1630.opentlc.com",
)
GRAFANA_URL = os.environ.get(
    "GRAFANA_URL",
    "https://grafana-route-user-grafana.apps.cluster-7gtng.7gtng.sandbox1630.opentlc.com",
)
MODEL_PATH = os.environ.get(
    "MODEL_PATH",
    "llm/redhataillama-4-scout-17b-16e-instruct-quantizedw4a16",
)

app = Flask(__name__)

HTML_PAGE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>MaaS Demo</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f5;min-height:100vh}
.header{background:linear-gradient(135deg,#cc0000,#8b0000);padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
.header-title{color:#fff;font-size:22px;font-weight:700}
.header-sub{color:rgba(255,255,255,.8);font-size:13px}
.header a{background:rgba(255,255,255,.15);color:#fff;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:13px}
.container{max-width:1200px;margin:0 auto;padding:20px}
.login-box{max-width:440px;margin:60px auto;background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.login-box h2{font-size:28px;color:#1a1a2e;text-align:center}
.login-box p{color:#6c757d;text-align:center;margin:8px 0 24px}
.login-box input{width:100%;padding:12px;border:1px solid #dee2e6;border-radius:8px;font-size:14px;margin-bottom:12px}
.login-box button{width:100%;padding:12px;background:#cc0000;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
.login-box button:hover{background:#a00}
.login-hint{margin-top:16px;padding:12px;background:#f0f4f8;border-radius:8px;font-size:12px;color:#6c757d}
.login-error{color:#e74c3c;font-size:13px;margin-bottom:8px;min-height:20px}
.chat-wrap{display:none;grid-template-columns:1fr 320px;gap:20px}
.chat-main{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.06);display:flex;flex-direction:column;height:calc(100vh - 120px)}
.messages{flex:1;overflow-y:auto;padding:20px}
.msg{margin-bottom:16px;display:flex}
.msg.user{justify-content:flex-end}
.msg .bubble{max-width:75%;padding:12px 16px;border-radius:12px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}
.msg.user .bubble{background:#cc0000;color:#fff;border-bottom-right-radius:4px}
.msg.assistant .bubble{background:#f0f2f5;color:#1a1a2e;border-bottom-left-radius:4px}
.msg .meta{font-size:11px;color:#999;margin-top:4px}
.input-bar{display:flex;gap:8px;padding:16px;border-top:1px solid #eee}
.input-bar input{flex:1;padding:12px;border:1px solid #dee2e6;border-radius:8px;font-size:14px}
.input-bar button{padding:12px 24px;background:#cc0000;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer}
.input-bar button:hover{background:#a00}
.input-bar button:disabled{background:#ccc;cursor:not-allowed}
.chat-actions{display:flex;gap:8px;padding:0 16px 12px}
.chat-actions button{padding:6px 14px;border:1px solid #dee2e6;background:#fff;border-radius:6px;font-size:13px;cursor:pointer}
.chat-actions button:hover{background:#f0f2f5}
.sidebar{display:flex;flex-direction:column;gap:12px}
.card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
.user-card{background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;padding:20px}
.user-card .label{font-size:11px;opacity:.7;text-transform:uppercase;letter-spacing:1px}
.user-card .name{font-size:20px;font-weight:700;margin:4px 0 12px}
.tier-badge{display:inline-block;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:600;text-transform:uppercase}
.stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.stat{background:#f8f9fa;border-radius:10px;padding:12px;text-align:center}
.stat .label{font-size:10px;color:#6c757d;text-transform:uppercase}
.stat .value{font-size:22px;font-weight:700;color:#2c3e50}
.stat .value.blue{color:#3498db}
.stat .value.green{color:#27ae60}
.bar-wrap{margin-top:4px}
.bar-label{display:flex;justify-content:space-between;font-size:11px;color:#6c757d;margin-bottom:4px}
.bar-bg{background:#e9ecef;border-radius:6px;height:8px;overflow:hidden}
.bar-fg{height:100%;border-radius:6px;transition:width .3s}
.rl-alert{background:#fdecea;border-radius:10px;padding:14px;border:1px solid #e74c3c;font-size:13px;color:#e74c3c;font-weight:600;display:none}
.typing{display:inline-block;opacity:.6}
.typing::after{content:'...';animation:dots 1.5s steps(4,end) infinite}
@keyframes dots{0%,20%{content:'.'}40%{content:'..'}60%,100%{content:'...'}}
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="header-title">Models as a Service</div>
    <div class="header-sub">Red Hat OpenShift AI &mdash; Multi-tenant LLM Platform</div>
  </div>
  <a href="__GRAFANA_URL__" target="_blank">Open Grafana</a>
</div>
<div id="login-section" class="container">
  <div class="login-box" id="login-box">
    <h2>Welcome to MaaS</h2>
    <p id="login-status">Authenticating via OpenShift...</p>
    <div id="login-error" class="login-error"></div>
    <div id="manual-login" style="display:none">
      <input id="ocp-token" type="password" placeholder="sha256~xxxxxxxxxxxx"/>
      <button onclick="doLogin()">Login &amp; Exchange Token</button>
      <div class="login-hint"><strong>How to get your token:</strong><br/><code>oc whoami -t</code> after logging in with <code>oc login</code></div>
    </div>
  </div>
</div>
<div id="chat-section" class="container">
  <div class="chat-wrap" id="chat-wrap">
    <div class="chat-main">
      <div class="messages" id="messages"></div>
      <div class="chat-actions">
        <button onclick="clearChat()">Clear Chat</button>
        <button onclick="doLogout()">Logout</button>
      </div>
      <div class="input-bar">
        <input id="msg-input" placeholder="Ask the model anything..." onkeydown="if(event.key==='Enter')sendMsg()"/>
        <button id="send-btn" onclick="sendMsg()">Send</button>
      </div>
    </div>
    <div class="sidebar">
      <div class="card user-card">
        <div class="label">User</div>
        <div class="name" id="sb-user">-</div>
        <div class="tier-badge" id="sb-tier">-</div>
      </div>
      <div class="card stats-grid">
        <div class="stat"><div class="label">Requests</div><div class="value" id="sb-reqs">0</div></div>
        <div class="stat"><div class="label">Tokens</div><div class="value" id="sb-tokens">0</div></div>
        <div class="stat"><div class="label">Prompt</div><div class="value blue" id="sb-prompt">0</div></div>
        <div class="stat"><div class="label">Completion</div><div class="value green" id="sb-comp">0</div></div>
      </div>
      <div class="card">
        <div class="label" style="font-size:10px;color:#6c757d;text-transform:uppercase;margin-bottom:4px">Avg Latency</div>
        <div style="font-size:20px;font-weight:700;color:#2c3e50" id="sb-lat">0.00s</div>
      </div>
      <div class="card">
        <div class="bar-wrap">
          <div class="bar-label"><span id="sb-rl-label">Requests (0/- per -)</span><span id="sb-rl-pct">0%</span></div>
          <div class="bar-bg"><div class="bar-fg" id="sb-rl-bar" style="width:0%;background:#2ecc71"></div></div>
        </div>
        <div class="bar-wrap" style="margin-top:10px">
          <div class="bar-label"><span id="sb-tl-label">Tokens (0/- per -)</span><span id="sb-tl-pct">0%</span></div>
          <div class="bar-bg"><div class="bar-fg" id="sb-tl-bar" style="width:0%;background:#2ecc71"></div></div>
        </div>
      </div>
      <div class="rl-alert" id="sb-rl-alert"></div>
    </div>
  </div>
</div>
<script>
const TIER_COLORS={free:'#e74c3c',premium:'#f39c12',enterprise:'#2ecc71'};
let session=null;
let history=[];

function showManualLogin(){
  document.getElementById('login-status').textContent='Enter your OpenShift token to access the LLM';
  document.getElementById('manual-login').style.display='block';
}

function enterChat(s){
  session=s;
  history=[];
  document.getElementById('login-section').style.display='none';
  document.getElementById('chat-section').style.display='block';
  document.getElementById('chat-wrap').style.display='grid';
  updateSidebar();
}

// Try OAuth auto-login on page load
(function autoLogin(){
  fetch('/api/auto-login',{method:'POST'})
  .then(r=>r.json()).then(d=>{
    if(d.success){enterChat(d.session);}
    else{showManualLogin();}
  }).catch(()=>{showManualLogin();});
})();

function doLogin(){
  const token=document.getElementById('ocp-token').value.trim();
  if(!token){document.getElementById('login-error').textContent='Enter your token.';return;}
  document.getElementById('login-error').textContent='Logging in...';
  fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ocp_token:token})})
  .then(r=>r.json()).then(d=>{
    if(!d.success){document.getElementById('login-error').textContent='Login failed: '+d.error;return;}
    enterChat(d.session);
  }).catch(e=>{document.getElementById('login-error').textContent='Error: '+e;});
}

function doLogout(){
  session=null;history=[];
  document.getElementById('messages').innerHTML='';
  document.getElementById('chat-section').style.display='none';
  document.getElementById('chat-wrap').style.display='none';
  document.getElementById('login-section').style.display='block';
  document.getElementById('login-error').textContent='';
  showManualLogin();
  document.getElementById('ocp-token').value='';
}

function clearChat(){history=[];document.getElementById('messages').innerHTML='';}

function escapeHtml(t){
  if(!t)return'';
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function sendMsg(){
  const inp=document.getElementById('msg-input');
  const msg=inp.value.trim();
  if(!msg||!session)return;
  inp.value='';
  document.getElementById('send-btn').disabled=true;

  // Add user bubble
  addBubble('user',msg);

  // Create assistant bubble with typing indicator
  const aDiv=document.createElement('div');
  aDiv.className='msg assistant';
  aDiv.innerHTML='<div><div class="bubble"><span class="typing">Thinking</span></div><div class="meta" id="stream-meta"></div></div>';
  const msgsEl=document.getElementById('messages');
  msgsEl.appendChild(aDiv);
  msgsEl.scrollTop=msgsEl.scrollHeight;
  const bubbleEl=aDiv.querySelector('.bubble');
  const metaEl=aDiv.querySelector('#stream-meta');

  try{
    const resp=await fetch('/api/chat/stream',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:msg,history:history,session:session})
    });

    if(!resp.ok){
      const errText=await resp.text();
      bubbleEl.textContent='Error ('+resp.status+'): '+errText.slice(0,300);
      document.getElementById('send-btn').disabled=false;
      return;
    }

    const reader=resp.body.getReader();
    const decoder=new TextDecoder();
    let fullText='';
    let buf='';

    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      buf+=decoder.decode(value,{stream:true});

      const lines=buf.split('\n');
      buf=lines.pop();

      for(const line of lines){
        if(!line.startsWith('data: '))continue;
        const payload=line.slice(6);
        if(payload==='[DONE]')continue;
        try{
          const ev=JSON.parse(payload);
          if(ev.type==='token'){
            fullText+=ev.content;
            bubbleEl.textContent=fullText;
            msgsEl.scrollTop=msgsEl.scrollHeight;
          } else if(ev.type==='error'){
            fullText=ev.content;
            bubbleEl.textContent=fullText;
          } else if(ev.type==='done'){
            session=ev.session;
            metaEl.textContent=ev.meta||'';
            history.push([msg,fullText]);
            updateSidebar();
          }
        }catch(e){}
      }
    }
  }catch(e){
    bubbleEl.textContent='Error: '+e;
  }
  metaEl.removeAttribute('id');
  document.getElementById('send-btn').disabled=false;
}

function addBubble(role,text,meta){
  const div=document.createElement('div');
  div.className='msg '+role;
  let html='<div class="bubble">'+escapeHtml(text)+'</div>';
  if(meta)html='<div><div class="bubble">'+escapeHtml(text)+'</div><div class="meta">'+escapeHtml(meta)+'</div></div>';
  div.innerHTML=html;
  const msgs=document.getElementById('messages');
  msgs.appendChild(div);
  msgs.scrollTop=msgs.scrollHeight;
}

function updateSidebar(){
  if(!session)return;
  document.getElementById('sb-user').textContent=session.username;
  const tb=document.getElementById('sb-tier');
  tb.textContent=session.tier+' tier';
  tb.style.background=TIER_COLORS[session.tier]||'#95a5a6';
  document.getElementById('sb-reqs').textContent=session.requests;
  document.getElementById('sb-tokens').textContent=session.prompt_tokens+session.completion_tokens;
  document.getElementById('sb-prompt').textContent=session.prompt_tokens;
  document.getElementById('sb-comp').textContent=session.completion_tokens;
  const lats=session.latencies||[];
  const avg=lats.length?lats.reduce((a,b)=>a+b,0)/lats.length:0;
  document.getElementById('sb-lat').textContent=avg.toFixed(2)+'s';
  // Request rate limit bar
  const limit=session.req_limit||0;
  const rw=session.req_window||'1m';
  const pct=limit?Math.min(100,(session.requests/limit)*100):0;
  const bc=pct<70?'#2ecc71':pct<90?'#f39c12':'#e74c3c';
  document.getElementById('sb-rl-label').textContent='Requests ('+session.requests+'/'+limit+' per '+rw+')';
  document.getElementById('sb-rl-pct').textContent=pct.toFixed(0)+'%';
  const bar=document.getElementById('sb-rl-bar');
  bar.style.width=pct+'%';bar.style.background=bc;
  // Token rate limit bar
  const totalTokens=session.prompt_tokens+session.completion_tokens;
  const tLimit=session.token_limit||0;
  const tw=session.token_window||'1m';
  const tPct=tLimit?Math.min(100,(totalTokens/tLimit)*100):0;
  const tBc=tPct<70?'#2ecc71':tPct<90?'#f39c12':'#e74c3c';
  document.getElementById('sb-tl-label').textContent='Tokens ('+totalTokens+'/'+tLimit+' per '+tw+')';
  document.getElementById('sb-tl-pct').textContent=tPct.toFixed(0)+'%';
  const tBar=document.getElementById('sb-tl-bar');
  tBar.style.width=tPct+'%';tBar.style.background=tBc;
  // Alert
  const al=document.getElementById('sb-rl-alert');
  if(session.rate_limited>0){al.style.display='block';al.textContent='Rate Limited: '+session.rate_limited+' requests rejected';}
  else{al.style.display='none';}
}

var tokenInput=document.getElementById('ocp-token');
if(tokenInput)tokenInput.addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});
</script>
</body>
</html>""".replace('__GRAFANA_URL__', GRAFANA_URL)


@app.route("/")
def index():
    return Response(HTML_PAGE, content_type="text/html")


def _get_user_groups(ocp_token):
    """Get user's groups via Kubernetes TokenReview API."""
    try:
        headers = _k8s_headers()
        if not headers:
            return []
        ca = K8S_CA_PATH if os.path.exists(K8S_CA_PATH) else False
        resp = http_requests.post(
            f"{K8S_API}/apis/authentication.k8s.io/v1/tokenreviews",
            headers={**headers, "Content-Type": "application/json"},
            json={
                "apiVersion": "authentication.k8s.io/v1",
                "kind": "TokenReview",
                "spec": {"token": ocp_token},
            },
            verify=ca, timeout=10,
        )
        if resp.status_code == 201:
            status = resp.json().get("status", {})
            if status.get("authenticated"):
                return status.get("user", {}).get("groups", [])
    except Exception:
        pass
    return []


def _exchange_token(ocp_token, groups=None):
    """Exchange an OCP token for a MaaS session dict. Returns (session, error)."""
    try:
        resp = http_requests.post(
            f"{MAAS_GATEWAY}/maas-api/v1/tokens",
            headers={"Authorization": f"Bearer {ocp_token}"},
            verify=False, timeout=10,
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

    # Resolve groups if not provided
    if groups is None:
        groups = _get_user_groups(ocp_token)

    tier = "free"
    try:
        resp = http_requests.post(
            f"{MAAS_GATEWAY}/maas-api/v1/tiers/lookup",
            headers={"Authorization": f"Bearer {ocp_token}"},
            json={"groups": groups}, verify=False, timeout=10,
        )
        if resp.status_code == 200:
            tier = resp.json().get("tier", "free")
    except Exception:
        pass

    # Fetch dynamic limits from cluster CRDs
    all_limits = _fetch_tier_limits()
    tier_limits = all_limits.get(tier, {})

    session = {
        "ocp_token": ocp_token,
        "maas_token": maas_token,
        "username": username,
        "tier": tier,
        "req_limit": tier_limits.get("req_limit", 0),
        "req_window": tier_limits.get("req_window", "1m"),
        "token_limit": tier_limits.get("token_limit", 0),
        "token_window": tier_limits.get("token_window", "1m"),
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "requests": 0,
        "rate_limited": 0,
        "latencies": [],
    }
    return session, None


@app.route("/api/auto-login", methods=["POST"])
def api_auto_login():
    """Auto-login using the OAuth proxy forwarded access token."""
    ocp_token = request.headers.get("X-Forwarded-Access-Token", "").strip()
    if not ocp_token:
        return jsonify({"success": False, "error": "No OAuth token forwarded."})

    forwarded_user = request.headers.get("X-Forwarded-User", "")
    # oauth-proxy sends groups as comma-separated header
    forwarded_groups = request.headers.get("X-Forwarded-Groups", "")
    groups = [g.strip() for g in forwarded_groups.split(",") if g.strip()] if forwarded_groups else None

    session, error = _exchange_token(ocp_token, groups=groups)
    if error:
        return jsonify({"success": False, "error": error})

    if forwarded_user:
        session["username"] = forwarded_user

    return jsonify({"success": True, "session": session})


@app.route("/api/login", methods=["POST"])
def api_login():
    """Manual login fallback (local dev without oauth-proxy)."""
    data = request.get_json()
    ocp_token = (data.get("ocp_token") or "").strip()
    if not ocp_token:
        return jsonify({"success": False, "error": "Enter your token."})

    session, error = _exchange_token(ocp_token)
    if error:
        return jsonify({"success": False, "error": error})

    return jsonify({"success": True, "session": session})


@app.route("/api/chat/stream", methods=["POST"])
def api_chat_stream():
    data = request.get_json()
    s = data.get("session")
    message = data.get("message", "")
    hist = data.get("history", [])

    if not s or not s.get("maas_token"):
        def err_gen():
            yield 'data: ' + json.dumps({"type": "error", "content": "Please login first."}) + '\n\n'
            yield 'data: ' + json.dumps({"type": "done", "session": s, "meta": ""}) + '\n\n'
        return Response(err_gen(), content_type="text/event-stream")

    msgs = []
    for pair in hist:
        if len(pair) >= 2:
            msgs.append({"role": "user", "content": pair[0]})
            if pair[1]:
                msgs.append({"role": "assistant", "content": pair[1]})
    msgs.append({"role": "user", "content": message})

    def generate():
        t0 = time.time()
        s["requests"] += 1
        completion_tokens = 0

        try:
            resp = http_requests.post(
                f"{MAAS_GATEWAY}/{MODEL_PATH}/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {s['maas_token']}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": MODEL_PATH.split("/")[-1],
                    "messages": msgs,
                    "max_tokens": 512,
                    "temperature": 0.7,
                    "stream": True,
                    "stream_options": {"include_usage": True},
                },
                verify=False, timeout=180, stream=True,
            )

            lat_first = None

            if resp.status_code == 429:
                s["rate_limited"] += 1
                lat = time.time() - t0
                s["latencies"].append(round(lat, 3))
                # Try to extract custom message from the 429 response body
                rl_msg = f"RATE LIMITED (429) -- {s['tier']} tier limit reached."
                try:
                    body = resp.json()
                    if body.get("message"):
                        rl_msg = body["message"]
                except Exception:
                    pass
                yield 'data: ' + json.dumps({"type": "error", "content": rl_msg}) + '\n\n'
                yield 'data: ' + json.dumps({"type": "done", "session": s, "meta": f"Latency: {lat:.2f}s"}) + '\n\n'
                return

            if resp.status_code != 200:
                lat = time.time() - t0
                s["latencies"].append(round(lat, 3))
                yield 'data: ' + json.dumps({"type": "error", "content": f"Error ({resp.status_code}): {resp.text[:300]}"}) + '\n\n'
                yield 'data: ' + json.dumps({"type": "done", "session": s, "meta": f"Latency: {lat:.2f}s"}) + '\n\n'
                return

            prompt_tokens = 0
            for line in resp.iter_lines(decode_unicode=True):
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
                        yield 'data: ' + json.dumps({"type": "token", "content": content}) + '\n\n'
                except Exception:
                    pass

            lat = time.time() - t0
            s["latencies"].append(round(lat, 3))
            s["prompt_tokens"] += prompt_tokens
            s["completion_tokens"] += completion_tokens

            ttft = f"TTFT: {lat_first:.2f}s | " if lat_first else ""
            meta = f"{ttft}{prompt_tokens} prompt + {completion_tokens} completion tokens | Total: {lat:.2f}s"
            yield 'data: ' + json.dumps({"type": "done", "session": s, "meta": meta}) + '\n\n'

        except http_requests.exceptions.Timeout:
            s["latencies"].append(round(time.time() - t0, 3))
            yield 'data: ' + json.dumps({"type": "error", "content": "Timeout -- Model did not respond within 180s."}) + '\n\n'
            yield 'data: ' + json.dumps({"type": "done", "session": s, "meta": ""}) + '\n\n'
        except Exception as e:
            s["latencies"].append(round(time.time() - t0, 3))
            yield 'data: ' + json.dumps({"type": "error", "content": f"Error: {str(e)[:300]}"}) + '\n\n'
            yield 'data: ' + json.dumps({"type": "done", "session": s, "meta": ""}) + '\n\n'

    return Response(generate(), content_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "7860"))
    app.run(host="0.0.0.0", port=port, debug=False)
