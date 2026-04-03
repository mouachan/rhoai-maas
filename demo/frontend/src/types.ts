export interface Session {
  ocp_token: string;
  maas_token: string;
  username: string;
  tier: string;
  req_limit: number;
  req_window: string;
  token_limit: number;
  token_window: string;
  is_admin: boolean;
  prompt_tokens: number;
  completion_tokens: number;
  requests: number;
  rate_limited: number;
  latencies: number[];
}

export interface ModelCatalogEntry {
  display_name: string;
  description: string;
  category: string;
  provider: string;
  context_window: number;
  cost_per_1k_prompt_tokens: number;
  cost_per_1k_completion_tokens: number;
  tags: string[];
  documentation_url: string;
}

export interface ModelStatus {
  latency_p50: number;
  latency_p95: number;
  latency_p99: number;
  throughput_rps: number;
  availability: "up" | "degraded" | "down";
  error_rate: number;
}

export interface MaaSModel {
  id: string;
  name?: string;
  tiers?: string[];
  endpoint?: string;
  catalog?: ModelCatalogEntry;
  [key: string]: unknown;
}

export interface EnrichedModel extends MaaSModel {
  catalog?: ModelCatalogEntry;
  status?: ModelStatus;
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
    tier?: string;
    requests: number;
    tokens: number;
    models: { model: string; requests: number; prompt_tokens: number; completion_tokens: number }[];
  }[];
}

export interface SloMetrics {
  latency: { p50: number; p95: number; p99: number };
  ttft: { p50: number; p95: number; p99: number };
  tpot_p95: number;
  throughput_rps: number;
  error_rate: number;
  // Admin-only fields (absent for non-admin)
  token_throughput?: { prompt_tps: number; completion_tps: number; total_tps: number };
  error_breakdown?: { reason: string; count: number }[];
  queue_time_p95?: number;
  running_requests?: number;
  waiting_requests?: number;
  kv_cache_pct?: number;
  latency_over_time?: { date: string; p50: number; p95: number; p99: number }[];
  ttft_over_time?: { date: string; ttft_p95: number }[];
  throughput_over_time?: { date: string; rps: number }[];
}

export interface CostStats {
  total_cost: number;
  currency: string;
  range: string;
  cost_by_user: {
    user: string;
    tier: string;
    total_tokens: number;
    estimated_cost: number;
    models: { model: string; total_tokens: number; estimated_cost: number }[];
  }[];
  cost_by_model: { model: string; total_tokens: number; estimated_cost: number }[];
  cost_by_tier: { tier: string; estimated_cost: number }[];
  cost_over_time: { date: string; estimated_cost: number }[];
}

