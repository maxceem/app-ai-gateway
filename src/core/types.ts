import type {
  AppConfig,
  EndpointConfig,
  ProviderPolicy,
} from "../shared/app-config.ts";

/** How a client first proved itself to an application: an API key, or an App Attest key. */
export type AuthMethod = "attest" | "api_key";

export type AllowedPath = ProviderPolicy["allowed_paths"][number];
export type AllowedPathConfig = Exclude<AllowedPath, string>;
export type EndpointTarget = Pick<EndpointConfig, "provider" | "model">;

/**
 * One stored application, as everything inside the Worker reads it.
 *
 * `config` is the parsed configuration itself — the same shape the API accepts
 * and the database holds — rather than a projection of it. The row's own
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
  /**
   * How the client proved itself, which a gateway token carries over from its
   * exchange: one minted from an API key is `api_key` here.
   */
  authMethod: AuthMethod;
  /**
   * What this request presented, which is a different fact: that same token
   * is a `gateway_token`, and only a key sent on every request is `api_key`.
   */
  credentialType: "api_key" | "gateway_token";
  apiKeyId?: string;
}

export interface UsageCounts {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}
