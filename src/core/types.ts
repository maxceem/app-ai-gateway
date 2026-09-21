import type {
  AppConfig,
  EndpointConfig,
  ProviderPolicy,
} from "../shared/app-config.ts";

export type { EndpointApiStyle, ProviderType } from "../shared/capabilities.ts";
export { ENTITLEMENT_CHECKS, ISSUER_PROVIDERS } from "../shared/app-config.ts";
export type {
  AppAttestEnvironment,
  AppAttestEndUser,
  AppleAppAttestAuthentication,
  ApiKeyEndUser,
  ApiKeyAuthentication,
  AppConfig,
  AuthenticationConfig,
  ClaimRequirement,
  EndpointConfig,
  EndpointsConfig,
  EntitlementCheck,
  IssuerAuthentication,
  IssuerProvider,
  LimitScopeConfig,
  LimitsConfig,
  ProviderPolicy,
  RoutingConfig,
} from "../shared/app-config.ts";
export type { OutputClampStyle } from "../shared/capabilities.ts";

export type GatewayAuthMethod = "attest" | "api_key";

export type AllowedPath = ProviderPolicy["allowed_paths"][number];
export type AllowedPathConfig = Exclude<AllowedPath, string>;
export type EndpointTarget = Pick<EndpointConfig, "provider" | "model">;

/**
 * One stored application, as everything inside the Worker reads it.
 *
 * `config` is the parsed configuration itself — the same shape the API accepts
 * and the database holds — rather than a projection of it. There used to be
 * three: the wire type, a normalized "stored" type and a camelCase "resolved"
 * one, and a reader had to know which of them it had been handed. The row's own
 * columns stay beside it, because an app is a row as much as a configuration.
 */
export interface AppRecord {
  id: string;
  organizationId: string;
  name: string;
  status: "active" | "disabled";
  revision: number;
  config: AppConfig;
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
