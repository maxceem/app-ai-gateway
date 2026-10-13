/**
 * Internal compatibility switches: behaviour an application keeps for a while
 * after the gateway has moved on, each until a date.
 *
 * They live in the `app.compat` column, which is set by hand in D1 and by
 * nothing else. They are not part of the configuration: no API, console, CLI
 * or MCP write can reach one, and no read publishes one except as the warning
 * it produces (see {@link appWarnings}). A switch is live only while its
 * `until` is in the future, so every one of them ends on its own.
 */

import { z } from "zod";
import { log } from "../core/log";

/** Where the change a compatibility switch defers is described. */
export const PER_REQUEST_PROOF_DOCS_URL = "https://docs.appaigateway.com/integrate/ios#per-request-proof";

const Until = z.object({
  /** ISO 8601 date-time in UTC: the instant the switch stops applying. */
  until: z.iso.datetime({ offset: false }),
}).strict();

const CompatSchema = z.object({
  /**
   * An App Attest application's gateway tokens are accepted without the
   * per-request `X-AppAttest-Proof` header, as before the gateway required
   * one. For a shipped build on the 1.x Swift package, until it is updated.
   */
  bearer_without_assertion: Until.optional(),
}).strict();

export type CompatFeature = keyof z.output<typeof CompatSchema>;

/** The parsed switches, with every `until` as a date. Empty when none are set. */
export type AppCompat = Partial<Record<CompatFeature, { until: Date }>>;

const NO_COMPAT: AppCompat = Object.freeze({});

/**
 * The column as switches. A value that does not parse switches nothing on —
 * a typo by hand must never widen what an application accepts — and is logged
 * as `compat_invalid` so the person who wrote it can find out.
 */
export function parseCompat(appId: string, raw: string | null | undefined): AppCompat {
  if (raw === null || raw === undefined || raw.trim() === "") return NO_COMPAT;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    log("warn", "compat_invalid", { app: appId, error: "not JSON" });
    return NO_COMPAT;
  }
  const parsed = CompatSchema.safeParse(json);
  if (!parsed.success) {
    log("warn", "compat_invalid", { app: appId, error: parsed.error.issues[0]?.message ?? "invalid" });
    return NO_COMPAT;
  }
  const compat: AppCompat = {};
  for (const [feature, value] of Object.entries(parsed.data) as [CompatFeature, { until: string } | undefined][]) {
    if (value !== undefined) compat[feature] = { until: new Date(value.until) };
  }
  return compat;
}

/** A switch while it is live, or null once its date has passed or when it was never set. */
export function compatFeature(
  app: { compat: AppCompat },
  feature: CompatFeature,
  now: number = Date.now(),
): { until: Date } | null {
  const value = app.compat[feature];
  return value !== undefined && value.until.getTime() > now ? value : null;
}

/** One thing about an application that will stop working on a stated date. */
export interface AppWarning {
  code: string;
  message: string;
  until?: string;
  docs_url?: string;
}

/** `2027-01-31T00:00:00Z`: the instant, to the second, as people read it. */
function isoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** What an application's live switches mean for the person who owns it. */
export function appWarnings(app: { compat: AppCompat }, now: number = Date.now()): AppWarning[] {
  const warnings: AppWarning[] = [];
  const bearer = compatFeature(app, "bearer_without_assertion", now);
  if (bearer) {
    const until = isoSeconds(bearer.until);
    warnings.push({
      code: "bearer_without_assertion",
      message: `Requests signed only with a gateway token are accepted until ${until}. Update the app to AppAIGateway Swift package 2.x, which signs every request with App Attest.`,
      until,
      docs_url: PER_REQUEST_PROOF_DOCS_URL,
    });
  }
  return warnings;
}

/**
 * The response headers a request served under `bearer_without_assertion`
 * carries: RFC 9745's `Deprecation`, RFC 8594's `Sunset` as an HTTP-date, and
 * a link to what replaces it.
 */
export function deprecationHeaders(until: Date): Record<string, string> {
  return {
    Deprecation: "true",
    Sunset: until.toUTCString(),
    Link: `<${PER_REQUEST_PROOF_DOCS_URL}>; rel="sunset"`,
  };
}
