import type { EndpointApiStyle, EndpointProvider, ProviderType } from "./providers";

export type { EndpointApiStyle, EndpointProvider, ProviderType } from "./providers";

export interface ClaimRequirement {
  path: string;
  contains?: string | string[];
  equals?: string | number | boolean;
}

export type GatewayAuthMethod = "attest" | "api_key";

export interface IssuerAuthConfig {
  jwks_url: string;
  user_id_claim: string;
  token_header?: string;
  required_claims: ClaimRequirement[];
  max_token_lifetime_seconds: number;
}

export interface AppleAppAttestAuthentication {
  type: "apple_app_attest";
  issuer: IssuerAuthConfig;
  app_attest: {
    team_id: string;
    bundle_id: string;
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
    selected?: Partial<Record<ProviderType, ProviderProxyConfig>>;
  };
  model_rewrites: Record<string, string>;
}

export interface ResolvedRoutingConfig {
  providerMode: "all" | "selected";
  providers: Partial<Record<ProviderType, ProviderProxyConfig>>;
  modelRewrites: Record<string, string>;
}

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
  provider: EndpointProvider;
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
  authentication: AuthenticationConfig;
  routing: RoutingConfig;
  limits: LimitsConfig;
  endpoints?: EndpointsConfig;
}

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
