/** Mirrors the shapes `src/core/config.ts` parses on the Worker side. */

import {
  ENDPOINT_PROVIDER_TYPES,
  OUTPUT_CLAMP_STYLES,
  PROVIDER_TYPES,
  providersForEndpointStyle,
  type EndpointApiStyle,
  type EndpointProvider,
  type OutputClampStyle,
  type ProviderType,
} from "@shared/capabilities";

// The capability facts come from `src/shared/capabilities.ts`, which the Worker
// enforces from the same tables. What stays here is presentation — labels, form
// copy, draft shapes — and the config structures the console edits.
export {
  ENDPOINT_API_STYLES,
  reportsCost,
  type EndpointApiStyle,
} from "@shared/capabilities";

export const PROVIDERS = PROVIDER_TYPES;
export type Provider = ProviderType;

export const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  xai: "xAI",
  gemini: "Gemini",
  perplexity: "Perplexity",
  deepseek: "DeepSeek",
  groq: "Groq",
  mistral: "Mistral",
  together: "Together AI",
  fireworks: "Fireworks AI",
  cerebras: "Cerebras",
  moonshot: "Moonshot AI",
  huggingface: "Hugging Face",
  baseten: "Baseten",
  bytedance: "ByteDance Ark",
  openrouter: "OpenRouter",
};

/** Display names for every gateway type the API can return. */
export const GATEWAY_TYPE_LABELS = {
  cf_aig: "Cloudflare AI Gateway",
  vercel: "Vercel AI Gateway",
} as const;

/**
 * Gateway types this console offers to create, and the fields each one asks
 * for. A type appears here only once the Worker has an adapter that can serve
 * it, so the list is what makes adding one a data change rather than a rewrite.
 */
export const CREATABLE_GATEWAY_TYPES = [
  {
    value: "cf_aig",
    label: GATEWAY_TYPE_LABELS.cf_aig,
    defaultName: "Our CF gateway",
    tokenDocsUrl: "https://developers.cloudflare.com/ai-gateway/configuration/authentication/",
    /**
     * Non-secret connection fields this gateway needs before a token means
     * anything. Cloudflare's URL is built from the account and gateway pair.
     */
    needsCloudflareIds: true,
    credentialNote:
      "Requests use the provider keys stored in your Cloudflare AI Gateway's own key store.",
  },
  {
    value: "vercel",
    label: GATEWAY_TYPE_LABELS.vercel,
    defaultName: "Our Vercel gateway",
    tokenDocsUrl: "https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys",
    // The origin is fixed in adapter code and the token identifies the Vercel
    // team, so there is nothing else to ask for.
    needsCloudflareIds: false,
    // Deliberately not "using your key": Vercel documents BYOK as preferred,
    // with a fallback to its own system credentials when a stored key fails.
    credentialNote:
      "Your provider credential stored in Vercel is preferred. Vercel may fall back to system credentials.",
  },
] as const;

export type CreatableGatewayType = (typeof CREATABLE_GATEWAY_TYPES)[number]["value"];

export const CLAMP_STYLES = OUTPUT_CLAMP_STYLES;
export type ClampStyle = OutputClampStyle;

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

/**
 * A provider row as policy authoring sees it. The slug — not the type — is what
 * app configuration names, because an organization may run several instances of
 * one provider type.
 */
export interface ProviderInstance {
  slug: string;
  type: Provider;
  name: string;
  /**
   * Per-model price overrides. A model priced only here is still usable — but
   * through this instance alone, which is why model pickers are per slug.
   */
  pricing?: Record<string, unknown> | null;
  /**
   * Optional because most callers describe an instance without caring. A
   * `disabled` row is still selectable — configuration may name it, and the
   * server accepts that — so pickers mark it rather than hide it.
   */
  status?: "active" | "disabled";
}

/**
 * The models an instance can be asked for: its type's catalog first, then the
 * ones only it prices. The gateway rejects any model it cannot price, and
 * accepts these, so the picker offers exactly that set.
 */
export function instanceModels(
  instance: ProviderInstance,
  catalog: Partial<Record<Provider, Record<string, unknown>>> | undefined,
): string[] {
  const priced = Object.keys(catalog?.[instance.type] ?? {});
  const overrides = Object.keys(instance.pricing ?? {});
  return [...priced, ...overrides.filter((model) => !priced.includes(model))];
}

export interface ProxyConfig {
  providers: {
    mode: "all" | "selected";
    /** Keyed by provider instance slug, matching `/proxy/{slug}/…`. */
    selected?: Partial<Record<string, ProviderConfig>>;
  };
  model_rewrites?: Record<string, string>;
}

/**
 * The provider types whose native request shapes the Worker composes for named
 * endpoints, and which styles each one covers — read straight off the shared
 * capability matrix rather than restated here.
 */
export const ENDPOINT_PROVIDERS = ENDPOINT_PROVIDER_TYPES;
export type { EndpointProvider };
export const endpointProviderTypes = providersForEndpointStyle;

/**
 * The instances a named endpoint of this style may target. The provider type
 * decides which request shapes the gateway composes at all; the instance's
 * *route* decides whether the upstream serves them — Vercel has no transcription
 * API, so a Vercel-routed OpenAI row cannot back a transcription endpoint. Pass
 * `serves` to apply the second half; without it only the type is checked.
 */
export function endpointInstances<T extends ProviderInstance>(
  style: EndpointApiStyle,
  instances: T[],
  serves?: (instance: T, style: EndpointApiStyle) => boolean,
): T[] {
  const eligible: readonly Provider[] = endpointProviderTypes(style);
  return instances.filter((instance) =>
    eligible.includes(instance.type) && (serves?.(instance, style) ?? true)
  );
}

export const ENDPOINT_SLUG = /^[a-z0-9-]{1,64}$/;

export interface EndpointTarget {
  /** A provider instance slug, resolved by the Worker against the organization. */
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
  authentication: AuthenticationConfig;
  routing: ProxyConfig;
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

export function emptyEndpoint(provider = "openai"): EndpointConfig {
  return { api_style: "responses", provider, model: "" };
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

/** The instance slugs an app allows; empty in `all` mode, which names none. */
export function selectedSlugs(proxy: ProxyConfig): string[] {
  if (providerMode(proxy) === "all") return [];
  const selected = proxy.providers.selected ?? {};
  // A draft records a switched-off instance as an undefined value, which the
  // save drops; it is not an allowed provider in the meantime.
  return Object.keys(selected).filter((slug) => selected[slug] !== undefined);
}

export function isProviderType(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Whether a string names a gateway type this console can describe. Read off the
 * label table, whose key set is what makes a type displayable at all.
 */
export function isGatewayType(value: string): value is keyof typeof GATEWAY_TYPE_LABELS {
  return Object.hasOwn(GATEWAY_TYPE_LABELS, value);
}

/**
 * The provider *types* an app can reach, resolved through the organization's
 * instances: policy names slugs, but pricing, labels and "is this configured?"
 * are all properties of the type.
 *
 * A slug with no instance still names a type when it *is* a type name — the
 * gateway reserves those slugs for their own provider — which is how an app
 * that allows `openai` before any OpenAI key exists still reports the gap.
 */
export function enabledProviders(proxy: ProxyConfig, instances: ProviderInstance[]): Provider[] {
  if (providerMode(proxy) === "all") return [...PROVIDERS];
  const typeBySlug = new Map(instances.map((instance) => [instance.slug, instance.type]));
  const enabled = new Set(
    selectedSlugs(proxy).flatMap((slug) => {
      const type = typeBySlug.get(slug);
      if (type) return [type];
      return isProviderType(slug) ? [slug] : [];
    }),
  );
  return PROVIDERS.filter((provider) => enabled.has(provider));
}
