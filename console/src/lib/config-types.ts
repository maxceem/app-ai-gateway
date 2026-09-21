/**
 * The console's own view of an application configuration.
 *
 * The wire shapes are not restated here: they come from `@shared/app-config`,
 * which is the one grammar the Worker parses with and the console now runs
 * directly. What this file adds is the *draft* — the partially filled, named
 * intermediate states a form passes through and a saved configuration has no
 * vocabulary for — plus the labels and copy that go around them.
 */

import {
  OUTPUT_CLAMP_STYLES,
  type EndpointApiStyle,
  type OutputClampStyle,
} from "@shared/capabilities";
import {
  ENDPOINT_PROVIDER_TYPES,
  PROVIDER_TYPES,
  providersForEndpointStyle,
  type EndpointProvider,
  type ProviderType,
} from "@shared/providers";
import {
  ENDPOINT_SLUG,
  type AppAttestEnvironment,
  type AppConfigInput,
  type AuthenticationConfigInput,
  type ClaimRequirement,
  type EndpointConfig,
  type EndpointsConfig,
  type EntitlementCheck,
  type IssuerAuthenticationInput,
  type IssuerProvider,
  type LimitScopeConfig,
  type LimitsConfig,
  type ProviderPolicy,
  type RoutingConfig,
} from "@shared/app-config";

export { DEFAULT_END_USER_HEADER, ENDPOINT_SLUG } from "@shared/app-config";
export type {
  AppAttestEnvironment,
  ClaimRequirement,
  EndpointConfig,
  EndpointsConfig,
  EntitlementCheck,
  IssuerProvider,
  LimitScopeConfig,
  LimitsConfig,
};

// The capability facts come from `src/shared/capabilities.ts` and
// `src/shared/providers.ts`, which the Worker enforces from the same tables.
// What stays here is presentation — labels, form copy, draft shapes — and the
// config structures the console edits.
export {
  ENDPOINT_API_STYLES,
  type EndpointApiStyle,
} from "@shared/capabilities";
export { reportsCost } from "@shared/providers";

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

/**
 * Incomplete issuer state while the form is being edited. Built on the schema's
 * *input* type, because a half-typed form is exactly a body that has not been
 * parsed yet — and a saved one round-trips through it unchanged.
 */
export type IssuerDraft = Partial<IssuerAuthenticationInput>;
/** Stable compatibility name for existing form components. */
export type AuthConfig = IssuerDraft;

export type HeaderEndUserDraft = { source: "header"; header: string };
export type IssuerEndUserDraft = { source: "issuer"; issuer: IssuerDraft };
export type AppInstallEndUserDraft = { source: "app_install" };
export type ApiKeyEndUserDraft = HeaderEndUserDraft | IssuerEndUserDraft;
export type AppAttestEndUserDraft = IssuerEndUserDraft | AppInstallEndUserDraft;
export type EndUserIdentity = ApiKeyEndUserDraft | AppAttestEndUserDraft;

export type AuthenticationDraft =
  | (Omit<Extract<AuthenticationConfigInput, { type: "apple_app_attest" }>, "end_user"> & {
      end_user: AppAttestEndUserDraft;
    })
  | (Omit<Extract<AuthenticationConfigInput, { type: "api_key" }>, "end_user"> & {
      end_user?: ApiKeyEndUserDraft;
    });

/** A limits block as the form holds it: either scope may not have been written yet. */
export type LimitsDraft = NonNullable<AppConfigInput["limits"]>;

/** No limit of any kind, which is what an unwritten scope means. */
export const UNLIMITED_SCOPE: LimitScopeConfig = {
  requests: { per_minute: null, per_day: null },
  spending: { monthly_usd: null },
};

/** A draft's limits with both scopes present, which is what every form field reads. */
export const draftLimits = (limits: LimitsDraft | undefined): LimitsConfig => ({
  per_user: limits?.per_user ?? UNLIMITED_SCOPE,
  per_app: limits?.per_app ?? UNLIMITED_SCOPE,
});

export type AllowedPath = ProviderPolicy["allowed_paths"][number];
export type AllowedPathObject = Exclude<AllowedPath, string>;
export type EndpointTarget = Pick<EndpointConfig, "provider" | "model">;

export interface ProviderConfig extends Partial<ProviderPolicy> {
  /** Missing or empty allows the default inference APIs; a non-empty list replaces that default. */
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

/**
 * The routing block as the form holds it: one flat object rather than the
 * saved discriminated union, because the mode toggle and the per-instance
 * policies are edited independently and a half-edited draft has to be able to
 * carry both. `normalizeAppConfigDraft` is where it becomes the union again.
 */
export interface ProxyConfig {
  providers: {
    mode: RoutingConfig["providers"]["mode"];
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

/**
 * The explicitly incomplete shape edited by the structured form.
 *
 * Built on the schema's *input* type rather than its output: a form holds a
 * configuration on its way to being one, so everything the schema defaults —
 * `limits`, `endpoints`, the App Attest environments — is still optional here,
 * and a saved configuration is simply an input that needs nothing filled in.
 */
export interface AppConfigDraft extends Omit<AppConfigInput, "authentication" | "routing"> {
  authentication: AuthenticationDraft;
  routing: ProxyConfig;
}
/** The issuer block, which api_key apps only have once an operator enables one. */
export const authIssuer = (auth: AuthenticationDraft): AuthConfig | undefined =>
  auth.end_user?.source === "issuer" ? auth.end_user.issuer : undefined;

/** The end-user source an application uses, or `undefined` when it has none. */
export const endUserSource = (
  auth: AuthenticationDraft,
): EndUserIdentity["source"] | undefined => auth.end_user?.source;

/**
 * A fresh issuer block, matching the defaults the Worker applies. Firebase is
 * the provider it opens on, as the creation wizard does.
 */
export function emptyIssuer(): AuthConfig {
  return {
    provider: "firebase",
    jwks_url: "",
    issuer: "",
    audience: "",
    user_id_claim: "sub",
    required_claims: [],
    max_token_lifetime_seconds: 86400,
  };
}

/**
 * Replaces the issuer block, leaving the rest of the application alone. Clearing
 * it on an api_key app drops `end_user` entirely — the application then has no
 * end users, which is a position the config can state. An App Attest app always
 * resolves to some user, so clearing there keeps what is configured rather than
 * leaving it with nothing to identify anyone by.
 */
export function withIssuer(
  auth: AuthenticationDraft,
  issuer: AuthConfig | undefined,
): AuthenticationDraft {
  if (auth.type === "apple_app_attest") {
    return { ...auth, end_user: { source: "issuer", issuer: issuer ?? authIssuer(auth) ?? emptyIssuer() } };
  }
  if (!issuer) {
    const { end_user: _removed, ...rest } = auth;
    return rest;
  }
  return { ...auth, end_user: { source: "issuer", issuer } };
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
