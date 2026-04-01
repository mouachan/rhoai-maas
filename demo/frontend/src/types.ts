export interface Session {
  ocp_token: string;
  maas_token: string;
  username: string;
  tier: string;
  req_limit: number;
  req_window: string;
  token_limit: number;
  token_window: string;
  prompt_tokens: number;
  completion_tokens: number;
  requests: number;
  rate_limited: number;
  latencies: number[];
}

export interface MaaSModel {
  id: string;
  name?: string;
  tiers?: string[];
  endpoint?: string;
  [key: string]: unknown;
}

export interface ApiKey {
  id: string;
  name?: string;
  key?: string;
  created_at?: string;
  expires_at?: string;
  [key: string]: unknown;
}

export interface AppConfig {
  grafana_url: string;
  gateway_url: string;
  model_namespace: string;
}

export interface TierLimits {
  [tier: string]: {
    req_limit?: number;
    req_window?: string;
    token_limit?: number;
    token_window?: string;
  };
}

export interface UsageStats {
  total_requests: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  avg_latency: number;
  rate_limited: number;
  requests_by_model: {
    model: string;
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    users?: { user: string; requests: number; prompt_tokens: number; completion_tokens: number }[];
  }[];
  requests_by_day: { date: string; requests: number }[];
  tokens_by_day: { date: string; prompt_tokens: number; completion_tokens: number }[];
  requests_by_tier: { tier: string; requests: number }[];
  requests_by_user: {
    user: string;
    requests: number;
    tokens: number;
    models: { model: string; requests: number; prompt_tokens: number; completion_tokens: number }[];
  }[];
}
