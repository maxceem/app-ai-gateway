import { eq } from "drizzle-orm";
import { database } from "../db/index";
import { app } from "../db/schema";
import { GatewayError } from "./errors";
import { ttlCache } from "./ttl-cache";
import { ConfigError, parseAppConfig } from "../shared/app-config";
import { isAppStatus } from "../shared/app-status";
import type { AppRecord } from "./types";
import { parseLegacy } from "../client-auth/legacy";

const CONFIG_CACHE_TTL_MS = 60_000;

/**
 * Every application configuration this isolate has read.
 *
 * App ids come from an authenticated request against a row that exists in D1,
 * so this is not caller-growable, but a long-lived isolate in a large
 * deployment would otherwise keep one entry per app it ever served. The bound
 * is far above any single deployment's app count, so it costs a warm isolate
 * nothing.
 *
 * Exported for the tests that clear it on its own; nothing in the Worker reads
 * it but this file.
 */
export const appConfigCache = ttlCache<string, AppRecord>({
  name: "app-config",
  ttlMs: CONFIG_CACHE_TTL_MS,
  maxEntries: 10_000,
});

/** The columns an {@link AppRecord} is read from, with `config` and `status` as stored. */
type AppColumns = Pick<typeof app.$inferSelect, "id" | "organizationId" | "name" | "revision"> & {
  config: unknown;
  status: string;
  /** Absent where a caller selected only the configuration's columns; read as no legacy mode. */
  legacy?: string | null;
  unsignedLastSeenAt?: string | null;
};

/**
 * One authoritative stored row as the Worker reads it.
 *
 * A row that does not parse is an internal error, wherever it is read:
 * every write validates before it stores, so a request-path row that fails the
 * grammar means the deployment has moved under its own data.
 */
export function appRecordFromRow(row: AppColumns): AppRecord {
  const status = row.status;
  if (!isAppStatus(status)) {
    throw new GatewayError(500, "internal_error", `Stored application status "${status}" is not recognised`);
  }
  try {
    return {
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      status,
      revision: row.revision,
      config: parseAppConfig(row.config),
      legacy: parseLegacy(row.id, row.legacy),
      unsignedLastSeenAt: row.unsignedLastSeenAt ?? null,
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new GatewayError(500, "internal_error", error.message);
    }
    throw error;
  }
}

/** An {@link AppRecord} with its row's timestamps, as the management surface answers with it. */
export interface StoredApp extends AppRecord {
  createdAt: string;
  updatedAt: string;
}

export function storedAppFromRow(
  row: AppColumns & { createdAt: string; updatedAt: string },
): StoredApp {
  return { ...appRecordFromRow(row), createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/**
 * Bumped by every invalidation in this isolate. A read captures it when it
 * starts and caches its answer only if no invalidation happened meanwhile:
 * otherwise a read that began before a write committed — disabling a legacy
 * mode, say — could finish after the write's invalidation and put the old
 * record back for a whole TTL. One counter for every app, because an
 * invalidation is rare and a read that skips the cache once costs one more
 * read, never a wrong answer.
 */
let invalidations = 0;

export async function loadApp(env: Env, appId: string): Promise<AppRecord> {
  const cached = appConfigCache.get(appId);
  if (cached) return cached;
  // The window is measured from the read's start, not its end, so a slow read
  // never extends how stale a cached record may be.
  const startedAt = Date.now();
  const generation = invalidations;
  // Fill from the authoritative primary. This TTL is the only intentional
  // configuration staleness window and must not be extended by replica lag.
  const row = await database(env.DB).query.app.findFirst({ where: eq(app.id, appId) });
  if (!row) throw new GatewayError(404, "app_not_found", "App is not registered");
  const value = appRecordFromRow(row);
  if (generation === invalidations) appConfigCache.set(appId, value, { storedAt: startedAt });
  return value;
}

export function invalidateAppConfig(appId: string): void {
  invalidations += 1;
  appConfigCache.delete(appId);
}

export function assertAppActive(value: AppRecord): void {
  if (value.status !== "active") throw new GatewayError(403, "app_disabled", "App is disabled");
}
