import { eq } from "drizzle-orm";
import { database } from "../db";
import { apps } from "../db/schema";
import { GatewayError } from "./errors";
import { hasModelPrice } from "./usage";
import type {
  AllowedPath,
  AppAttestEnvironment,
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
  OutputClampStyle,
  Provider,
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
export const PROVIDERS: Provider[] = ["openai", "anthropic", "xai", "gemini", "perplexity"];
const APP_ATTEST_ENVIRONMENTS: AppAttestEnvironment[] = ["production", "development"];
const CLAMP_STYLES: OutputClampStyle[] = [
  "responses",
  "chat_completions",
  "gemini_native",
  "anthropic",
  "none",
];
const CONFIG_CACHE_TTL_MS = 60_000;
export const ENDPOINT_SLUG = /^[a-z0-9-]{1,64}$/u;
export const ENDPOINT_API_STYLES: EndpointApiStyle[] = ["responses", "transcription"];
// Named endpoints compose the provider request themselves, so only providers
// whose Responses and transcription shapes the gateway builds are allowed.
export const ENDPOINT_PROVIDERS: EndpointProvider[] = ["openai", "xai"];

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

function parseAuthentication(raw: unknown): AuthenticationConfig {
  const value = record(raw, "authentication");
  if (value.type === "api_key") {
    const endUser = record(value.end_user, "authentication.end_user");
    if (endUser.header !== "x-end-user-id" || typeof endUser.required !== "boolean" || endUser.fallback !== "api_key") {
      throw new GatewayError(500, "internal_error", "Invalid authentication.end_user configuration");
    }
    return {
      type: "api_key",
      end_user: { header: "x-end-user-id", required: endUser.required, fallback: "api_key" },
    };
  }
  if (value.type !== "apple_app_attest") {
    throw new GatewayError(500, "internal_error", "authentication.type is invalid");
  }

  const issuer = record(value.issuer, "authentication.issuer");
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

  const appAttest = record(value.app_attest, "authentication.app_attest");
  const environments = appAttest.environments;
  if (
    !Array.isArray(environments)
    || environments.length === 0
    || environments.some((environment) => !APP_ATTEST_ENVIRONMENTS.includes(environment as AppAttestEnvironment))
    || new Set(environments).size !== environments.length
  ) {
    throw new GatewayError(500, "internal_error", "authentication.app_attest.environments is invalid");
  }

  if (typeof value.development_access !== "boolean") {
    throw new GatewayError(500, "internal_error", "authentication.development_access must be a boolean");
  }

  return {
    type: "apple_app_attest",
    issuer: {
      jwks_url: jwks.toString(),
      user_id_claim: userIdClaim,
      ...(typeof issuer.token_header === "string" ? { token_header: issuer.token_header.toLowerCase() } : {}),
      required_claims: parseClaims(issuer.required_claims),
      max_token_lifetime_seconds: maxLifetime,
    },
    app_attest: {
      team_id: requiredString(appAttest.team_id, "authentication.app_attest.team_id"),
      bundle_id: requiredString(appAttest.bundle_id, "authentication.app_attest.bundle_id"),
      environments: environments as AppAttestEnvironment[],
    },
    development_access: value.development_access,
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

function parseProvider(raw: unknown, provider: Provider): ProviderProxyConfig {
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
  selected: Partial<Record<Provider, ProviderProxyConfig>>,
  modelRewrites: Record<string, string>,
): void {
  for (const [source, target] of Object.entries(modelRewrites)) {
    if (!PROVIDERS.some((provider) => hasModelPrice(provider, target))) {
      throw new GatewayError(
        500,
        "internal_error",
        `routing.model_rewrites.${source} targets model ${target}, which has no configured price`,
      );
    }
  }

  for (const [provider, config] of Object.entries(selected) as [Provider, ProviderProxyConfig][]) {
    const configuredModels = [
      ...config.allowed_models.map((model) => ({ model, label: `${provider}.allowed_models` })),
      ...config.allowed_paths.flatMap((entry, index) => {
        if (typeof entry === "string" || entry.fixed_model === undefined) return [];
        return [{ model: entry.fixed_model, label: `${provider}.allowed_paths[${index}].fixed_model` }];
      }),
    ];
    for (const configured of configuredModels) {
      const resolved = modelRewrites[configured.model] ?? configured.model;
      if (!hasModelPrice(provider, resolved)) {
        throw new GatewayError(
          500,
          "internal_error",
          `${configured.label} resolves ${configured.model} to ${resolved}, which has no configured price`,
        );
      }
    }
  }
}

function parseRouting(raw: unknown): { stored: RoutingConfig; resolved: ResolvedRoutingConfig } {
  const value = record(raw, "routing");
  const providers = record(value.providers, "routing.providers");
  if (providers.mode !== "all" && providers.mode !== "selected") {
    throw new GatewayError(500, "internal_error", "routing.providers.mode must be all or selected");
  }
  const selected: Partial<Record<Provider, ProviderProxyConfig>> = {};
  if (providers.mode === "all") {
    if (providers.selected !== undefined) {
      throw new GatewayError(500, "internal_error", "routing.providers.selected must be omitted in all mode");
    }
  } else {
    const selectedRaw = record(providers.selected, "routing.providers.selected");
    for (const key of Object.keys(selectedRaw)) {
      if (!PROVIDERS.includes(key as Provider)) {
        throw new GatewayError(500, "internal_error", `Unknown provider ${key}`);
      }
    }
    for (const provider of PROVIDERS) {
      if (selectedRaw[provider] !== undefined) selected[provider] = parseProvider(selectedRaw[provider], provider);
    }
  }
  const rewrites = record(value.model_rewrites, "routing.model_rewrites");
  const modelRewrites: Record<string, string> = {};
  for (const [source, target] of Object.entries(rewrites)) {
    modelRewrites[source] = requiredString(target, `routing.model_rewrites.${source}`);
  }
  validateRoutingPrices(selected, modelRewrites);
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

function parseEndpointTarget(raw: unknown, label: string): EndpointTarget {
  const value = record(raw, label);
  const provider = value.provider;
  if (!ENDPOINT_PROVIDERS.includes(provider as EndpointProvider)) {
    throw new GatewayError(
      500,
      "internal_error",
      `${label}.provider must be one of ${ENDPOINT_PROVIDERS.join(", ")}`,
    );
  }
  const model = requiredString(value.model, `${label}.model`);
  if (!hasModelPrice(provider as EndpointProvider, model)) {
    throw new GatewayError(
      500,
      "internal_error",
      `${label}.model ${model} has no configured price for ${String(provider)}`,
    );
  }
  return { provider: provider as EndpointProvider, model };
}

function parseEndpoint(raw: unknown, label: string): EndpointConfig {
  const value = record(raw, label);
  const target = parseEndpointTarget(value, label);
  if (!ENDPOINT_API_STYLES.includes(value.api_style as EndpointApiStyle)) {
    throw new GatewayError(
      500,
      "internal_error",
      `${label}.api_style must be one of ${ENDPOINT_API_STYLES.join(", ")}`,
    );
  }
  const endpoint: EndpointConfig = {
    api_style: value.api_style as EndpointApiStyle,
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
      parseEndpointTarget(item, `${label}.fallback[${index}]`),
    );
  }
  return endpoint;
}

function parseEndpoints(raw: unknown): EndpointsConfig {
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
    endpoints[slug] = parseEndpoint(definition, `endpoints.${slug}`);
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

export function parseStoredAppConfig(raw: unknown): {
  stored: StoredAppConfig;
  resolved: Omit<AppConfig, "id" | "organizationId" | "name" | "status">;
} {
  const value = record(raw, "app");
  const authentication = parseAuthentication(value.authentication);
  const routing = parseRouting(value.routing);
  const limitsValue = record(value.limits, "limits");
  const perUser = parseLimitScope(limitsValue.per_user, "limits.per_user");
  const perApp = parseLimitScope(limitsValue.per_app, "limits.per_app");
  const limits: LimitsConfig = { per_user: perUser.stored, per_app: perApp.stored };
  const endpoints = parseEndpoints(value.endpoints);
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

function fromRow(row: typeof apps.$inferSelect): AppConfig {
  const parsed = parseStoredAppConfig(row.config);
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
  const row = await database(env.DB).query.apps.findFirst({ where: eq(apps.id, appId) });
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
): StoredAppConfig {
  const stored = parseStoredAppConfig(config).stored;
  assertBillingCeilings(stored, ceilings);
  return stored;
}

export function assertAppActive(app: AppConfig): void {
  if (app.status !== "active") throw new GatewayError(403, "app_disabled", "App is disabled");
}
