import type {
  AppConfig,
  EndpointConfig,
  ProviderPolicy,
} from "../shared/app-config.ts";
import type { AppStatus } from "../shared/app-status.ts";

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
  status: AppStatus;
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
  /** Verified gateway-token expiration, epoch milliseconds. */
  expiresAt?: number;
}

/** A modality a model may price apart from text. */
export type Modality = "image" | "audio" | "video";

/**
 * Tokens of each non-text modality on one side of a request, and `unknown`
 * for those the response did not account for; text is the rest.
 */
export type ModalityCounts = Partial<Record<Modality | "unknown", number>>;

/**
 * What a response said its prompt and its answer were made of. A side is
 * present only where the response broke that side down by modality: absent
 * means it did not say, not that it was all text, and so does `unknown`.
 * `computeCost` in `src/usage/pricing.ts` says what either is billed as.
 */
export interface ModalityTokens {
  input?: ModalityCounts;
  output?: ModalityCounts;
  /** Cached input, disjoint from the uncached input breakdown. */
  cachedInput?: ModalityCounts;
}

export interface UsageCounts {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}
