/** Mirrors the shapes `src/core/config.ts` parses on the Worker side. */

export const PROVIDERS = ["openai", "anthropic", "xai", "gemini", "perplexity"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  xai: "xAI",
  gemini: "Gemini",
  perplexity: "Perplexity",
};

export const CLAMP_STYLES = [
  "responses",
  "chat_completions",
  "gemini_native",
  "anthropic",
  "none",
] as const;
export type ClampStyle = (typeof CLAMP_STYLES)[number];

export const ATTEST_ENVIRONMENTS = ["production", "development"] as const;
export type AttestEnvironment = (typeof ATTEST_ENVIRONMENTS)[number];

export interface ClaimRequirement {
  path: string;
  contains?: string;
  equals?: string | number | boolean;
}

export interface AuthConfig {
  jwks_url?: string;
  user_id_claim?: string;
  token_header?: string;
  required_claims?: ClaimRequirement[];
  max_token_lifetime_seconds?: number;
}

export type AuthenticationConfig =
  | {
      type: "apple_app_attest";
      issuer: AuthConfig;
      app_attest: {
        team_id: string;
        bundle_id: string;
        environments: AttestEnvironment[];
      };
      development_access: boolean;
    }
  | {
      type: "api_key";
      end_user: {
        header: "x-end-user-id";
        required: boolean;
        fallback: "api_key";
      };
    };

export interface AllowedPathObject {
  path: string;
  fixed_model?: string;
  clamp?: ClampStyle;
}

export type AllowedPath = string | AllowedPathObject;

export interface ProviderConfig {
  /** Missing or empty allows every path; a non-empty list restricts access. */
  allowed_paths?: AllowedPath[];
  /** Missing or empty allows every model; a non-empty list restricts access. */
  allowed_models?: string[];
  max_output_tokens?: number;
}

export interface ProxyConfig {
  providers: {
    mode: "all" | "selected";
    selected?: Partial<Record<Provider, ProviderConfig>>;
  };
  model_rewrites?: Record<string, string>;
}

export interface LimitScopeConfig {
  requests: { per_minute: number | null; per_day: number | null };
  spending: { monthly_usd: number | null };
}

export interface LimitsConfig {
  per_user: LimitScopeConfig;
  per_app: LimitScopeConfig;
}

export interface StoredAppConfig {
  authentication: AuthenticationConfig;
  routing: ProxyConfig;
  limits: LimitsConfig;
}

export const pathOf = (path: AllowedPath): string => (typeof path === "string" ? path : path.path);

export const pathObject = (path: AllowedPath): AllowedPathObject =>
  typeof path === "string" ? { path } : path;

/** Keeps configs tidy: a path with no extras is stored as a plain string. */
export function normalizePath(path: AllowedPathObject): AllowedPath {
  if (!path.fixed_model && (!path.clamp || path.clamp === undefined)) return path.path;
  return {
    path: path.path,
    ...(path.fixed_model ? { fixed_model: path.fixed_model } : {}),
    ...(path.clamp ? { clamp: path.clamp } : {}),
  };
}

export function emptyProvider(): ProviderConfig {
  return { allowed_paths: [], allowed_models: [] };
}

export function providerMode(proxy: ProxyConfig): "all" | "selected" {
  return proxy.providers.mode;
}

export function enabledProviders(proxy: ProxyConfig): Provider[] {
  return providerMode(proxy) === "all"
    ? [...PROVIDERS]
    : PROVIDERS.filter((provider) => proxy.providers.selected?.[provider] !== undefined);
}
