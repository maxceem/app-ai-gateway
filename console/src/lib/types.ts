import type { StoredAppConfig } from "./config-types";

export interface Session {
  authenticated: boolean;
  expires_at: number | null;
  environment: string;
  gateway_id: string;
}

export interface UsageTotals {
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd: number;
  errors: number;
  blocked: number;
}

export interface AppSummary {
  id: string;
  name: string;
  status: "active" | "disabled";
  authentication_type: "apple_app_attest" | "api_key" | "invalid";
  apple_bundle_id: string | null;
  created_at: string;
  monthly_user_budget_usd: number | null;
  monthly_app_budget_usd: number | null;
  providers: string[];
  allowed_model_count: number;
  dev_access_enabled: boolean;
  users: { total: number; blocked: number };
  usage: UsageTotals;
}

export interface AppListResponse {
  month: string;
  apps: AppSummary[];
}

/** The editable row: exactly the body the upsert endpoint accepts. */
export interface AppRow {
  id: string;
  name: string;
  config: StoredAppConfig;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface ResolvedConfig {
  id: string;
  name: string;
  authentication: StoredAppConfig["authentication"];
  routing: {
    providerMode: "all" | "selected";
    providers: StoredAppConfig["routing"]["providers"]["selected"];
    modelRewrites: Record<string, string>;
  };
  limits: {
    perUser: { requestsPerMinute: number | null; requestsPerDay: number | null; monthlyBudgetMicrousd: number | null };
    perApp: { requestsPerMinute: number | null; requestsPerDay: number | null; monthlyBudgetMicrousd: number | null };
  };
  status: "active" | "disabled";
}

export interface AppResponse {
  app: AppRow;
  resolved: ResolvedConfig | null;
  config_error: string | null;
}

export interface AppUpsertBody {
  name: string;
  config: StoredAppConfig;
  status?: "active" | "disabled";
}

export interface AppCreateBody extends AppUpsertBody {
  /** Preferred slug. The API adds a short suffix if another app claimed it first. */
  id: string;
}

export interface CreatedApp {
  app_id: string;
  api_key: CreatedApiKey | null;
}

export interface GatewayUser {
  id: string;
  status: "active" | "blocked";
  attest_key_id: string | null;
  attest_registered: boolean;
  attest_counter: number;
  attest_env: "production" | "development" | null;
  created_at: string;
  last_seen_at: string | null;
  usage: UsageTotals;
  is_virtual: boolean;
}

export interface UserListResponse {
  app_id: string;
  month: string;
  total: number;
  limit: number;
  offset: number;
  users: GatewayUser[];
}

export interface MonthlyUsage {
  app_id: string;
  month: string;
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface TimeseriesBucket extends UsageTotals {
  date: string;
  provider: string;
}

export interface TimeseriesResponse {
  app_id: string;
  from: string;
  to: string;
  buckets: TimeseriesBucket[];
}

export interface BreakdownRow extends UsageTotals {
  key: string | null;
}

export interface BreakdownResponse {
  app_id: string;
  by: string;
  from: string;
  to: string;
  rows: BreakdownRow[];
}

export type UsageStatus =
  | "ok"
  | "provider_error"
  | "blocked_rate"
  | "blocked_budget"
  | "blocked_user";

export interface UsageEvent {
  id: number;
  user_id: string;
  provider: string;
  model: string;
  route: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd: number;
  app_version: string | null;
  auth_method: "dev" | "attest" | "api_key" | null;
  status: UsageStatus;
  latency_ms: number | null;
  created_at: string;
}

export interface EventsResponse {
  app_id: string;
  limit: number;
  next_before_id: number | null;
  events: UsageEvent[];
}

export interface ModelPrice {
  input?: number;
  output?: number;
  cached_input?: number;
  cache_write?: number;
  per_minute?: number;
  per_hour?: number;
  long_context_threshold?: number;
  long_input?: number;
  long_output?: number;
  long_cached_input?: number;
  long_cache_write?: number;
}

export interface PricesResponse {
  prices: Record<import("./config-types").Provider, Record<string, ModelPrice>>;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  status: "active" | "revoked";
  created_at: string;
  last_used_at: string | null;
}

export interface ApiKeyListResponse {
  app_id: string;
  keys: ApiKeyRow[];
}

export interface CreatedApiKey {
  id: string;
  name: string;
  key: string;
  key_prefix: string;
  created_at: string;
}

export interface DevelopmentCredential {
  enabled: boolean;
  secret_prefix: string | null;
  created_at: string | null;
  rotated_at: string | null;
}

export interface CreatedDevelopmentCredential extends DevelopmentCredential {
  secret: string;
}
