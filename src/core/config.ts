import { eq } from "drizzle-orm";
import { database } from "../db";
import { app } from "../db/schema";
import { GatewayError } from "./errors";
import type { OrganizationProviders } from "./provider-store";
import { recordFromEntries } from "./records";
import { PROVIDER_TYPES } from "./providers";
import {
  ConfigError,
  decodeStoredAppConfig,
  resolveConfiguration,
  type ResolvedLimitScope,
  type StoredAppConfig,
} from "../shared/app-config";
import {
  referencedProviderSlugs as referencedSlugs,
  validateConfigurationReferences,
} from "./config-references";
import type { AppConfig } from "./types";

export {
  DEFAULT_END_USER_HEADER,
  ENDPOINT_SLUG,
  endUserHeader,
  endUserIssuer,
  identifiesEndUsers,
} from "../shared/app-config";

interface CacheEntry {
  expiresAt: number;
  value: AppConfig;
}

const appCache = new Map<string, CacheEntry>();
const CONFIG_CACHE_TTL_MS = 60_000;
const NO_GRANDFATHERED_SLUGS: ReadonlySet<string> = new Set();
const WELL_KNOWN_PROVIDER_INSTANCES: OrganizationProviders = recordFromEntries(
  PROVIDER_TYPES.map((type) => [
    type,
    { id: type, slug: type, type, route: "direct" as const, pricing: null, status: "active" as const },
  ] as const),
);

function internalConfigError(error: unknown): never {
  if (error instanceof ConfigError) {
    throw new GatewayError(500, "internal_error", error.message);
  }
  throw error;
}

/**
 * Stable adapter for callers that need both persisted normalization and request-path defaults.
 * Organization-specific checks are deliberately applied only when a provider index is supplied.
 */
export function parseStoredAppConfig(
  raw: unknown,
  organizationProviders: OrganizationProviders | null = null,
  grandfatheredSlugs: ReadonlySet<string> = NO_GRANDFATHERED_SLUGS,
): {
  stored: StoredAppConfig;
  resolved: Omit<AppConfig, "id" | "organizationId" | "name" | "status">;
} {
  try {
    const stored = decodeStoredAppConfig(raw);
    if (organizationProviders !== null) {
      validateConfigurationReferences(stored, {
        instances: organizationProviders,
        grandfathered: grandfatheredSlugs,
      });
    }
    return { stored, resolved: resolveConfiguration(stored) };
  } catch (error) {
    internalConfigError(error);
  }
}

/** Resolves one authoritative stored row without consulting or mutating caches. */
export function appConfigFromRow(row: typeof app.$inferSelect): AppConfig {
  const stored = (() => {
    try {
      return decodeStoredAppConfig(row.config);
    } catch (error) {
      internalConfigError(error);
    }
  })();
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    status: row.status,
    ...resolveConfiguration(stored),
  };
}

const scopeHasLimits = (scope: ResolvedLimitScope): boolean =>
  scope.requestsPerMinute !== null
  || scope.requestsPerDay !== null
  || scope.monthlyBudgetMicrousd !== null;

export const hasAppLevelLimits = (value: AppConfig): boolean => scopeHasLimits(value.limits.perApp);
export const hasUserLevelLimits = (value: AppConfig): boolean => scopeHasLimits(value.limits.perUser);

export async function loadAppConfig(env: Env, appId: string): Promise<AppConfig> {
  const cached = appCache.get(appId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  // Fill from the authoritative primary. This TTL is the only intentional
  // configuration staleness window and must not be extended by replica lag.
  const row = await database(env.DB).query.app.findFirst({ where: eq(app.id, appId) });
  if (!row) throw new GatewayError(404, "app_not_found", "App is not registered");
  const value = appConfigFromRow(row);
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
  raw: unknown,
  organizationProviders: OrganizationProviders | null = WELL_KNOWN_PROVIDER_INSTANCES,
  grandfatheredSlugs: ReadonlySet<string> = NO_GRANDFATHERED_SLUGS,
): StoredAppConfig {
  return parseStoredAppConfig(raw, organizationProviders, grandfatheredSlugs).stored;
}

export function referencedProviderSlugs(raw: unknown): Set<string> {
  try {
    return referencedSlugs(decodeStoredAppConfig(raw));
  } catch {
    return new Set();
  }
}

export function assertAppActive(value: AppConfig): void {
  if (value.status !== "active") throw new GatewayError(403, "app_disabled", "App is disabled");
}
