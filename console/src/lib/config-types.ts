/**
 * The console's own view of an application configuration.
 *
 * The wire shapes are not restated here: they come from `@shared/app-config`,
 * which is the one grammar the Worker parses with and the console runs
 * directly. What this file adds is the *draft* — the names the forms give the
 * schema's own input shapes, which a half-filled form is simply an unparsed
 * instance of — plus the labels and copy that go around them.
 */

import type { EndpointApiStyle } from "@shared/capabilities";
import {
  PROVIDER_TYPES,
  isProviderType,
  providerDescriptor,
  type ProviderType,
} from "@shared/providers";
import { gatewayDescriptor, type GatewayType } from "@shared/gateways";
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
} from "@shared/app-config";
import { unlimitedScope } from "@shared/app-defaults";

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
  ProviderPolicy,
};

// The capability facts come from `src/shared/capabilities.ts`,
// `src/shared/providers.ts` and `src/shared/gateways.ts`, which the Worker
// enforces from the same tables.
// What stays here is presentation — labels, form copy, draft shapes — and the
// config structures the console edits.
export {
  ENDPOINT_API_STYLES,
  type EndpointApiStyle,
} from "@shared/capabilities";
export { reportsCost } from "@shared/providers";
export { isGatewayType } from "@shared/gateways";

export type Provider = ProviderType;

/** A provider type's display name, from its own descriptor. */
export function providerLabel(type: Provider): string {
  return providerDescriptor(type).label;
}

/** A gateway type's display name, from its own descriptor. */
export function gatewayLabel(type: GatewayType): string {
  return gatewayDescriptor(type).label;
}

/**
 * The issuer block as the form holds it: the schema's own input. A half-typed
 * form is empty strings rather than absent keys — {@link emptyIssuer} is its
 * zero — so every field a reader needs is there to read. The two labels,
 * `provider` and `entitlement`, stay optional: the schema takes only a name it
 * knows, so "no provider named" and "no paid check" are said by leaving them out.
 */
export type IssuerDraft = IssuerAuthenticationInput;

/** The authentication block as the form holds it, which is the schema's input unchanged. */
export type AuthenticationDraft = AuthenticationConfigInput;

export type EndUserIdentity = AuthenticationDraft["end_user"];

/** A limits block as the form holds it: either scope may not have been written yet. */
export type LimitsDraft = NonNullable<AppConfigInput["limits"]>;

/** A draft's limits with both scopes present, which is what every form field reads. */
export const draftLimits = (limits: LimitsDraft | undefined): LimitsConfig => ({
  per_user: limits?.per_user ?? unlimitedScope(),
  per_app: limits?.per_app ?? unlimitedScope(),
});

export type AllowedPath = ProviderPolicy["allowed_paths"][number];
export type AllowedPathObject = Exclude<AllowedPath, string>;
export type EndpointTarget = Pick<EndpointConfig, "provider" | "model">;

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
 * The routing block as the form holds it: the schema's own union, so all-mode
 * names no selection and every selected instance has a whole policy. A policy
 * switched off is gone from the draft; the Proxy tab remembers it, not the
 * configuration.
 */
export type ProxyConfig = AppConfigInput["routing"];

/**
 * The instances a named endpoint of this style may target: the ones whose own
 * route serves it, as the gateway reports on each instance. The provider type
 * and the route are both already in that answer — only OpenAI and xAI compose
 * these request shapes, and Vercel serves no transcription API — so nothing is
 * judged here that the server has not.
 */
export function endpointInstances<T extends { capability: { endpointStyles: readonly EndpointApiStyle[] } }>(
  style: EndpointApiStyle,
  instances: T[],
): T[] {
  return instances.filter((instance) => instance.capability.endpointStyles.includes(style));
}

/**
 * The shape edited by the structured form: the schema's *input* type rather
 * than its output. A form holds a configuration on its way to being one, so
 * everything the schema defaults — `limits`, `endpoints`, the App Attest
 * environments — is still optional here, and a saved configuration is simply
 * an input that needs nothing filled in.
 */
export type AppConfigDraft = AppConfigInput;

/** The issuer block, which an application only has while `issuer` is its source. */
export const authIssuer = (auth: AuthenticationDraft): IssuerDraft | undefined =>
  auth.end_user.source === "issuer" ? auth.end_user.issuer : undefined;

/** The end-user source an application uses, `none` included. */
export const endUserSource = (auth: AuthenticationDraft): EndUserIdentity["source"] =>
  auth.end_user.source;

/**
 * A fresh issuer block, matching the defaults the Worker applies. Firebase is
 * the provider it opens on, as the creation wizard does.
 */
export function emptyIssuer(): IssuerDraft {
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

/** Makes the issuer the end-user source, with this block, leaving the rest of the application alone. */
export function withIssuer(auth: AuthenticationDraft, issuer: IssuerDraft): AuthenticationDraft {
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
  return proxy.providers.mode === "all" ? [] : Object.keys(proxy.providers.selected);
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
  if (providerMode(proxy) === "all") return [...PROVIDER_TYPES];
  const typeBySlug = new Map(instances.map((instance) => [instance.slug, instance.type]));
  const enabled = new Set(
    selectedSlugs(proxy).flatMap((slug) => {
      const type = typeBySlug.get(slug);
      if (type) return [type];
      return isProviderType(slug) ? [slug] : [];
    }),
  );
  return PROVIDER_TYPES.filter((provider) => enabled.has(provider));
}
