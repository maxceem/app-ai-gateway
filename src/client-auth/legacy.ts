/**
 * Legacy modes: behaviour an application keeps for a while after the gateway
 * has moved on, each until a date.
 *
 * They live in the `app.legacy` column as
 * `{ "<mode>": { "until": "<ISO 8601 UTC>" } }`. Migration 0006 enrolled every
 * App Attest application that existed when it landed, and a maintainer may set
 * or adjust one by hand in D1; through the API a mode can only be disabled
 * (`POST /v1/admin/apps/{app}/legacy/{mode}/disable`), never created or
 * extended. They are not part of the configuration, and surface as the
 * application's `warnings`. A mode is live only while its `until` is in the
 * future, so every one of them ends on its own.
 */

import { z } from "zod";
import { log } from "../core/log";
import { ttlCache } from "../core/ttl-cache";

/** Every legacy mode there is. */
export const LEGACY_MODES = [
  /**
   * An App Attest application's gateway tokens are accepted without the
   * per-request `X-AppAttest-Proof` header, as before the gateway required
   * one: for shipped builds on the 1.x Swift package, until they are updated.
   */
  "unsigned_requests",
] as const;

export type LegacyModeName = (typeof LEGACY_MODES)[number];

/** Where the change a legacy mode defers is described. */
export const PER_REQUEST_PROOF_DOCS_URL = "https://docs.appaigateway.com/integrate/ios#per-request-proof";

const Until = z.object({
  /** ISO 8601 date-time in UTC: the instant the mode stops applying. */
  until: z.iso.datetime({ offset: false }),
}).strict();

const LegacySchema = z.object({
  unsigned_requests: Until.optional(),
}).strict();

/** The parsed modes, with every `until` as a date. Empty when none are set. */
export type AppLegacy = Partial<Record<LegacyModeName, { until: Date }>>;

const NO_LEGACY: AppLegacy = Object.freeze({});

/**
 * The column as modes. A value that does not parse turns nothing on — a typo
 * by hand must never widen what an application accepts — and is logged as
 * `legacy_invalid` so the person who wrote it can find out.
 */
export function parseLegacy(appId: string, raw: string | null | undefined): AppLegacy {
  if (raw === null || raw === undefined || raw.trim() === "") return NO_LEGACY;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    log("warn", "legacy_invalid", { app: appId, error: "not JSON" });
    return NO_LEGACY;
  }
  const parsed = LegacySchema.safeParse(json);
  if (!parsed.success) {
    log("warn", "legacy_invalid", { app: appId, error: parsed.error.issues[0]?.message ?? "invalid" });
    return NO_LEGACY;
  }
  const legacy: AppLegacy = {};
  for (const [mode, value] of Object.entries(parsed.data) as [LegacyModeName, { until: string } | undefined][]) {
    if (value !== undefined) legacy[mode] = { until: new Date(value.until) };
  }
  return legacy;
}

/** A legacy mode while it is live, or null once its date has passed or when it was never set. */
export function legacyMode(
  app: { legacy: AppLegacy },
  mode: LegacyModeName,
  now: number = Date.now(),
): { until: Date } | null {
  const value = app.legacy[mode];
  return value !== undefined && value.until.getTime() > now ? value : null;
}

/** One thing about an application that will stop working on a stated date. */
export interface AppWarning {
  code: string;
  message: string;
  /** The legacy mode the warning is about. */
  legacy?: LegacyModeName;
  until?: string;
  docs_url?: string;
  /** When a request was last served under the mode, or null when none has been seen. */
  unsigned_last_seen_at?: string | null;
}

/** `2027-01-31T00:00:00Z`: the instant, to the second, as people read it. */
function isoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** What an application's live legacy modes mean for the person who owns it. */
export function appWarnings(
  app: { legacy: AppLegacy; unsignedLastSeenAt?: string | null },
  now: number = Date.now(),
): AppWarning[] {
  const warnings: AppWarning[] = [];
  const unsigned = legacyMode(app, "unsigned_requests", now);
  if (unsigned) {
    const until = isoSeconds(unsigned.until);
    warnings.push({
      code: "legacy_unsigned_requests",
      legacy: "unsigned_requests",
      message: `Legacy mode: requests without an App Attest proof are accepted until ${until}. Update the app to AppAIGateway Swift package 2.x, then disable legacy mode.`,
      until,
      docs_url: PER_REQUEST_PROOF_DOCS_URL,
      unsigned_last_seen_at: app.unsignedLastSeenAt ?? null,
    });
  }
  return warnings;
}

/**
 * The response headers a request served under `unsigned_requests` carries:
 * RFC 9745's `Deprecation`, RFC 8594's `Sunset` as an HTTP-date, and a link to
 * what replaces it.
 */
export function deprecationHeaders(until: Date): Record<string, string> {
  return {
    Deprecation: "true",
    Sunset: until.toUTCString(),
    Link: `<${PER_REQUEST_PROOF_DOCS_URL}>; rel="sunset"`,
  };
}

/** How stale `unsigned_last_seen_at` may get: at most one write per app per hour. */
export const UNSIGNED_SEEN_INTERVAL_MS = 60 * 60_000;

/** How long after a failed write the next one may be tried; doubled per consecutive failure. */
export const UNSIGNED_SEEN_RETRY_MS = 5 * 60_000;

/**
 * The apps this isolate has recorded an unsigned request for, or failed to,
 * and when it may write again: an hour after a write, and after a failure a
 * backoff of five minutes that doubles with each failure in a row, up to the
 * hour. The cached app record trails a write by up to its own TTL, so without
 * this every request in that minute would issue the statement again; and
 * without the backoff a D1 write outage would cost one failing statement per
 * unsigned request.
 */
const unsignedSeenWrites = ttlCache<string, { failures: number }>({
  name: "legacy-unsigned-seen",
  ttlMs: UNSIGNED_SEEN_INTERVAL_MS,
  maxEntries: 10_000,
});

/**
 * Records that `app` just served a request under `unsigned_requests`, unless
 * it already did within the hour, by the cached record or by this isolate's
 * own memory, or a recent attempt failed and its backoff has not passed. The
 * statement re-checks the hour in D1, so a write that loses a race to another
 * isolate changes nothing. Never throws: this is a signal for a person, and
 * the request has been served.
 */
export async function noteUnsignedRequest(
  db: D1Database,
  app: { id: string; unsignedLastSeenAt: string | null },
  now: number = Date.now(),
): Promise<void> {
  const threshold = new Date(now - UNSIGNED_SEEN_INTERVAL_MS).toISOString();
  if (app.unsignedLastSeenAt !== null && app.unsignedLastSeenAt > threshold) return;
  if (unsignedSeenWrites.get(app.id, now)) return;
  // The failures before this attempt, from a backoff marker that has expired.
  const failures = unsignedSeenWrites.peek(app.id)?.value.failures ?? 0;
  unsignedSeenWrites.set(app.id, { failures: 0 }, { storedAt: now });
  try {
    await db.prepare(
      `UPDATE app SET unsigned_last_seen_at = ?
       WHERE id = ? AND (unsigned_last_seen_at IS NULL OR unsigned_last_seen_at <= ?)`,
    ).bind(new Date(now).toISOString(), app.id, threshold).run();
  } catch (error) {
    const backoff = Math.min(UNSIGNED_SEEN_RETRY_MS * 2 ** failures, UNSIGNED_SEEN_INTERVAL_MS);
    unsignedSeenWrites.set(app.id, { failures: failures + 1 }, { storedAt: now, ttlMs: backoff });
    log("warn", "legacy_unsigned_seen_write_failed", {
      app: app.id,
      retryInMs: backoff,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
