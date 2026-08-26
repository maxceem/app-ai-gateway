import type { StoredAppConfig } from "./config-types";

/** Optional deployment features, read once before the app renders. */
export interface Capabilities {
  billing: boolean;
  registrationOpen: boolean;
  googleAuth: boolean;
}

export interface OperatorUser {
  id: string;
  name: string | null;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: string;
}

export type OrganizationRole = "owner" | "admin" | "member";

export interface OrganizationSummary {
  id: string;
  name: string;
  createdAt: string;
}

export interface OrganizationMembership {
  organization: OrganizationSummary;
  role: OrganizationRole;
  status: "active";
  joinedAt: string;
}

export interface OrganizationMember extends OperatorUser {
  role: OrganizationRole;
  status: "active";
  joinedAt: string;
}

/** The console's identity: who the operator is and what they may do here. */
export interface Session {
  user: OperatorUser | null;
  organization: OrganizationSummary | null;
  role: OrganizationRole;
  memberships: OrganizationMembership[];
  credentialType: "session" | "apiKey";
}

export interface SessionResponse {
  session: Session;
}

export interface OrganizationListResponse {
  organizations: OrganizationMembership[];
}

export interface MemberListResponse {
  members: OrganizationMember[];
}

export interface ManagementKey {
  id: string;
  organizationId: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface ManagementKeyListResponse {
  keys: ManagementKey[];
}

/** The plaintext token is present exactly once, in the create response. */
export interface CreatedManagementKey extends ManagementKey {
  plaintext: string;
}

export type BillingInactiveReason =
  | "trial_expired"
  | "past_due"
  | "canceled"
  | "missing_subscription"
  | "service_inactive"
  | "billing_unavailable";

export interface BillingAccess {
  status: "active" | "trialing" | "inactive";
  reason?: BillingInactiveReason;
  selfHosted?: boolean;
  subscriptionStatus?: string;
  planKey?: string;
  planName?: string;
  billingPeriod?: "month" | "year";
  trialEndsAt?: string;
  renewsAt?: string;
  endsAt?: string;
  canUpgrade?: boolean;
  billingErrorCode?: string;
}

export interface BillingStatusResponse {
  access: BillingAccess;
}

export interface BillingPrice {
  billingPeriod: "month" | "year";
  priceAmountCents: number;
  priceCurrency: string;
}

export interface BillingPlan {
  planKey: string;
  name: string;
  description: string;
  features: string[];
  trialDays: number;
  prices: BillingPrice[];
}

export interface BillingPlansResponse {
  plans: BillingPlan[];
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
  /** Null for passthrough proxy traffic. */
  endpoint_slug: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd: number;
  app_version: string | null;
  auth_method: "attest" | "api_key" | null;
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
