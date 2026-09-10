import { eq } from "drizzle-orm";
import { database } from "../db";
import { app } from "../db/schema";
import { supportsEndpointStyle } from "./capabilities";
import { GatewayError } from "./errors";
import type { OrganizationProviders } from "./provider-store";
import { emptyRecord, lookup, recordFromEntries } from "./records";
import {
  ENDPOINT_API_STYLES,
  PROVIDER_REGISTRY,
  PROVIDER_TYPES,
  PROVIDER_SLUG_PATTERN,
} from "./providers";
import { hasModelPrice, isBillable } from "./usage";
import type {
  AllowedPath,
  ApiKeyAuthentication,
  ApiKeyEndUser,
  AppAttestEndUser,
  AppAttestEnvironment,
  AppConfig,
  AuthenticationConfig,
  ClaimRequirement,
  EndpointApiStyle,
  EndpointConfig,
  EndpointsConfig,
  EndpointTarget,
  IssuerAuthConfig,
  LimitsConfig,
  LimitScopeConfig,
  ResolvedLimitScope,
  ResolvedLimitsConfig,
  OutputClampStyle,
  ProviderProxyConfig,
  ResolvedRoutingConfig,
  RoutingConfig,
  StoredAppConfig,
  StoredAuthenticationConfig,
} from "./types";

const APP_ATTEST_ENVIRONMENTS: AppAttestEnvironment[] = ["production", "development"];

interface CacheEntry {
  expiresAt: number;
  value: AppConfig;
}

const appCache = new Map<string, CacheEntry>();
const CLAMP_STYLES: OutputClampStyle[] = [
  "responses",
  "chat_completions",
  "gemini_native",
  "anthropic",
  "none",
];
const CONFIG_CACHE_TTL_MS = 60_000;
const WELL_KNOWN_PROVIDER_INSTANCES: OrganizationProviders = recordFromEntries(
  PROVIDER_TYPES.map((type) => [
    type,
    { id: type, slug: type, type, route: "direct" as const, pricing: null, status: "active" as const },
  ] as const),
);
const NO_GRANDFATHERED_SLUGS: ReadonlySet<string> = new Set();

/**
 * What a write may reference. `instances` are the organization's active provider
 * rows; `grandfathered` are slugs the *stored* configuration already names, kept
 * writable so deleting a provider does not brick every later edit of an app that
 * mentions it. Requests for a slug with no instance still fail at proxy time
 * with `provider_not_configured`.
 */
interface ProviderScope {
  instances: OrganizationProviders;
  grandfathered: ReadonlySet<string>;
}
export const ENDPOINT_SLUG = /^[a-z0-9-]{1,64}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError(500, "internal_error", `Invalid ${label} configuration`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GatewayError(500, "internal_error", `${label} must be a non-empty string`);
  }
  return value;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new GatewayError(500, "internal_error", `${label} must be a positive integer or null`);
  }
  return value;
}

function monthlyUsd(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new GatewayError(500, "internal_error", `${label} must be a non-negative number or null`);
  }
  const microusd = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(microusd)) {
    throw new GatewayError(500, "internal_error", `${label} is too large`);
  }
  return value;
}

function parseClaims(value: unknown): ClaimRequirement[] {
  if (!Array.isArray(value)) {
    throw new GatewayError(500, "internal_error", "authentication.issuer.required_claims must be an array");
  }
  return value.map((item) => {
    const requirement = record(item, "claim requirement");
    const path = requiredString(requirement.path, "Claim requirement path");
    const hasContains =
      typeof requirement.contains === "string" ||
      (Array.isArray(requirement.contains) &&
        requirement.contains.length > 0 &&
        requirement.contains.every((entry) => typeof entry === "string"));
    const hasEquals = ["string", "number", "boolean"].includes(typeof requirement.equals);
    if (hasContains === hasEquals) {
      throw new GatewayError(500, "internal_error", "Claim requirements need exactly one of contains or equals");
    }
    return {
      path,
      ...(hasContains ? { contains: requirement.contains as string | string[] } : {}),
      ...(hasEquals ? { equals: requirement.equals as string | number | boolean } : {}),
    };
  });
}

/**
 * A tenant-scoping claim, stored either as one value or as a list of accepted
 * alternatives, and always read back as a non-empty list.
 */
function parseClaimValues(value: unknown, label: string): string[] {
  if (typeof value === "string") return [requiredString(value, label)];
  if (!Array.isArray(value) || value.length === 0) {
    throw new GatewayError(500, "internal_error", `${label} must be a non-empty string or array of strings`);
  }
  return value.map((entry) => requiredString(entry, label));
}

function parseIssuer(raw: unknown): IssuerAuthConfig {
  const issuer = record(raw, "authentication.issuer");
  const jwksUrl = requiredString(issuer.jwks_url, "authentication.issuer.jwks_url");
  let jwks: URL;
  try {
    jwks = new URL(jwksUrl);
  } catch {
    throw new GatewayError(500, "internal_error", "authentication.issuer.jwks_url is invalid");
  }
  if (jwks.protocol !== "https:") {
    throw new GatewayError(500, "internal_error", "Issuer JWKS URLs must use HTTPS");
  }
  const userIdClaim = requiredString(issuer.user_id_claim, "authentication.issuer.user_id_claim");
  if (issuer.token_header !== undefined && (typeof issuer.token_header !== "string" || issuer.token_header.length === 0)) {
    throw new GatewayError(500, "internal_error", "authentication.issuer.token_header must be non-empty");
  }
  const maxLifetime = nullablePositiveInteger(
    issuer.max_token_lifetime_seconds,
    "authentication.issuer.max_token_lifetime_seconds",
  );
  if (maxLifetime === null) {
    throw new GatewayError(500, "internal_error", "authentication.issuer.max_token_lifetime_seconds cannot be null");
  }
  return {
    jwks_url: jwks.toString(),
    // Required on read as well as on write: an issuer block without them
    // accepts tokens from any tenant of a shared-JWKS provider, so a stored row
    // missing them is a broken configuration, not a lenient one.
    issuer: parseClaimValues(issuer.issuer, "authentication.issuer.issuer"),
    audience: parseClaimValues(issuer.audience, "authentication.issuer.audience"),
    user_id_claim: userIdClaim,
    ...(typeof issuer.token_header === "string" ? { token_header: issuer.token_header.toLowerCase() } : {}),
    required_claims: parseClaims(issuer.required_claims),
    max_token_lifetime_seconds: maxLifetime,
  };
}

function parseAuthentication(raw: unknown): {
  stored: StoredAuthenticationConfig;
  resolved: AuthenticationConfig;
} {
  const value = record(raw, "authentication");
  if (Object.hasOwn(value, "development_access")) {
    throw new GatewayError(
      500,
      "internal_error",
      "authentication.development_access is no longer supported",
    );
  }
  if (value.type === "api_key") {
    const apiKey: ApiKeyAuthentication = {
      type: "api_key",
      // Absent stays absent. It is the application saying it has no end users,
      // not a field waiting to be defaulted, so nothing is written in its place.
      ...(value.end_user === undefined
        ? {}
        : { end_user: parseApiKeyEndUser(value.end_user) }),
    };
    return { stored: apiKey, resolved: apiKey };
  }
  if (value.type !== "apple_app_attest") {
    throw new GatewayError(500, "internal_error", "authentication.type is invalid");
  }

  const appAttest = record(value.app_attest, "authentication.app_attest");

  const environments = parseAppAttestEnvironments(appAttest.environments);
  const common = {
    type: "apple_app_attest" as const,
    end_user: parseAppAttestEndUser(value.end_user),
    team_id: requiredString(appAttest.team_id, "authentication.app_attest.team_id"),
    bundle_id: requiredString(appAttest.bundle_id, "authentication.app_attest.bundle_id"),
  };
  return {
    stored: {
      type: common.type,
      end_user: common.end_user,
      app_attest: {
        team_id: common.team_id,
        bundle_id: common.bundle_id,
        // Only when the operator opted in, so an application that never named
        // the field is not rewritten to carry its own default.
        ...(appAttest.environments === undefined ? {} : { environments }),
      },
    },
    resolved: {
      type: common.type,
      end_user: common.end_user,
      app_attest: {
        team_id: common.team_id,
        bundle_id: common.bundle_id,
        environments,
      },
    },
  };
}

/**
 * Header names are compared case-insensitively, so one is stored lowercased and
 * every reader can compare it directly. The character set is HTTP's own: a name
 * outside it could never be sent, so accepting one would store a header the
 * application can never satisfy.
 */
const HTTP_FIELD_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;

/**
 * What the console offers when an operator turns on a header source, and the
 * name clients send by convention. Nothing requires it — the field is free — but
 * the proxy strips it on every route regardless, so a client that sends it out
 * of habit never leaks it upstream.
 */
export const DEFAULT_END_USER_HEADER = "x-end-user-id";

/**
 * Names an end-user header may not take, because the gateway already reads or
 * writes them: every credential header {@link extractGatewayToken} accepts, the
 * version header it records, and the two that describe the body itself.
 */
const RESERVED_END_USER_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  ...PROVIDER_TYPES.map((type) => PROVIDER_REGISTRY[type].auth.header.toLowerCase()),
  "x-app-version",
  "content-type",
  "content-length",
  "host",
]);

function parseEndUserHeader(value: unknown): string {
  const header = requiredString(value, "authentication.end_user.header").trim().toLowerCase();
  if (header.length > 64 || !HTTP_FIELD_NAME.test(header)) {
    throw new GatewayError(
      500,
      "internal_error",
      "authentication.end_user.header must be a valid HTTP header name",
    );
  }
  // A header the gateway already reads or sets cannot also carry a user id. The
  // damaging case is a credential header: `extractGatewayToken` accepts the
  // gateway token in `authorization` or in the provider's own auth header, so
  // naming one of those would read the caller's `agw_…` key as its user id and
  // then store and display it. The rest are refused for the same reason in a
  // milder form — one header, two meanings, and the gateway's wins.
  if (RESERVED_END_USER_HEADERS.has(header)) {
    throw new GatewayError(
      500,
      "internal_error",
      `authentication.end_user.header cannot be ${header}: the gateway already uses that header`,
    );
  }
  return header;
}

function parseApiKeyEndUser(raw: unknown): ApiKeyEndUser {
  const value = record(raw, "authentication.end_user");
  if (value.source === "header") {
    return { source: "header", header: parseEndUserHeader(value.header) };
  }
  if (value.source === "issuer") {
    return { source: "issuer", issuer: parseIssuer(value.issuer) };
  }
  throw new GatewayError(
    500,
    "internal_error",
    "authentication.end_user.source must be one of header, issuer",
  );
}

function parseAppAttestEndUser(raw: unknown): AppAttestEndUser {
  const value = record(raw, "authentication.end_user");
  if (value.source === "issuer") {
    return { source: "issuer", issuer: parseIssuer(value.issuer) };
  }
  if (value.source === "app_install") {
    return { source: "app_install" };
  }
  throw new GatewayError(
    500,
    "internal_error",
    "authentication.end_user.source must be one of issuer, app_install",
  );
}

/**
 * The issuer an application verifies end-user tokens against, or `undefined`
 * when it identifies users some other way or not at all. The one place that
 * knows where an issuer lives, so no caller has to reach through `end_user`
 * and re-check the source.
 */
export function endUserIssuer(
  authentication: AuthenticationConfig | StoredAuthenticationConfig,
): IssuerAuthConfig | undefined {
  const endUser = authentication.type === "api_key"
    ? authentication.end_user
    : authentication.end_user;
  return endUser?.source === "issuer" ? endUser.issuer : undefined;
}

/**
 * The header an application reads its end-user id from, or `undefined` when it
 * does not use one. Also what the proxy strips before forwarding: a header the
 * gateway consumes is never any provider's business.
 */
export function endUserHeader(
  authentication: AuthenticationConfig | StoredAuthenticationConfig,
): string | undefined {
  if (authentication.type !== "api_key") return undefined;
  return authentication.end_user?.source === "header"
    ? authentication.end_user.header
    : undefined;
}

/** Whether an application identifies end users at all. */
export function identifiesEndUsers(
  authentication: AuthenticationConfig | StoredAuthenticationConfig,
): boolean {
  return authentication.type !== "api_key" || authentication.end_user !== undefined;
}

/**
 * Defaulted here rather than in the contract schema because the schema's output
 * is what gets persisted: a `z.default()` would write the field into every
 * application's stored configuration on any unrelated edit.
 */
function parseAppAttestEnvironments(value: unknown): AppAttestEnvironment[] {
  if (value === undefined) return ["production"];
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((environment) => !APP_ATTEST_ENVIRONMENTS.includes(environment as AppAttestEnvironment))
    || new Set(value).size !== value.length
  ) {
    throw new GatewayError(500, "internal_error", "authentication.app_attest.environments is invalid");
  }
  return value as AppAttestEnvironment[];
}

function allowedPaths(value: unknown, label: string): AllowedPath[] {
  if (!Array.isArray(value)) throw new GatewayError(500, "internal_error", `${label} must be an array`);
  return value.map((item, index) => {
    if (typeof item === "string" && item.length > 0) return item;
    const path = record(item, `${label}[${index}]`);
    const pathname = requiredString(path.path, `${label}[${index}].path`);
    if (path.fixed_model !== undefined && (typeof path.fixed_model !== "string" || path.fixed_model.length === 0)) {
      throw new GatewayError(500, "internal_error", `${label}[${index}].fixed_model is invalid`);
    }
    if (path.clamp !== undefined && !CLAMP_STYLES.includes(path.clamp as OutputClampStyle)) {
      throw new GatewayError(500, "internal_error", `${label}[${index}].clamp is invalid`);
    }
    return {
      path: pathname,
      ...(typeof path.fixed_model === "string" ? { fixed_model: path.fixed_model } : {}),
      ...(typeof path.clamp === "string" ? { clamp: path.clamp as OutputClampStyle } : {}),
    };
  });
}

function parseProvider(raw: unknown, provider: string): ProviderProxyConfig {
  const value = record(raw, `routing provider ${provider}`);
  const allowedModels = value.allowed_models ?? [];
  if (
    !Array.isArray(allowedModels)
    || allowedModels.some((model) => typeof model !== "string" || model.length === 0)
  ) {
    throw new GatewayError(500, "internal_error", `${provider}.allowed_models must be a string array`);
  }
  const result: ProviderProxyConfig = {
    allowed_paths: allowedPaths(value.allowed_paths ?? [], `${provider}.allowed_paths`),
    allowed_models: allowedModels as string[],
  };
  if (value.max_output_tokens !== undefined) {
    const maximum = nullablePositiveInteger(value.max_output_tokens, `${provider}.max_output_tokens`);
    if (maximum === null) throw new GatewayError(500, "internal_error", `${provider}.max_output_tokens cannot be null`);
    result.max_output_tokens = maximum;
  }
  return result;
}

function validateRoutingPrices(
  selected: Record<string, ProviderProxyConfig>,
  modelRewrites: Record<string, string>,
  scope: ProviderScope,
): void {
  const providers = scope.instances;
  // A rewrite target is a model name, not an instance reference, so it is
  // judged against the superset the organization could ever reach: the shipped
  // catalog for every provider type, plus what any of its own instances can
  // bill. An organization with no providers yet must still be able to save an
  // app.
  //
  // The catalog arm stays a price check on purpose. Billability is per instance,
  // and asking it of every provider type would answer yes to any string at all
  // the moment one cost-reporting type exists — turning a typo-catching save
  // check into no check. The instance arm is where reported cost belongs: an
  // organization that really runs an OpenRouter row can rewrite to its slugs,
  // and one that does not still gets its typos caught.
  for (const [source, target] of Object.entries(modelRewrites)) {
    const priced = PROVIDER_TYPES.some((type) => hasModelPrice(type, target, null))
      || Object.values(providers).some((provider) =>
        isBillable(provider.type, target, provider.pricing)
      );
    if (!priced) {
      throw new GatewayError(
        500,
        "internal_error",
        `routing.model_rewrites.${source} targets model ${target}, which has no configured price`,
      );
    }
  }

  for (const [slug, config] of Object.entries(selected)) {
    const provider = lookup(providers, slug);
    if (!provider) {
      if (!scope.grandfathered.has(slug)) {
        throw new GatewayError(500, "internal_error", `Unknown provider instance ${slug}`);
      }
      // No instance to price against; the policy survives untouched.
      continue;
    }
    const configuredModels = [
      ...config.allowed_models.map((model) => ({ model, label: `${slug}.allowed_models` })),
      ...config.allowed_paths.flatMap((entry, index) => {
        if (typeof entry === "string" || entry.fixed_model === undefined) return [];
        return [{ model: entry.fixed_model, label: `${slug}.allowed_paths[${index}].fixed_model` }];
      }),
    ];
    for (const configured of configuredModels) {
      const resolved = lookup(modelRewrites, configured.model) ?? configured.model;
      // The same gate a request faces, so configuration and runtime cannot
      // disagree: a local price, or a route that reports what it charged. An
      // OpenRouter row's slugs have no catalog entry by design, and restricting
      // an app to them must not be refused for a price the proxy never asks for.
      if (!isBillable(provider.type, resolved, provider.pricing)) {
        throw new GatewayError(
          500,
          "internal_error",
          `${configured.label} resolves ${configured.model} to ${resolved}, which has no configured price`,
        );
      }
    }
  }
}

function parseRouting(
  raw: unknown,
  scope: ProviderScope | null,
): { stored: RoutingConfig; resolved: ResolvedRoutingConfig } {
  const value = record(raw, "routing");
  const providers = record(value.providers, "routing.providers");
  if (providers.mode !== "all" && providers.mode !== "selected") {
    throw new GatewayError(500, "internal_error", "routing.providers.mode must be all or selected");
  }
  const selected = emptyRecord<ProviderProxyConfig>();
  if (providers.mode === "all") {
    if (providers.selected !== undefined) {
      throw new GatewayError(500, "internal_error", "routing.providers.selected must be omitted in all mode");
    }
  } else {
    const selectedRaw = record(providers.selected, "routing.providers.selected");
    for (const [slug, policy] of Object.entries(selectedRaw)) {
      if (!PROVIDER_SLUG_PATTERN.test(slug)) {
        throw new GatewayError(500, "internal_error", `Invalid provider instance slug ${slug}`);
      }
      selected[slug] = parseProvider(policy, slug);
    }
  }
  const rewrites = record(value.model_rewrites, "routing.model_rewrites");
  const modelRewrites = emptyRecord<string>();
  for (const [source, target] of Object.entries(rewrites)) {
    modelRewrites[source] = requiredString(target, `routing.model_rewrites.${source}`);
  }
  if (scope) validateRoutingPrices(selected, modelRewrites, scope);
  return {
    stored: {
      providers: {
        mode: providers.mode,
        ...(providers.mode === "selected" ? { selected } : {}),
      },
      model_rewrites: modelRewrites,
    },
    resolved: { providerMode: providers.mode, providers: selected, modelRewrites },
  };
}

function parseEndpointTarget(
  raw: unknown,
  label: string,
  apiStyle: EndpointApiStyle,
  scope: ProviderScope | null,
): EndpointTarget {
  const value = record(raw, label);
  const provider = requiredString(value.provider, `${label}.provider`);
  if (!PROVIDER_SLUG_PATTERN.test(provider)) {
    throw new GatewayError(500, "internal_error", `${label}.provider is not a valid slug`);
  }
  const instance = lookup(scope?.instances, provider);
  if (scope && !instance && !scope.grandfathered.has(provider)) {
    throw new GatewayError(500, "internal_error", `${label}.provider ${provider} is not configured`);
  }
  // Route-aware: a gateway may carry fewer of a provider's operations than the
  // provider itself has, so which instance this is matters as much as its type.
  //
  // A `null` route is a row attached to a gateway type this deployment has no
  // adapter for. Nothing can be said about what it would carry, so it is
  // refused here rather than accepted and then answered with a 502 on the first
  // request — an error at save time names the row an operator can go and fix.
  if (instance) {
    if (instance.route === null) {
      throw new GatewayError(
        500,
        "internal_error",
        `${label}.provider ${provider} is routed through a provider gateway this deployment has no adapter for, so it cannot serve ${apiStyle} endpoints`,
      );
    }
    if (!supportsEndpointStyle(instance.route, instance.type, apiStyle)) {
      throw new GatewayError(
        500,
        "internal_error",
        instance.route === "direct"
          ? `${label}.provider ${provider} is a ${instance.type} instance, which does not support ${apiStyle}`
          : `${label}.provider ${provider} is a ${instance.type} instance routed through a ${instance.route} gateway, which does not support ${apiStyle}`,
      );
    }
  }
  const model = requiredString(value.model, `${label}.model`);
  // Billability, not price: the endpoint route runs the same check per request.
  if (instance && !isBillable(instance.type, model, instance.pricing)) {
    throw new GatewayError(
      500,
      "internal_error",
      `${label}.model ${model} has no configured price for ${String(provider)}`,
    );
  }
  return { provider, model };
}

function parseEndpoint(
  raw: unknown,
  label: string,
  scope: ProviderScope | null,
): EndpointConfig {
  const value = record(raw, label);
  if (!ENDPOINT_API_STYLES.includes(value.api_style as EndpointApiStyle)) {
    throw new GatewayError(
      500,
      "internal_error",
      `${label}.api_style must be one of ${ENDPOINT_API_STYLES.join(", ")}`,
    );
  }
  const apiStyle = value.api_style as EndpointApiStyle;
  const target = parseEndpointTarget(value, label, apiStyle, scope);
  const endpoint: EndpointConfig = {
    api_style: apiStyle,
    provider: target.provider,
    model: target.model,
  };
  if (value.params !== undefined) endpoint.params = record(value.params, `${label}.params`);
  if (value.max_output_tokens !== undefined) {
    const cap = nullablePositiveInteger(value.max_output_tokens, `${label}.max_output_tokens`);
    if (cap === null) {
      throw new GatewayError(500, "internal_error", `${label}.max_output_tokens cannot be null`);
    }
    endpoint.max_output_tokens = cap;
  }
  if (value.fallback !== undefined) {
    if (!Array.isArray(value.fallback)) {
      throw new GatewayError(500, "internal_error", `${label}.fallback must be an array`);
    }
    endpoint.fallback = value.fallback.map((item, index) =>
      parseEndpointTarget(item, `${label}.fallback[${index}]`, apiStyle, scope),
    );
  }
  return endpoint;
}

function parseEndpoints(raw: unknown, scope: ProviderScope | null): EndpointsConfig {
  if (raw === undefined) return emptyRecord<EndpointConfig>();
  const value = record(raw, "endpoints");
  const endpoints: EndpointsConfig = emptyRecord<EndpointConfig>();
  for (const [slug, definition] of Object.entries(value)) {
    if (!ENDPOINT_SLUG.test(slug)) {
      throw new GatewayError(
        500,
        "internal_error",
        `endpoints.${slug} is not a valid slug; use 1-64 characters from a-z, 0-9, and -`,
      );
    }
    endpoints[slug] = parseEndpoint(definition, `endpoints.${slug}`, scope);
  }
  return endpoints;
}

const UNLIMITED_SCOPE: ResolvedLimitScope = {
  requestsPerMinute: null,
  requestsPerDay: null,
  monthlyBudgetMicrousd: null,
};

function parseLimitScope(raw: unknown, label: string): { stored: LimitScopeConfig; resolved: ResolvedLimitScope } {
  const value = record(raw, label);
  const requests = record(value.requests, `${label}.requests`);
  const spending = record(value.spending, `${label}.spending`);
  const perMinute = nullablePositiveInteger(requests.per_minute, `${label}.requests.per_minute`);
  const perDay = nullablePositiveInteger(requests.per_day, `${label}.requests.per_day`);
  const usd = monthlyUsd(spending.monthly_usd, `${label}.spending.monthly_usd`);
  return {
    stored: {
      requests: { per_minute: perMinute, per_day: perDay },
      spending: { monthly_usd: usd },
    },
    resolved: {
      requestsPerMinute: perMinute,
      requestsPerDay: perDay,
      monthlyBudgetMicrousd: usd === null ? null : Math.round(usd * 1_000_000),
    },
  };
}

/**
 * The organization's limits on its own app's end users. Absent means unlimited,
 * the same way an absent `endpoints` block means the app has none, so an app
 * that never sets a limit stores nothing and is never rewritten to say so.
 */
function parseLimits(raw: unknown): { stored: LimitsConfig | undefined; resolved: ResolvedLimitsConfig } {
  if (raw === undefined) {
    return { stored: undefined, resolved: { perUser: UNLIMITED_SCOPE, perApp: UNLIMITED_SCOPE } };
  }
  const value = record(raw, "limits");
  const perUser = parseLimitScope(value.per_user, "limits.per_user");
  const perApp = parseLimitScope(value.per_app, "limits.per_app");
  return {
    stored: { per_user: perUser.stored, per_app: perApp.stored },
    resolved: { perUser: perUser.resolved, perApp: perApp.resolved },
  };
}

/**
 * Provider references and model pricing are validated when a configuration is
 * written. Reading stored configuration skips organization lookups so deleting
 * an instance later surfaces as provider_not_configured on the request that
 * needs it instead of making the entire app unparseable.
 */
export function parseStoredAppConfig(
  raw: unknown,
  organizationProviders: OrganizationProviders | null = null,
  grandfatheredSlugs: ReadonlySet<string> = NO_GRANDFATHERED_SLUGS,
): {
  stored: StoredAppConfig;
  resolved: Omit<AppConfig, "id" | "organizationId" | "name" | "status">;
} {
  const scope: ProviderScope | null = organizationProviders === null
    ? null
    : { instances: organizationProviders, grandfathered: grandfatheredSlugs };
  const value = record(raw, "app");
  const authentication = parseAuthentication(value.authentication);
  const routing = parseRouting(value.routing, scope);
  const endpoints = parseEndpoints(value.endpoints, scope);
  const limits = parseLimits(value.limits);
  // Two settings that cannot both mean what they say. An application with no
  // end users has nobody for a per-user limit to apply to, and the old
  // behaviour — quietly metering the whole application as one user — is exactly
  // the misreading this refuses to let anyone configure. `per_app` is the limit
  // that means something here, and the message says so.
  if (!identifiesEndUsers(authentication.resolved) && scopeHasLimits(limits.resolved.perUser)) {
    throw new GatewayError(
      500,
      "internal_error",
      "limits.per_user needs an authentication.end_user source: this application identifies no end users, so use limits.per_app",
    );
  }
  return {
    stored: {
      authentication: authentication.stored,
      routing: routing.stored,
      ...(limits.stored === undefined ? {} : { limits: limits.stored }),
      ...(value.endpoints === undefined ? {} : { endpoints }),
    },
    resolved: {
      authentication: authentication.resolved,
      routing: routing.resolved,
      limits: limits.resolved,
      endpoints,
    },
  };
}

function fromRow(row: typeof app.$inferSelect): AppConfig {
  const parsed = parseStoredAppConfig(row.config, null);
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    status: row.status,
    ...parsed.resolved,
  };
}

/**
 * Whether a scope sets any limit at all. The request path uses these to skip the
 * Durable Object entirely for an app that configures none, which is what keeps
 * the unlimited case as cheap as it was before the feature existed.
 */
const scopeHasLimits = (scope: ResolvedLimitScope): boolean =>
  scope.requestsPerMinute !== null
  || scope.requestsPerDay !== null
  || scope.monthlyBudgetMicrousd !== null;

export const hasAppLevelLimits = (app: AppConfig): boolean => scopeHasLimits(app.limits.perApp);

export const hasUserLevelLimits = (app: AppConfig): boolean => scopeHasLimits(app.limits.perUser);

export async function loadAppConfig(env: Env, appId: string): Promise<AppConfig> {
  const cached = appCache.get(appId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const row = await database(env.DB).query.app.findFirst({ where: eq(app.id, appId) });
  if (!row) throw new GatewayError(404, "app_not_found", "App is not registered");
  const value = fromRow(row);
  appCache.set(appId, { expiresAt: Date.now() + CONFIG_CACHE_TTL_MS, value });
  return value;
}

export function invalidateAppConfig(appId: string): void {
  appCache.delete(appId);
}

export function clearAppConfigCache(): void {
  appCache.clear();
}

export function validateAppConfigJson(
  config: unknown,
  organizationProviders: OrganizationProviders | null = WELL_KNOWN_PROVIDER_INSTANCES,
  grandfatheredSlugs: ReadonlySet<string> = NO_GRANDFATHERED_SLUGS,
): StoredAppConfig {
  return parseStoredAppConfig(config, organizationProviders, grandfatheredSlugs).stored;
}

/**
 * The provider slugs a stored configuration already names. An update may keep
 * referencing these even after the instance behind one is deleted, so removing a
 * provider never blocks unrelated edits to apps that mention it. An unparseable
 * stored configuration grandfathers nothing.
 */
export function referencedProviderSlugs(config: unknown): Set<string> {
  const slugs = new Set<string>();
  let stored: StoredAppConfig;
  try {
    stored = parseStoredAppConfig(config, null).stored;
  } catch {
    return slugs;
  }
  for (const slug of Object.keys(stored.routing.providers.selected ?? {})) slugs.add(slug);
  for (const endpoint of Object.values(stored.endpoints ?? {})) {
    slugs.add(endpoint.provider);
    for (const fallback of endpoint.fallback ?? []) slugs.add(fallback.provider);
  }
  return slugs;
}

export function assertAppActive(app: AppConfig): void {
  if (app.status !== "active") throw new GatewayError(403, "app_disabled", "App is disabled");
}
