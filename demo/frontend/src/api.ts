import type { Session, MaaSModel, ApiKey, AppConfig, UsageStats } from "./types";

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(url, options);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

function authHeaders(session: Session): Record<string, string> {
  return { "X-MaaS-Token": session.maas_token };
}

export async function autoLogin(): Promise<{
  success: boolean;
  session?: Session;
  error?: string;
}> {
  return fetchJson("/api/auto-login", { method: "POST" });
}

export async function login(ocp_token: string): Promise<{
  success: boolean;
  session?: Session;
  error?: string;
}> {
  return fetchJson("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ocp_token }),
  });
}

export async function fetchModels(session: Session): Promise<MaaSModel[]> {
  const data = await fetchJson<{ models?: MaaSModel[] }>("/api/models", {
    headers: authHeaders(session),
  });
  return data.models || [];
}

export async function fetchKeys(session: Session): Promise<ApiKey[]> {
  const data = await fetchJson<{ keys?: ApiKey[] }>("/api/keys", {
    headers: authHeaders(session),
  });
  return data.keys || [];
}

export async function createKey(
  session: Session,
  name?: string,
  expiration?: string
): Promise<ApiKey> {
  return fetchJson("/api/keys", {
    method: "POST",
    headers: { ...authHeaders(session), "Content-Type": "application/json" },
    body: JSON.stringify({ name, expiration }),
  });
}

export async function deleteKey(session: Session, keyId: string): Promise<void> {
  await fetch(`/api/keys/${keyId}`, {
    method: "DELETE",
    headers: authHeaders(session),
  });
}

export async function fetchConfig(): Promise<AppConfig> {
  return fetchJson("/api/config");
}

export async function fetchUsageStats(range: string = "24h"): Promise<UsageStats> {
  return fetchJson(`/api/usage/stats?range=${range}`);
}

export async function* streamChat(
  session: Session,
  message: string,
  history: [string, string][],
  model?: string
): AsyncGenerator<{ type: string; content?: string; session?: Session; meta?: string }> {
  const resp = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session, message, history, model }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    yield { type: "error", content: `Error (${resp.status}): ${text.slice(0, 300)}` };
    return;
  }

  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop()!;

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // skip malformed lines
      }
    }
  }
}
