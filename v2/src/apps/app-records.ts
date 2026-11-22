/**
 * Loading an app for the request path, with an isolate cache. If D1 is slow
 * or failing, the last known record is served (and `known_record_served` is
 * logged), as in v1.
 */
import { and, eq, sql } from "drizzle-orm";
import { ConfigError, parseServedAppConfig } from "../contracts/app-config.ts";
import { accountActivatedSql, assertAccountServes, emailVerificationRequired } from "../core/account-standing.ts";
import { withDeadline } from "../core/background.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { readOrKnown } from "../core/stale-read.ts";
import { ttlCache } from "../core/ttl-cache.ts";
import type { KeptMedia } from "../contracts/app-config.ts";
import type { AppRecord } from "../core/types.ts";
import { database } from "../db/index.ts";
import { app } from "../db/schema.ts";

const APP_CACHE_TTL_MS = 60_000;
/**
 * How long a cached app whose account is not activated yet is trusted: its
 * owner may verify at any moment, and this isolate may not be the one that
 * hears of it. Activation only ever turns on, so an activated entry keeps the
 * full minute.
 */
const PENDING_ACTIVATION_TTL_MS = 10_000;

export const appCache = ttlCache<string, AppRecord>({ name: "app", ttlMs: APP_CACHE_TTL_MS, maxEntries: 10_000 });

/** Bumped by every invalidation, so a read that started before one does not store an old record. */
let invalidations = 0;

/** How long a read that replaces an expired pending record may take before the request is told to retry. */
export const PENDING_REFRESH_DEADLINE_MS = 5_000;

export async function loadApp(env: Env, appId: string): Promise<AppRecord> {
  const cached = appCache.get(appId);
  if (cached) return cached;
  const known = appCache.peek(appId);
  if (known !== undefined && !known.value.accountActivated && emailVerificationRequired(env)) {
    // A record of an account still waiting on its owner's address is never
    // served past its life, not even through a stall: the owner may have
    // verified since, and serving it would refuse their apps for up to the
    // stale window. If the fresh read cannot be had, the request is told to
    // retry, never that the account is unverified. Activated records keep the
    // stale fallback below.
    try {
      return await withDeadline(readApp(env, appId), PENDING_REFRESH_DEADLINE_MS, "reading the app");
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      log("warn", "app_pending_refresh_failed", { app: appId, error: errorFacts(error) });
      throw new GatewayError(503, "service_unavailable", "The app could not be read just now; retry shortly", { "Retry-After": "5" });
    }
  }
  return readOrKnown("app", known, () => readApp(env, appId));
}

async function readApp(env: Env, appId: string): Promise<AppRecord> {
  const startedAt = Date.now();
  const generation = invalidations;
  // The account's activation comes in the same query, so the gate costs no read of its own.
  const row = await database(env.DB).query.app.findFirst({
    where: eq(app.id, appId),
    extras: { accountActivated: sql<number>`${sql.raw(accountActivatedSql('"app"."account_id"'))}`.as("account_activated") },
  });
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
    accountActivated: Boolean(row.accountActivated),
  };
  if (generation === invalidations) {
    const pending = !value.accountActivated && emailVerificationRequired(env);
    appCache.set(appId, value, { storedAt: startedAt, ...(pending ? { ttlMs: PENDING_ACTIVATION_TTL_MS } : {}) });
  }
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

/**
 * Forgets every cached app of an account whose owner just verified their
 * address, so this isolate serves them at once. Others catch up within
 * `PENDING_ACTIVATION_TTL_MS`.
 */
export function invalidateAccountApps(accountId: string): void {
  invalidations += 1;
  for (const appId of appCache.keys()) if (appCache.peek(appId)?.value.accountId === accountId) appCache.delete(appId);
}

/** Forgets a cached app, after its settings change. */
export function invalidateApp(appId: string): void {
  invalidations += 1;
  appCache.delete(appId);
}

export function assertAppActive(value: AppRecord): void {
  if (value.status !== "active") throw new GatewayError(403, "app_disabled", "App is disabled");
}

/**
 * Whether the app may serve its traffic now: it is active, and its account
 * may serve (`../core/account-standing.ts`, where the deployment verifies
 * email). Every app-traffic path asks this one function.
 */
export function assertAppServes(env: Env, value: AppRecord): void {
  assertAppActive(value);
  assertAccountServes(env, value.accountActivated);
}
