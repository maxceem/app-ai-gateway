import { eq } from "drizzle-orm";
import { database } from "../db";
import { app } from "../db/schema";
import { GatewayError } from "./errors";
import { ConfigError, parseAppConfig } from "../shared/app-config";
import { referencedProviderSlugs as referencedSlugs } from "./config-references";
import type { AppRecord } from "./types";

export {
  DEFAULT_END_USER_HEADER,
  ENDPOINT_SLUG,
  endUserHeader,
  endUserIssuer,
  hasAppLevelLimits,
  hasUserLevelLimits,
  identifiesEndUsers,
} from "../shared/app-config";

interface CacheEntry {
  expiresAt: number;
  value: AppRecord;
}

const appCache = new Map<string, CacheEntry>();
const CONFIG_CACHE_TTL_MS = 60_000;

/**
 * One authoritative stored row as the Worker reads it.
 *
 * A row that does not parse is an internal error on this path and nothing else:
 * every write validates before it stores, so a request-path row that fails the
 * grammar means the deployment has moved under its own data. The management
 * routes answer for such a row differently — they hand it back with
 * `config_error` so it can be repaired — and they parse it themselves.
 */
export function appRecordFromRow(row: typeof app.$inferSelect): AppRecord {
  try {
    return {
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      status: row.status,
      revision: row.revision,
      config: parseAppConfig(row.config),
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new GatewayError(500, "internal_error", error.message);
    }
    throw error;
  }
}

export async function loadApp(env: Env, appId: string): Promise<AppRecord> {
  const cached = appCache.get(appId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  // Fill from the authoritative primary. This TTL is the only intentional
  // configuration staleness window and must not be extended by replica lag.
  const row = await database(env.DB).query.app.findFirst({ where: eq(app.id, appId) });
  if (!row) throw new GatewayError(404, "app_not_found", "App is not registered");
  const value = appRecordFromRow(row);
  appCache.set(appId, { expiresAt: Date.now() + CONFIG_CACHE_TTL_MS, value });
  return value;
}

export function invalidateAppConfig(appId: string): void {
  appCache.delete(appId);
}

export function clearAppConfigCache(): void {
  appCache.clear();
}

/**
 * The provider slugs a stored configuration already names, for the write paths
 * that let an edit keep a slug whose provider row has since been deleted. A row
 * that does not parse names none, which is the safe answer: nothing is
 * grandfathered on the strength of configuration nobody can read.
 */
export function referencedProviderSlugs(raw: unknown): Set<string> {
  try {
    return referencedSlugs(parseAppConfig(raw));
  } catch {
    return new Set();
  }
}

export function assertAppActive(value: AppRecord): void {
  if (value.status !== "active") throw new GatewayError(403, "app_disabled", "App is disabled");
}
