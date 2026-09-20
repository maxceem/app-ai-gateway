import type {
  AuthenticationConfig,
  EndpointsConfig,
  ResolvedLimitsConfig,
  ResolvedRoutingConfig,
} from "../shared/app-config.ts";

export type { EndpointApiStyle, ProviderType } from "../shared/capabilities.ts";
export { ENTITLEMENT_CHECKS, ISSUER_PROVIDERS } from "../shared/app-config.ts";
export type {
  AppAttestEnvironment,
  AppAttestEndUser,
  AppInstallEndUser,
  AppleAppAttestAuthentication,
  ApiKeyEndUser,
  ApiKeyAuthentication,
  AuthenticationConfig,
  ClaimRequirement,
  EndpointConfig,
  EndpointsConfig,
  EntitlementCheck,
  EndUserIdentity,
  HeaderEndUser,
  IssuerAuthConfig,
  IssuerEndUser,
  IssuerProvider,
  LimitScopeConfig,
  LimitsConfig,
  ProviderProxyConfig,
  ResolvedLimitScope,
  ResolvedLimitsConfig,
  ResolvedRoutingConfig,
  RoutingConfig,
  StoredAppConfig,
  StoredAppleAppAttestAuthentication,
  StoredAuthenticationConfig,
} from "../shared/app-config.ts";
export type { OutputClampStyle } from "../shared/capabilities.ts";

export type GatewayAuthMethod = "attest" | "api_key";

export type AllowedPathConfig = Exclude<
  import("../contracts/schemas.ts").ProviderPolicy["allowed_paths"][number],
  string
>;
export type AllowedPath = import("../contracts/schemas.ts").ProviderPolicy["allowed_paths"][number];
export type EndpointTarget = Pick<
  import("../contracts/schemas.ts").EndpointConfig,
  "provider" | "model"
>;

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
  userId: string | null;
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
