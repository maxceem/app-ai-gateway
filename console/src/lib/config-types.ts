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

export interface ClaimRequirement {
  path: string;
  contains?: string | string[];
  equals?: string | number | boolean;
}

/**
 * Every field except `token_header` is required by the Worker; they are
 * optional here because a draft passes through incomplete states while an
 * operator types, and the raw JSON editor can hold anything. The save is what
 * enforces the contract.
 */
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
      /** App Attest is verified against Apple's production environment only. */
      app_attest: {
        team_id: string;
        bundle_id: string;
      };
    }
  | {
      type: "api_key";
      end_user: {
        header: "x-end-user-id";
        required: boolean;
        fallback: "api_key";
      };
      /**
       * Optional. With an issuer, clients exchange their key plus an issuer JWT
       * for a short-lived gateway token and bare keys stop working on the data
       * plane. Without one, the key is used directly and user ids are
       * self-reported through the end-user header.
       */
      issuer?: AuthConfig;
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

export const ENDPOINT_API_STYLES = ["responses", "transcription"] as const;
export type EndpointApiStyle = (typeof ENDPOINT_API_STYLES)[number];

/** The Worker only composes OpenAI and xAI request shapes for named endpoints. */
export const ENDPOINT_PROVIDERS = ["openai", "xai"] as const;
export type EndpointProvider = (typeof ENDPOINT_PROVIDERS)[number];

export const ENDPOINT_SLUG = /^[a-z0-9-]{1,64}$/;

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
  endpoints?: EndpointsConfig;
}

/** The issuer block, which api_key apps only have once an operator enables one. */
export const authIssuer = (auth: AuthenticationConfig): AuthConfig | undefined => auth.issuer;

/** A fresh issuer block, matching the defaults the Worker applies. */
export function emptyIssuer(): AuthConfig {
  return { jwks_url: "", user_id_claim: "sub", required_claims: [], max_token_lifetime_seconds: 86400 };
}

/**
 * Replaces the issuer block. Clearing it on an api_key app removes the key
 * entirely rather than storing an empty object, which the Worker would reject.
 * App Attest apps must have one, so clearing there keeps what is configured
 * rather than blanking it.
 */
export function withIssuer(
  auth: AuthenticationConfig,
  issuer: AuthConfig | undefined,
): AuthenticationConfig {
  if (auth.type === "apple_app_attest") {
    return { ...auth, issuer: issuer ?? auth.issuer ?? emptyIssuer() };
  }
  if (!issuer) {
    const { issuer: _removed, ...rest } = auth;
    return rest;
  }
  return { ...auth, issuer };
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

export function emptyEndpoint(): EndpointConfig {
  return { api_style: "responses", provider: "openai", model: "" };
}

/** Suggests an unused slug so adding a second endpoint never silently replaces one. */
export function nextEndpointSlug(endpoints: EndpointsConfig, base = "endpoint"): string {
  if (endpoints[base] === undefined) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const slug = `${base}-${suffix}`;
    if (endpoints[slug] === undefined) return slug;
  }
  return `${base}-${Date.now()}`;
}

/** Renames a slug in place so the operator's card order does not jump around. */
export function renameEndpoint(
  endpoints: EndpointsConfig,
  from: string,
  to: string,
): EndpointsConfig {
  return Object.fromEntries(
    Object.entries(endpoints).map(([slug, endpoint]) => [slug === from ? to : slug, endpoint]),
  );
}

export function endpointSlugError(slug: string, endpoints: EndpointsConfig, self: string): string | null {
  if (!ENDPOINT_SLUG.test(slug)) return "Use 1-64 characters from a-z, 0-9, and -";
  if (slug !== self && endpoints[slug] !== undefined) return "Another endpoint already uses this slug";
  return null;
}

export function providerMode(proxy: ProxyConfig): "all" | "selected" {
  return proxy.providers.mode;
}

export function enabledProviders(proxy: ProxyConfig): Provider[] {
  return providerMode(proxy) === "all"
    ? [...PROVIDERS]
    : PROVIDERS.filter((provider) => proxy.providers.selected?.[provider] !== undefined);
}
