import { eq } from "drizzle-orm";
import { database } from "../db";
import { app } from "../db/schema";
import { GatewayError } from "./errors";
import type { OrganizationPricing } from "./provider-store";
import {
  ENDPOINT_API_STYLES,
  PROVIDER_TYPES,
  providersForEndpointStyle,
} from "./providers";
import { hasModelPrice } from "./usage";
import type {
  AllowedPath,
  AppConfig,
  AuthenticationConfig,
  ClaimRequirement,
  EndpointApiStyle,
  EndpointConfig,
  EndpointProvider,
  EndpointsConfig,
  EndpointTarget,
  LimitsConfig,
  LimitScopeConfig,
  IssuerAuthConfig,
  OutputClampStyle,
  ProviderType,
  ProviderProxyConfig,
  ResolvedLimitScope,
  ResolvedRoutingConfig,
  RoutingConfig,
  StoredAppConfig,
} from "./types";
import type { BillingPlanLimits } from "../billing/gateway";

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
export const ENDPOINT_SLUG = /^[a-z0-9-]{1,64}$/u;

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
    user_id_claim: userIdClaim,
    ...(typeof issuer.token_header === "string" ? { token_header: issuer.token_header.toLowerCase() } : {}),
    required_claims: parseClaims(issuer.required_claims),
    max_token_lifetime_seconds: maxLifetime,
  };
}

function parseAuthentication(raw: unknown): AuthenticationConfig {
  const value = record(raw, "authentication");
  if (Object.hasOwn(value, "development_access")) {
    throw new GatewayError(
      500,
      "internal_error",
      "authentication.development_access is no longer supported",
    );
  }
  if (value.type === "api_key") {
    const endUser = record(value.end_user, "authentication.end_user");
    if (endUser.header !== "x-end-user-id" || typeof endUser.required !== "boolean" || endUser.fallback !== "api_key") {
      throw new GatewayError(500, "internal_error", "Invalid authentication.end_user configuration");
    }
    return {
      type: "api_key",
      ...(value.issuer === undefined ? {} : { issuer: parseIssuer(value.issuer) }),
      end_user: { header: "x-end-user-id", required: endUser.required, fallback: "api_key" },
    };
  }
  if (value.type !== "apple_app_attest") {
    throw new GatewayError(500, "internal_error", "authentication.type is invalid");
  }

  const appAttest = record(value.app_attest, "authentication.app_attest");
  if (Object.hasOwn(appAttest, "environments")) {
    throw new GatewayError(
      500,
      "internal_error",
      "authentication.app_attest.environments is no longer supported",
    );
  }

  return {
    type: "apple_app_attest",
    issuer: parseIssuer(value.issuer),
    app_attest: {
      team_id: requiredString(appAttest.team_id, "authentication.app_attest.team_id"),
      bundle_id: requiredString(appAttest.bundle_id, "authentication.app_attest.bundle_id"),
    },
  };
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

function parseProvider(raw: unknown, provider: ProviderType): ProviderProxyConfig {
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
  selected: Partial<Record<ProviderType, ProviderProxyConfig>>,
  modelRewrites: Record<string, string>,
  pricing: OrganizationPricing,
): void {
  for (const [source, target] of Object.entries(modelRewrites)) {
    if (!PROVIDER_TYPES.some((provider) => hasModelPrice(provider, target, pricing[provider]))) {
      throw new GatewayError(
        500,
        "internal_error",
        `routing.model_rewrites.${source} targets model ${target}, which has no configured price`,
      );
    }
  }

  for (const [provider, config] of Object.entries(selected) as [ProviderType, ProviderProxyConfig][]) {
    const configuredModels = [
      ...config.allowed_models.map((model) => ({ model, label: `${provider}.allowed_models` })),
      ...config.allowed_paths.flatMap((entry, index) => {
        if (typeof entry === "string" || entry.fixed_model === undefined) return [];
        return [{ model: entry.fixed_model, label: `${provider}.allowed_paths[${index}].fixed_model` }];
      }),
    ];
    for (const configured of configuredModels) {
      const resolved = modelRewrites[configured.model] ?? configured.model;
      if (!hasModelPrice(provider, resolved, pricing[provider])) {
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
  pricing: OrganizationPricing | null,
): { stored: RoutingConfig; resolved: ResolvedRoutingConfig } {
  const value = record(raw, "routing");
  const providers = record(value.providers, "routing.providers");
  if (providers.mode !== "all" && providers.mode !== "selected") {
    throw new GatewayError(500, "internal_error", "routing.providers.mode must be all or selected");
  }
  const selected: Partial<Record<ProviderType, ProviderProxyConfig>> = {};
  if (providers.mode === "all") {
    if (providers.selected !== undefined) {
      throw new GatewayError(500, "internal_error", "routing.providers.selected must be omitted in all mode");
    }
  } else {
    const selectedRaw = record(providers.selected, "routing.providers.selected");
    for (const key of Object.keys(selectedRaw)) {
      if (!PROVIDER_TYPES.includes(key as ProviderType)) {
        throw new GatewayError(500, "internal_error", `Unknown provider ${key}`);
      }
    }
    for (const provider of PROVIDER_TYPES) {
      if (selectedRaw[provider] !== undefined) selected[provider] = parseProvider(selectedRaw[provider], provider);
    }
  }
  const rewrites = record(value.model_rewrites, "routing.model_rewrites");
  const modelRewrites: Record<string, string> = {};
  for (const [source, target] of Object.entries(rewrites)) {
    modelRewrites[source] = requiredString(target, `routing.model_rewrites.${source}`);
  }
  if (pricing) validateRoutingPrices(selected, modelRewrites, pricing);
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
  pricing: OrganizationPricing | null,
): EndpointTarget {
  const value = record(raw, label);
  const provider = value.provider;
  const eligibleProviders = providersForEndpointStyle(apiStyle);
  if (!eligibleProviders.includes(provider as EndpointProvider)) {
    throw new GatewayError(
      500,
      "internal_error",
      `${label}.provider must be one of ${eligibleProviders.join(", ")}`,
    );
  }
  const model = requiredString(value.model, `${label}.model`);
  if (pricing && !hasModelPrice(provider as EndpointProvider, model, pricing[provider as EndpointProvider])) {
    throw new GatewayError(
      500,
      "internal_error",
      `${label}.model ${model} has no configured price for ${String(provider)}`,
    );
  }
  return { provider: provider as EndpointProvider, model };
}

function parseEndpoint(
  raw: unknown,
  label: string,
  pricing: OrganizationPricing | null,
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
  const target = parseEndpointTarget(value, label, apiStyle, pricing);
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
      parseEndpointTarget(item, `${label}.fallback[${index}]`, apiStyle, pricing),
    );
  }
  return endpoint;
}

function parseEndpoints(raw: unknown, pricing: OrganizationPricing | null): EndpointsConfig {
  if (raw === undefined) return {};
  const value = record(raw, "endpoints");
  const endpoints: EndpointsConfig = {};
  for (const [slug, definition] of Object.entries(value)) {
    if (!ENDPOINT_SLUG.test(slug)) {
      throw new GatewayError(
        500,
        "internal_error",
        `endpoints.${slug} is not a valid slug; use 1-64 characters from a-z, 0-9, and -`,
      );
    }
    endpoints[slug] = parseEndpoint(definition, `endpoints.${slug}`, pricing);
  }
  return endpoints;
}

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
 * Model pricing is validated when a configuration is *written*, against the
 * global catalog merged with the organization's own overrides. Reading a stored
 * configuration deliberately skips that check (`pricing: null`): a price that
 * disappears after the fact must surface as a `pricing_not_configured` response
 * on the request that needs it, never as an unparseable app.
 */
export function parseStoredAppConfig(
  raw: unknown,
  pricing: OrganizationPricing | null = {},
): {
  stored: StoredAppConfig;
  resolved: Omit<AppConfig, "id" | "organizationId" | "name" | "status">;
} {
  const value = record(raw, "app");
  const authentication = parseAuthentication(value.authentication);
  const routing = parseRouting(value.routing, pricing);
  const limitsValue = record(value.limits, "limits");
  const perUser = parseLimitScope(limitsValue.per_user, "limits.per_user");
  const perApp = parseLimitScope(limitsValue.per_app, "limits.per_app");
  const limits: LimitsConfig = { per_user: perUser.stored, per_app: perApp.stored };
  const endpoints = parseEndpoints(value.endpoints, pricing);
  return {
    stored: {
      authentication,
      routing: routing.stored,
      limits,
      ...(value.endpoints === undefined ? {} : { endpoints }),
    },
    resolved: {
      authentication,
      routing: routing.resolved,
      limits: { perUser: perUser.resolved, perApp: perApp.resolved },
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

export function hasAppLevelLimits(app: AppConfig): boolean {
  const limits = app.limits.perApp;
  return limits.requestsPerMinute !== null
    || limits.requestsPerDay !== null
    || limits.monthlyBudgetMicrousd !== null;
}

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

function assertBillingCeilings(config: StoredAppConfig, ceilings: BillingPlanLimits): void {
  const scopes = [config.limits.per_user, config.limits.per_app];
  for (const scope of scopes) {
    if (
      ceilings.maxRpm !== undefined
      && (scope.requests.per_minute === null || scope.requests.per_minute > ceilings.maxRpm)
    ) {
      throw new GatewayError(403, "plan_limit_exceeded", `requests.per_minute exceeds the plan ceiling of ${ceilings.maxRpm}`);
    }
    if (
      ceilings.maxRpd !== undefined
      && (scope.requests.per_day === null || scope.requests.per_day > ceilings.maxRpd)
    ) {
      throw new GatewayError(403, "plan_limit_exceeded", `requests.per_day exceeds the plan ceiling of ${ceilings.maxRpd}`);
    }
    if (
      ceilings.maxMonthlyUsd !== undefined
      && (scope.spending.monthly_usd === null || scope.spending.monthly_usd > ceilings.maxMonthlyUsd)
    ) {
      throw new GatewayError(403, "plan_limit_exceeded", `spending.monthly_usd exceeds the plan ceiling of ${ceilings.maxMonthlyUsd}`);
    }
  }
}

export function validateAppConfigJson(
  config: unknown,
  ceilings: BillingPlanLimits = {},
  pricing: OrganizationPricing = {},
): StoredAppConfig {
  const stored = parseStoredAppConfig(config, pricing).stored;
  assertBillingCeilings(stored, ceilings);
  return stored;
}

export function assertAppActive(app: AppConfig): void {
  if (app.status !== "active") throw new GatewayError(403, "app_disabled", "App is disabled");
}
