import type { EndpointApiStyle } from "./providers";

export type { EndpointApiStyle, ProviderType } from "./providers";

export interface ClaimRequirement {
  path: string;
  contains?: string | string[];
  equals?: string | number | boolean;
}

export type GatewayAuthMethod = "attest" | "api_key";

export interface IssuerAuthConfig {
  jwks_url: string;
  /**
   * Accepted `iss` values. Required, and the only thing that scopes an app to
   * one tenant: Firebase, Sign in with Apple and Google Sign-In all sign every
   * customer's tokens with one shared key set, so a JWKS URL identifies nobody.
   * Stored as a list because a project can be migrated between issuers.
   */
  issuer: string[];
  /** Accepted `aud` values, required for the same reason as {@link issuer}. */
  audience: string[];
  user_id_claim: string;
  token_header?: string;
  required_claims: ClaimRequirement[];
  max_token_lifetime_seconds: number;
}

export type AppAttestEnvironment = "production" | "development";

export interface AppleAppAttestAuthentication {
  type: "apple_app_attest";
  issuer: IssuerAuthConfig;
  app_attest: {
    team_id: string;
    bundle_id: string;
    /** Resolved, so never empty: a stored config without one reads as production-only. */
    environments: AppAttestEnvironment[];
  };
}

/**
 * As written to `config_json`, where `environments` appears only for an
 * application that opted in. Keeping it absent otherwise means an ordinary edit
 * never rewrites a configuration to name a default it never asked for, the same
 * way an absent `limits` stays absent.
 */
export interface StoredAppleAppAttestAuthentication {
  type: "apple_app_attest";
  issuer: IssuerAuthConfig;
  app_attest: {
    team_id: string;
    bundle_id: string;
    environments?: AppAttestEnvironment[];
  };
}

export interface ApiKeyAuthentication {
  type: "api_key";
  issuer?: IssuerAuthConfig;
  end_user: {
    header: "x-end-user-id";
    required: boolean;
    fallback: "api_key";
  };
}

export type AuthenticationConfig = AppleAppAttestAuthentication | ApiKeyAuthentication;
export type StoredAuthenticationConfig = StoredAppleAppAttestAuthentication | ApiKeyAuthentication;

export interface ProviderProxyConfig {
  allowed_paths: AllowedPath[];
  allowed_models: string[];
  max_output_tokens?: number;
}

export type OutputClampStyle =
  | "responses"
  | "chat_completions"
  | "gemini_native"
  | "anthropic"
  | "none";

export interface AllowedPathConfig {
  path: string;
  fixed_model?: string;
  clamp?: OutputClampStyle;
}

export type AllowedPath = string | AllowedPathConfig;

export interface RoutingConfig {
  providers: {
    mode: "all" | "selected";
    selected?: Record<string, ProviderProxyConfig>;
  };
  model_rewrites: Record<string, string>;
}

export interface ResolvedRoutingConfig {
  providerMode: "all" | "selected";
  providers: Record<string, ProviderProxyConfig>;
  modelRewrites: Record<string, string>;
}

/**
 * Limits an organization sets on its own application, applied to that
 * application's end users.
 *
 * Not to be confused with the plan allowance in `src/do/OrgQuota.ts`: that is
 * the gateway operator metering the organization, this is the organization
 * policing the people using its app. Neither constrains the other, and a
 * request refused here never spends the allowance.
 *
 * `null` on any field means unlimited. `per_user` applies independently to
 * every authenticated end user; `per_app` is shared by all of them at once.
 */
export interface LimitScopeConfig {
  requests: {
    per_minute: number | null;
    per_day: number | null;
  };
  spending: {
    monthly_usd: number | null;
  };
}

export interface LimitsConfig {
  per_user: LimitScopeConfig;
  per_app: LimitScopeConfig;
}

/**
 * Named endpoints resolve provider and model on the server so an operator can
 * swap models without shipping a new client. Only providers whose native
 * request shape the gateway can compose are allowed.
 */
export interface EndpointTarget {
  /** Provider instance slug, resolved to a provider type at request time. */
  provider: string;
  model: string;
}

export interface EndpointConfig extends EndpointTarget {
  api_style: EndpointApiStyle;
  params?: Record<string, unknown>;
  max_output_tokens?: number;
  fallback?: EndpointTarget[];
}

export type EndpointsConfig = Record<string, EndpointConfig>;

export interface StoredAppConfig {
  authentication: StoredAuthenticationConfig;
  routing: RoutingConfig;
  /** Absent means unlimited, the same way an absent `endpoints` means none. */
  limits?: LimitsConfig;
  endpoints?: EndpointsConfig;
}

/** {@link LimitScopeConfig} as the request path reads it: budgets in microUSD. */
export interface ResolvedLimitScope {
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
  monthlyBudgetMicrousd: number | null;
}

export interface ResolvedLimitsConfig {
  perUser: ResolvedLimitScope;
  perApp: ResolvedLimitScope;
}

export interface AppConfig {
  id: string;
  organizationId: string;
  name: string;
  authentication: AuthenticationConfig;
  routing: ResolvedRoutingConfig;
  /** Always present; an app with no `limits` block resolves to all-null. */
  limits: ResolvedLimitsConfig;
  endpoints: EndpointsConfig;
  status: "active" | "disabled";
}

export interface GatewayIdentity {
  appId: string;
  userId: string;
  jti: string;
  expiresAt: number;
  authMethod: GatewayAuthMethod;
  credentialType: "api_key" | "gateway_token";
  apiKeyId?: string;
}

export interface UsageCounts {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}
