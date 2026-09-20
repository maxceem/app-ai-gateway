import type {
  AppConfig as WireAppConfig,
  AppAttestEnvironment,
  AppAttestEndUser as WireAppAttestEndUser,
  ApiKeyEndUser as WireApiKeyEndUser,
  ClaimRequirement,
  EndpointConfig,
  EndpointsConfig,
  EntitlementCheck,
  IssuerAuthentication,
  IssuerProvider,
  LimitScopeConfig,
  LimitsConfig,
  ProviderPolicy,
  RoutingConfig as WireRoutingConfig,
} from "../contracts/schemas.ts";
import {
  ENDPOINT_API_STYLES,
  OUTPUT_CLAMP_STYLES,
  type OutputClampStyle,
} from "./capabilities.ts";
import { PROVIDER_CREDENTIAL_HEADERS } from "./provider-auth.ts";

export const ISSUER_PROVIDERS = ["firebase", "supabase", "auth0", "clerk", "custom"] as const;
export const ENTITLEMENT_CHECKS = ["revenuecat", "custom"] as const;
export const APP_ATTEST_ENVIRONMENTS = ["production", "development"] as const;
export const DEFAULT_END_USER_HEADER = "x-end-user-id";
export const ENDPOINT_SLUG = /^[a-z0-9-]{1,64}$/;
export const PROVIDER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const HTTP_FIELD_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export type {
  AppAttestEnvironment,
  ClaimRequirement,
  EndpointConfig,
  EndpointsConfig,
  EntitlementCheck,
  IssuerProvider,
  LimitScopeConfig,
  LimitsConfig,
  ProviderPolicy as ProviderProxyConfig,
};

export type IssuerAuthConfig = Omit<IssuerAuthentication, "issuer" | "audience"> & {
  issuer: string[];
  audience: string[];
};

type NormalizeIssuerEndUser<T> = T extends { source: "issuer" }
  ? Omit<T, "issuer"> & { issuer: IssuerAuthConfig }
  : T;

export type AppAttestEndUser = NormalizeIssuerEndUser<WireAppAttestEndUser>;
export type ApiKeyEndUser = NormalizeIssuerEndUser<WireApiKeyEndUser>;
export type EndUserIdentity = AppAttestEndUser | ApiKeyEndUser;
export type HeaderEndUser = Extract<ApiKeyEndUser, { source: "header" }>;
export type IssuerEndUser = Extract<ApiKeyEndUser, { source: "issuer" }>;
export type AppInstallEndUser = Extract<AppAttestEndUser, { source: "app_install" }>;

type WireAppleAuthentication = Extract<
  WireAppConfig["authentication"],
  { type: "apple_app_attest" }
>;
type WireApiKeyAuthentication = Extract<WireAppConfig["authentication"], { type: "api_key" }>;

export type StoredAppleAppAttestAuthentication = Omit<WireAppleAuthentication, "end_user"> & {
  end_user: AppAttestEndUser;
};

export type ApiKeyAuthentication = Omit<WireApiKeyAuthentication, "end_user"> & {
  end_user?: ApiKeyEndUser;
};

export type StoredAuthenticationConfig =
  | StoredAppleAppAttestAuthentication
  | ApiKeyAuthentication;

export type AppleAppAttestAuthentication = Omit<
  StoredAppleAppAttestAuthentication,
  "app_attest"
> & {
  app_attest: Omit<StoredAppleAppAttestAuthentication["app_attest"], "environments"> & {
    environments: AppAttestEnvironment[];
  };
};

export type AuthenticationConfig = AppleAppAttestAuthentication | ApiKeyAuthentication;

export type RoutingConfig = Omit<WireRoutingConfig, "providers"> & {
  providers: Omit<WireRoutingConfig["providers"], "selected"> & {
    selected?: Record<string, ProviderPolicy>;
  };
};

export interface StoredAppConfig extends Omit<WireAppConfig, "authentication" | "routing"> {
  authentication: StoredAuthenticationConfig;
  routing: RoutingConfig;
}

export interface ResolvedRoutingConfig {
  providerMode: "all" | "selected";
  providers: Record<string, ProviderPolicy>;
  modelRewrites: Record<string, string>;
}

export interface ResolvedLimitScope {
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
  monthlyBudgetMicrousd: number | null;
}

export interface ResolvedLimitsConfig {
  perUser: ResolvedLimitScope;
  perApp: ResolvedLimitScope;
}

export interface ResolvedAppConfig {
  authentication: AuthenticationConfig;
  routing: ResolvedRoutingConfig;
  limits: ResolvedLimitsConfig;
  endpoints: EndpointsConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const emptyRecord = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`Invalid ${label} configuration`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${label} must be a non-empty string`);
  }
  return value;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${label} must be a positive integer or null`);
  }
  return value;
}

function monthlyUsd(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${label} must be a non-negative number or null`);
  }
  if (!Number.isSafeInteger(Math.round(value * 1_000_000))) {
    throw new ConfigError(`${label} is too large`);
  }
  return value;
}

function parseClaims(value: unknown): ClaimRequirement[] {
  if (!Array.isArray(value)) {
    throw new ConfigError("authentication.issuer.required_claims must be an array");
  }
  return value.map((item) => {
    const requirement = record(item, "claim requirement");
    const path = requiredString(requirement.path, "Claim requirement path");
    const contains = requirement.contains;
    const hasContains = typeof contains === "string"
      || (Array.isArray(contains) && contains.length > 0 && contains.every((entry) => typeof entry === "string"));
    const hasEquals = ["string", "number", "boolean"].includes(typeof requirement.equals);
    if (hasContains === hasEquals) {
      throw new ConfigError("Claim requirements need exactly one of contains or equals");
    }
    return {
      path,
      ...(hasContains ? { contains: contains as string | string[] } : {}),
      ...(hasEquals ? { equals: requirement.equals as string | number | boolean } : {}),
    };
  });
}

function parseClaimValues(value: unknown, label: string): string[] {
  if (typeof value === "string") return [requiredString(value, label)];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`${label} must be a non-empty string or array of strings`);
  }
  return value.map((entry) => requiredString(entry, label));
}

function parseLabel<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? value as T
    : undefined;
}

function parseIssuer(raw: unknown): IssuerAuthConfig {
  const issuer = record(raw, "authentication.issuer");
  const jwksUrl = requiredString(issuer.jwks_url, "authentication.issuer.jwks_url");
  let jwks: URL;
  try {
    jwks = new URL(jwksUrl);
  } catch {
    throw new ConfigError("authentication.issuer.jwks_url is invalid");
  }
  if (jwks.protocol !== "https:") throw new ConfigError("Issuer JWKS URLs must use HTTPS");
  if (issuer.token_header !== undefined
    && (typeof issuer.token_header !== "string" || issuer.token_header.length === 0)) {
    throw new ConfigError("authentication.issuer.token_header must be non-empty");
  }
  const lifetime = nullablePositiveInteger(
    issuer.max_token_lifetime_seconds,
    "authentication.issuer.max_token_lifetime_seconds",
  );
  if (lifetime === null) {
    throw new ConfigError("authentication.issuer.max_token_lifetime_seconds cannot be null");
  }
  const provider = parseLabel(issuer.provider, ISSUER_PROVIDERS);
  const entitlement = parseLabel(issuer.entitlement, ENTITLEMENT_CHECKS);
  return {
    jwks_url: jwks.toString(),
    issuer: parseClaimValues(issuer.issuer, "authentication.issuer.issuer"),
    audience: parseClaimValues(issuer.audience, "authentication.issuer.audience"),
    user_id_claim: requiredString(issuer.user_id_claim, "authentication.issuer.user_id_claim"),
    ...(typeof issuer.token_header === "string" ? { token_header: issuer.token_header.toLowerCase() } : {}),
    required_claims: parseClaims(issuer.required_claims),
    max_token_lifetime_seconds: lifetime,
    ...(provider === undefined ? {} : { provider }),
    ...(entitlement === undefined ? {} : { entitlement }),
  };
}

const RESERVED_END_USER_HEADERS = new Set([
  "authorization",
  ...PROVIDER_CREDENTIAL_HEADERS,
  "x-app-version",
  "content-type",
  "content-length",
  "host",
]);

function parseEndUserHeader(value: unknown): string {
  const header = requiredString(value, "authentication.end_user.header").trim().toLowerCase();
  if (header.length > 64 || !HTTP_FIELD_NAME.test(header)) {
    throw new ConfigError("authentication.end_user.header must be a valid HTTP header name");
  }
  if (RESERVED_END_USER_HEADERS.has(header)) {
    throw new ConfigError(
      `authentication.end_user.header cannot be ${header}: the gateway already uses that header`,
    );
  }
  return header;
}

function parseApiKeyEndUser(raw: unknown): ApiKeyEndUser {
  const value = record(raw, "authentication.end_user");
  if (value.source === "header") return { source: "header", header: parseEndUserHeader(value.header) };
  if (value.source === "issuer") return { source: "issuer", issuer: parseIssuer(value.issuer) };
  throw new ConfigError("authentication.end_user.source must be one of header, issuer");
}

function parseAppAttestEndUser(raw: unknown): AppAttestEndUser {
  const value = record(raw, "authentication.end_user");
  if (value.source === "issuer") return { source: "issuer", issuer: parseIssuer(value.issuer) };
  if (value.source === "app_install") return { source: "app_install" };
  throw new ConfigError("authentication.end_user.source must be one of issuer, app_install");
}

function parseEnvironments(value: unknown): AppAttestEnvironment[] {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => !(APP_ATTEST_ENVIRONMENTS as readonly unknown[]).includes(item))
    || new Set(value).size !== value.length) {
    throw new ConfigError("authentication.app_attest.environments is invalid");
  }
  return value as AppAttestEnvironment[];
}

function parseAuthentication(raw: unknown): StoredAuthenticationConfig {
  const value = record(raw, "authentication");
  if (Object.hasOwn(value, "development_access")) {
    throw new ConfigError("authentication.development_access is no longer supported");
  }
  if (value.type === "api_key") {
    return {
      type: "api_key",
      ...(value.end_user === undefined ? {} : { end_user: parseApiKeyEndUser(value.end_user) }),
    };
  }
  if (value.type !== "apple_app_attest") throw new ConfigError("authentication.type is invalid");
  const appAttest = record(value.app_attest, "authentication.app_attest");
  return {
    type: "apple_app_attest",
    app_attest: {
      team_id: requiredString(appAttest.team_id, "authentication.app_attest.team_id"),
      bundle_id: requiredString(appAttest.bundle_id, "authentication.app_attest.bundle_id"),
      ...(appAttest.environments === undefined
        ? {}
        : { environments: parseEnvironments(appAttest.environments) }),
    },
    end_user: parseAppAttestEndUser(value.end_user),
  };
}

function parseAllowedPaths(value: unknown, label: string): ProviderPolicy["allowed_paths"] {
  if (!Array.isArray(value)) throw new ConfigError(`${label} must be an array`);
  return value.map((item, index) => {
    if (typeof item === "string" && item.length > 0) return item;
    const path = record(item, `${label}[${index}]`);
    const pathname = requiredString(path.path, `${label}[${index}].path`);
    if (path.fixed_model !== undefined
      && (typeof path.fixed_model !== "string" || path.fixed_model.length === 0)) {
      throw new ConfigError(`${label}[${index}].fixed_model is invalid`);
    }
    if (path.clamp !== undefined && !(OUTPUT_CLAMP_STYLES as readonly unknown[]).includes(path.clamp)) {
      throw new ConfigError(`${label}[${index}].clamp is invalid`);
    }
    const clamp = typeof path.clamp === "string" ? path.clamp as OutputClampStyle : undefined;
    const parsed: ProviderPolicy["allowed_paths"][number] = {
      path: pathname,
      ...(typeof path.fixed_model === "string" ? { fixed_model: path.fixed_model } : {}),
      ...(clamp === undefined ? {} : { clamp }),
    };
    return parsed;
  });
}

function parseProvider(raw: unknown, slug: string): ProviderPolicy {
  const value = record(raw, `routing provider ${slug}`);
  const models = value.allowed_models ?? [];
  if (!Array.isArray(models) || models.some((model) => typeof model !== "string" || model.length === 0)) {
    throw new ConfigError(`${slug}.allowed_models must be a string array`);
  }
  const result: ProviderPolicy = {
    allowed_paths: parseAllowedPaths(value.allowed_paths ?? [], `${slug}.allowed_paths`),
    allowed_models: models as string[],
  };
  if (value.max_output_tokens !== undefined) {
    const maximum = nullablePositiveInteger(value.max_output_tokens, `${slug}.max_output_tokens`);
    if (maximum === null) throw new ConfigError(`${slug}.max_output_tokens cannot be null`);
    result.max_output_tokens = maximum;
  }
  return result;
}

function parseRouting(raw: unknown): RoutingConfig {
  const value = record(raw, "routing");
  const providers = record(value.providers, "routing.providers");
  if (providers.mode !== "all" && providers.mode !== "selected") {
    throw new ConfigError("routing.providers.mode must be all or selected");
  }
  const selected = emptyRecord<ProviderPolicy>();
  if (providers.mode === "all") {
    if (providers.selected !== undefined) {
      throw new ConfigError("routing.providers.selected must be omitted in all mode");
    }
  } else {
    const rawSelected = record(providers.selected, "routing.providers.selected");
    for (const [slug, policy] of Object.entries(rawSelected)) {
      if (!PROVIDER_SLUG_PATTERN.test(slug)) throw new ConfigError(`Invalid provider instance slug ${slug}`);
      selected[slug] = parseProvider(policy, slug);
    }
  }
  const rawRewrites = record(value.model_rewrites, "routing.model_rewrites");
  const modelRewrites = emptyRecord<string>();
  for (const [source, target] of Object.entries(rawRewrites)) {
    modelRewrites[source] = requiredString(target, `routing.model_rewrites.${source}`);
  }
  return {
    providers: providers.mode === "all" ? { mode: "all" } : { mode: "selected", selected },
    model_rewrites: modelRewrites,
  };
}

function parseEndpointTarget(raw: unknown, label: string): { provider: string; model: string } {
  const value = record(raw, label);
  const provider = requiredString(value.provider, `${label}.provider`);
  if (!PROVIDER_SLUG_PATTERN.test(provider)) throw new ConfigError(`${label}.provider is not a valid slug`);
  return { provider, model: requiredString(value.model, `${label}.model`) };
}

function parseEndpoint(raw: unknown, label: string): EndpointConfig {
  const value = record(raw, label);
  if (!(ENDPOINT_API_STYLES as readonly unknown[]).includes(value.api_style)) {
    throw new ConfigError(`${label}.api_style must be one of ${ENDPOINT_API_STYLES.join(", ")}`);
  }
  const target = parseEndpointTarget(value, label);
  const endpoint: EndpointConfig = {
    api_style: value.api_style as EndpointConfig["api_style"],
    ...target,
  };
  if (value.params !== undefined) endpoint.params = record(value.params, `${label}.params`);
  if (value.max_output_tokens !== undefined) {
    const maximum = nullablePositiveInteger(value.max_output_tokens, `${label}.max_output_tokens`);
    if (maximum === null) throw new ConfigError(`${label}.max_output_tokens cannot be null`);
    endpoint.max_output_tokens = maximum;
  }
  if (value.fallback !== undefined) {
    if (!Array.isArray(value.fallback)) throw new ConfigError(`${label}.fallback must be an array`);
    endpoint.fallback = value.fallback.map((item, index) =>
      parseEndpointTarget(item, `${label}.fallback[${index}]`));
  }
  return endpoint;
}

function parseEndpoints(raw: unknown): EndpointsConfig | undefined {
  if (raw === undefined) return undefined;
  const value = record(raw, "endpoints");
  const endpoints = emptyRecord<EndpointConfig>();
  for (const [slug, definition] of Object.entries(value)) {
    if (!ENDPOINT_SLUG.test(slug)) {
      throw new ConfigError(
        `endpoints.${slug} is not a valid slug; use 1-64 characters from a-z, 0-9, and -`,
      );
    }
    endpoints[slug] = parseEndpoint(definition, `endpoints.${slug}`);
  }
  return endpoints;
}

function parseLimitScope(raw: unknown, label: string): LimitScopeConfig {
  const value = record(raw, label);
  const requests = record(value.requests, `${label}.requests`);
  const spending = record(value.spending, `${label}.spending`);
  return {
    requests: {
      per_minute: nullablePositiveInteger(requests.per_minute, `${label}.requests.per_minute`),
      per_day: nullablePositiveInteger(requests.per_day, `${label}.requests.per_day`),
    },
    spending: { monthly_usd: monthlyUsd(spending.monthly_usd, `${label}.spending.monthly_usd`) },
  };
}

function parseLimits(raw: unknown): LimitsConfig | undefined {
  if (raw === undefined) return undefined;
  const value = record(raw, "limits");
  return {
    per_user: parseLimitScope(value.per_user, "limits.per_user"),
    per_app: parseLimitScope(value.per_app, "limits.per_app"),
  };
}

const scopeHasStoredLimits = (scope: LimitScopeConfig): boolean =>
  scope.requests.per_minute !== null
  || scope.requests.per_day !== null
  || scope.spending.monthly_usd !== null;

export function identifiesEndUsers(authentication: AuthenticationConfig | StoredAuthenticationConfig): boolean {
  return authentication.type !== "api_key" || authentication.end_user !== undefined;
}

export function endUserIssuer(
  authentication: AuthenticationConfig | StoredAuthenticationConfig,
): IssuerAuthConfig | undefined {
  return authentication.end_user?.source === "issuer" ? authentication.end_user.issuer : undefined;
}

export function endUserHeader(
  authentication: AuthenticationConfig | StoredAuthenticationConfig,
): string | undefined {
  return authentication.type === "api_key" && authentication.end_user?.source === "header"
    ? authentication.end_user.header
    : undefined;
}

/** Safely decodes and normalizes persisted or draft JSON without applying runtime defaults. */
export function decodeStoredAppConfig(raw: unknown): StoredAppConfig {
  const value = record(raw, "app");
  const authentication = parseAuthentication(value.authentication);
  const routing = parseRouting(value.routing);
  const limits = parseLimits(value.limits);
  const endpoints = parseEndpoints(value.endpoints);
  if (!identifiesEndUsers(authentication) && limits && scopeHasStoredLimits(limits.per_user)) {
    throw new ConfigError(
      "limits.per_user needs an authentication.end_user source: this application identifies no end users, so use limits.per_app",
    );
  }
  return {
    authentication,
    routing,
    ...(limits === undefined ? {} : { limits }),
    ...(endpoints === undefined ? {} : { endpoints }),
  };
}

const UNLIMITED_SCOPE: ResolvedLimitScope = {
  requestsPerMinute: null,
  requestsPerDay: null,
  monthlyBudgetMicrousd: null,
};

function resolveLimitScope(scope: LimitScopeConfig): ResolvedLimitScope {
  return {
    requestsPerMinute: scope.requests.per_minute,
    requestsPerDay: scope.requests.per_day,
    monthlyBudgetMicrousd: scope.spending.monthly_usd === null
      ? null
      : Math.round(scope.spending.monthly_usd * 1_000_000),
  };
}

/** Applies request-path defaults once, after a stored configuration has been validated. */
export function resolveConfiguration(stored: StoredAppConfig): ResolvedAppConfig {
  const authentication: AuthenticationConfig = stored.authentication.type === "apple_app_attest"
    ? {
        ...stored.authentication,
        app_attest: {
          ...stored.authentication.app_attest,
          environments: stored.authentication.app_attest.environments ?? ["production"],
        },
      }
    : stored.authentication;
  return {
    authentication,
    routing: {
      providerMode: stored.routing.providers.mode,
      providers: stored.routing.providers.mode === "selected"
        ? stored.routing.providers.selected ?? emptyRecord<ProviderPolicy>()
        : emptyRecord<ProviderPolicy>(),
      modelRewrites: stored.routing.model_rewrites,
    },
    limits: stored.limits
      ? {
          perUser: resolveLimitScope(stored.limits.per_user),
          perApp: resolveLimitScope(stored.limits.per_app),
        }
      : { perUser: UNLIMITED_SCOPE, perApp: UNLIMITED_SCOPE },
    endpoints: stored.endpoints ?? emptyRecord<EndpointConfig>(),
  };
}
