import type { StoredAppConfig } from "./config-types";

/** Optional deployment features, read once before the app renders. */
export interface Capabilities {
  billing: boolean;
  registrationOpen: boolean;
  googleAuth: boolean;
  termsOfServiceUrl?: string;
  privacyPolicyUrl?: string;
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

export interface ManagementKey {
  id: string;
  organizationId: string;
  name: string;
  /** Last characters of the token; null for keys created before hints existed. */
  tokenHint: string | null;
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

/**
 * Provider credentials are write-only: `secretHint` is the only fragment of a
 * stored secret the API ever returns, so no type here carries a plaintext.
 */
/**
 * Gateway types the API can return. Creation is narrower — see
 * {@link CREATABLE_GATEWAY_TYPES} — because a type is only creatable once the
 * Worker has an adapter for it.
 */
export type ProviderGatewayType = "cf_aig" | "vercel";

export interface CfAigConfig {
  accountId: string;
  gatewayId: string;
}

/** Vercel's origin is fixed in adapter code, so its config is empty. */
export type VercelGatewayConfig = Record<string, never>;

/** Discriminated by `type`: each gateway's configuration is its own shape. */
export type ProviderGatewayConfig =
  | { type: "cf_aig"; config: CfAigConfig }
  | { type: "vercel"; config: VercelGatewayConfig };

/**
 * A reusable connection to someone else's gateway. Its token is encrypted once
 * and shared by every provider instance routed through it.
 */
export type ProviderGateway = ProviderGatewayConfig & {
  id: string;
  name: string;
  secretHint: string;
  /** Active provider instances routed through this gateway. */
  providerCount: number;
  /**
   * Every row referencing the gateway, disabled ones included. Those are kept
   * for re-enabling and still hold the foreign key, so this — not
   * `providerCount` — is what decides whether the gateway can be deleted.
   */
  referencedCount: number;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

export interface ProviderGatewayListResponse {
  gateways: ProviderGateway[];
}

/**
 * Discriminated the same way the API's create schema is: each gateway asks for
 * exactly the non-secret fields it needs to be reachable, and the API rejects
 * any it has no use for.
 */
export type ProviderGatewayCreateBody =
  | { type: "cf_aig"; name: string; accountId: string; gatewayId: string; token: string }
  | { type: "vercel"; name: string; token: string };

export interface ProviderGatewayResponse {
  gateway: ProviderGateway;
  /** Absent on rename, which never re-probes the connection. */
  validated?: boolean;
  /**
   * Why the probe did not confirm the connection. A gateway write reports its
   * probe rather than failing on it, so this is how a stored-but-unconfirmed
   * connection explains itself.
   */
  reason?: ProbeReason;
  status?: number;
}

/**
 * A gateway connection probed on its own, before any row exists: the create
 * body minus the operator's label, and discriminated the same way.
 */
export type ProviderGatewayTestBody =
  | { type: "cf_aig"; accountId: string; gatewayId: string; token: string }
  | { type: "vercel"; token: string };

/**
 * How one instance is routed inside its gateway. Null for a direct instance and
 * for gateways that take no routing configuration, Cloudflare's included.
 */
export interface GatewayRouteConfig {
  modelPrefix?: string;
  providerOnly?: string[];
}

/** Per-1M-token overrides, keyed by model name. */
export type ProviderPricing = Record<string, { input: number; output: number }>;

export interface ProviderCredential {
  id: string;
  type: import("./config-types").Provider;
  /** The `/proxy/{slug}/…` path segment; defaults to the provider type. */
  slug: string;
  name: string;
  /** `null` on a gateway-routed row, which owns no secret of its own. */
  secretHint: string | null;
  /** `null` routes straight to the provider's native API. */
  providerGatewayId: string | null;
  gatewayRoute: GatewayRouteConfig | null;
  /**
   * The operator's own origin for this instance, canonicalized by the server.
   * `null` means the provider type's own base URL; always `null` on a
   * gateway-routed row, which cannot carry one.
   */
  baseUrl: string | null;
  pricing: ProviderPricing | null;
  /**
   * `disabled` is a reversible pause: the row keeps its secret, its pricing and
   * its slug, and requests to it fail with provider_disabled. Only deleting the
   * row frees its slug, so enabling it again always works.
   */
  status: "active" | "disabled";
  createdAt: string;
  createdBy: string;
}

export interface ProviderListResponse {
  providers: ProviderCredential[];
}

/** Exactly one of `secret` and `providerGatewayId`, mirroring the API. */
export interface ProviderCreateBody {
  type: import("./config-types").Provider;
  name: string;
  slug?: string;
  secret?: string;
  providerGatewayId?: string;
  /** Only ever sent with `secret`: a gateway-routed row owns no origin. */
  baseUrl?: string;
  pricing?: ProviderPricing;
}

/** A credential probed before it exists: the same secret, without the row. */
export interface ProviderTestBody {
  type: import("./config-types").Provider;
  secret?: string;
  providerGatewayId?: string;
  baseUrl?: string;
}

/**
 * Why a probe did not confirm a credential. Only `rejected` is a verdict
 * against it, and only a gateway write reports one: the providers API turns
 * that same refusal into a `provider_key_invalid` error instead.
 */
export type ProbeReason = "no_probe" | "unreachable" | "unexpected_status" | "rejected";

/**
 * A probe's answer. `validated: false` is never "the credential is bad" — the
 * reason says what stopped the check, which is what the operator can act on.
 */
export interface ProviderTestResult {
  validated: boolean;
  reason?: ProbeReason;
  status?: number;
}

export interface ProviderUpdateBody {
  name?: string;
  secret?: string;
  /** `null` returns the instance to its provider type's own base URL. */
  baseUrl?: string | null;
  pricing?: ProviderPricing | null;
  /** Pause or resume the instance. The slug is held either way. */
  status?: "active" | "disabled";
}

export interface ProviderResponse {
  provider: ProviderCredential;
  /** `false` means the probe was inconclusive, not that the key is bad. */
  validated: boolean | null;
}

/** Raw LemonSqueezy subscription status, passed through unmapped. */
export type BillingSubscriptionStatus =
  | "on_trial"
  | "active"
  | "paused"
  | "past_due"
  | "unpaid"
  | "cancelled"
  | "expired";

/**
 * The plan the organization may use right now. Resolved either from an
 * access-granting subscription or, failing that, from the service's default
 * plan — which is what `isDefault` distinguishes.
 */
export interface EntitledPlan {
  planKey: string;
  planName: string;
  limits?: unknown;
  isDefault: boolean;
}

/**
 * What the organization is paying for, reported whether or not it still
 * entitles anything: a lapsed subscription is exactly what "your plan ended"
 * is written from.
 */
export interface SubscriptionState {
  status: BillingSubscriptionStatus;
  planKey: string;
  planName: string;
  billingPeriod: "month" | "year" | null;
  renewsAt: string | null;
  endsAt: string | null;
  trialEndsAt: string | null;
  source: "lemon_squeezy" | "manual";
}

/**
 * Mirrors the gateway's `GatewayBillingAccess`. The two non-`billed` states are
 * the gateway's own: the billing service does not know it is absent, nor that
 * it is unreachable.
 */
export type BillingAccess =
  | { state: "self_hosted" }
  | { state: "unavailable"; billingErrorCode?: string }
  | { state: "billed"; plan: EntitledPlan | null; subscription: SubscriptionState | null };

/**
 * The organization's month so far against the allowance its plan grants.
 * `limit` is absent on a plan that sets no ceiling. Only ever read from a
 * deployment with billing enabled; self-hosted consoles never fetch it.
 */
export interface OrganizationQuota {
  month: string;
  used: number;
  limit?: number;
  resetAt: string;
}

export interface BillingStatusResponse {
  access: BillingAccess;
  quota?: OrganizationQuota;
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
  providers: string[];
  /**
   * The slugs this app names outright: selected-mode policy keys, endpoint
   * targets and endpoint fallbacks. Unlike `providers`, an all-mode app is not
   * expanded here — it reaches every instance without referencing any, which is
   * what makes this the right answer to "which apps use this provider?".
   */
  referenced_providers: string[];
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
  endpoints: import("./config-types").EndpointsConfig;
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

/**
 * How an event's cost was arrived at. `reported` is the upstream's own figure
 * for that request, which is what the operator was actually charged;
 * `computed` is the deployment's price catalog; `unresolved` is a successful
 * provider response whose cost neither source could establish, so its
 * `cost_usd` is zero because nothing was measurable, not because nothing was
 * spent.
 */
export type CostSource = "computed" | "reported" | "unresolved";

/**
 * Whose credential paid, where the configuration settles it. Never inferred
 * from a successful response: `null` means nothing settled it, which the UI has
 * to say plainly rather than dressing up as "your key".
 */
export type CredentialSource = "direct" | "byok" | "gateway_system" | "unknown";

export interface UsageEvent {
  id: number;
  user_id: string;
  /**
   * Non-secret ID of the app API key that authenticated the request, including
   * the client-proof key carried by an exchanged gateway token. Null when the
   * request was not attributed to a key (for example attested traffic).
   */
  api_key_id: string | null;
  provider: string;
  /** The gateway that carried the request; null on a direct call. */
  provider_gateway_id: string | null;
  provider_gateway_type: ProviderGatewayType | null;
  credential_source: CredentialSource | null;
  /** Who made the model. Analytics only — it never affects allowlists or quota. */
  model_author: string | null;
  /** What the upstream said served the request. Null means unknown, not a guarantee. */
  served_provider: string | null;
  served_model: string | null;
  model: string;
  route: string;
  /** Null for passthrough proxy traffic. */
  endpoint_slug: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** What the upstream said it cost, on routes that report one. */
  reported_cost_usd: number | null;
  /** Null on blocked traffic and on events recorded before the field existed. */
  cost_source: CostSource | null;
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

/** Which authentication call an attempt was: a token exchange or a key registration. */
export type AuthEventName = "token_exchange" | "register";

export interface AuthEvent {
  id: number;
  /** Null where the attempt was refused before any identity was established. */
  user_id: string | null;
  event: AuthEventName;
  auth_method: "attest" | "api_key" | null;
  /** `ok`, or the error code the client was handed. Free-form: new codes appear here first. */
  outcome: string;
  /** The granular cause behind the outcome. Diagnostic only — clients never see it. */
  reason: string | null;
  app_version: string | null;
  latency_ms: number | null;
  /** Set only on the exchange that ended a claim-propagation window. */
  claim_delay_ms: number | null;
  created_at: string;
}

export interface AuthEventsResponse {
  app_id: string;
  limit: number;
  next_before_id: number | null;
  events: AuthEvent[];
}

export interface AuthOutcomeBucket {
  date: string;
  event: AuthEventName;
  outcome: string;
  reason: string | null;
  count: number;
}

export interface UsageFailureBucket {
  date: string;
  status: string;
  count: number;
}

export interface AuthEventSummary {
  app_id: string;
  days: number;
  from: string;
  to: string;
  daily: AuthOutcomeBucket[];
  usage_failures: UsageFailureBucket[];
  token_exchange: {
    total: number;
    ok: number;
    /** Null when the window holds no exchanges, which is not a perfect score. */
    success_rate: number | null;
  };
  claim_delay: {
    count: number;
    avg_ms: number | null;
    p50_ms: number | null;
    p95_ms: number | null;
  };
  /** Users inside an unclosed claim-propagation window right now. */
  pending_users: number;
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
