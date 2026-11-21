/**
 * Loading an app for the request path, with an isolate cache. If D1 is slow
 * or failing, the last known record is served (and `known_record_served` is
 * logged), as in v1.
 */
import { and, eq } from "drizzle-orm";
import { ConfigError, parseServedAppConfig } from "../contracts/app-config.ts";
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { readOrKnown } from "../core/stale-read.ts";
import { ttlCache } from "../core/ttl-cache.ts";
import type { KeptMedia } from "../contracts/app-config.ts";
import type { AppRecord } from "../core/types.ts";
import { database } from "../db/index.ts";
import { app } from "../db/schema.ts";

const APP_CACHE_TTL_MS = 60_000;

export const appCache = ttlCache<string, AppRecord>({ name: "app", ttlMs: APP_CACHE_TTL_MS, maxEntries: 10_000 });

/** Bumped by every invalidation, so a read that started before one does not store an old record. */
let invalidations = 0;

export async function loadApp(env: Env, appId: string): Promise<AppRecord> {
  const cached = appCache.get(appId);
  if (cached) return cached;
  return readOrKnown("app", appCache.peek(appId), () => readApp(env, appId));
}

async function readApp(env: Env, appId: string): Promise<AppRecord> {
  const startedAt = Date.now();
  const generation = invalidations;
  const row = await database(env.DB).query.app.findFirst({ where: eq(app.id, appId) });
  if (!row) {
    appCache.delete(appId);
    throw new GatewayError(404, "app_not_found", "App is not registered");
  }
  let config;
  try {
    const served = parseServedAppConfig(row.config);
    config = served.config;
    if (served.ignoredKeys.length > 0) {
      log("warn", "app_config_keys_ignored", { app: appId, keys: served.ignoredKeys.slice(0, 20) });
    }
  } catch (error) {
    // The app's sign-in settings cannot be read, so who is calling cannot be
    // checked, and the request is refused.
    if (!(error instanceof ConfigError)) throw error;
    log("error", "app_config_invalid", { app: appId, problem: error.message });
    throw new GatewayError(500, "internal_error", "The app's settings cannot be read");
  }
  const value: AppRecord = {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    status: row.status,
    revision: row.revision,
    authentication: config.authentication,
    routing: config.routing,
    limits: config.limits,
    presets: config.presets ?? {},
    conversations: config.conversations?.store === true ? config.conversations : null,
  };
  if (generation === invalidations) appCache.set(appId, value, { storedAt: startedAt });
  return value;
}

/**
 * The app's saved conversation storage setting, read from D1 and never from
 * the isolate cache: what it keeps, or null when storage is off or the app is
 * not active. Capture calls it in the background before writing, so a call
 * served from a stale cache never stores after storage was turned off. A
 * failed read throws, and the capture is dropped.
 */
export async function readSavedConversations(env: Env, accountId: string, appId: string): Promise<KeptMedia | null> {
  const row = await database(env.DB).query.app.findFirst({
    where: and(eq(app.id, appId), eq(app.accountId, accountId)),
    columns: { status: true, config: true },
  });
  if (!row || row.status !== "active") return null;
  const conversations = parseServedAppConfig(row.config).config.conversations;
  return conversations?.store === true ? conversations.keep : null;
}

/** Forgets a cached app, after its settings change. */
export function invalidateApp(appId: string): void {
  invalidations += 1;
  appCache.delete(appId);
}

export function assertAppActive(value: AppRecord): void {
  if (value.status !== "active") throw new GatewayError(403, "app_disabled", "App is disabled");
}
