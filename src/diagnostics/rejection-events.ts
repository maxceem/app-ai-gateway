import { markApiKeyUsed } from "../client-auth/api-keys";
import { claimDiagnosticSample } from "../core/endpoint-rate-limit";
import { timeOrderedId } from "../core/ids";
import { log } from "../core/log";
import { storedAppVersion } from "../core/app-version";
import type { GatewayIdentity } from "../core/types";
import type { AttemptAttribution } from "../usage/usage-record";
import {
  isConfigRejectionReason,
  type RejectionReason,
  type RejectionScope,
} from "../shared/rejection-reasons";
import { errorFacts } from "../core/error-facts";

export interface RejectionEventInput {
  env: Env;
  identity: GatewayIdentity;
  /**
   * What the refused request was about to call. A refusal on a route that
   * calls no provider — `/me` — has a route of its own and nothing else.
   */
  attribution:
    | Pick<AttemptAttribution, "providerSlug" | "model" | "route">
    | { providerSlug: null; model: null; route: string }
    /** A request refused while it was being planned: only what its URL and refusal named. */
    | { providerSlug: string | null; model: string | null; route: string | null };
  endpointSlug?: string | null;
  appVersion: string | null;
  reason: RejectionReason;
  scope: RejectionScope;
  latencyMs: number;
}

/**
 * Samples one refusal per identity and minute. A limit refusal shares one
 * sample whatever its routing or reason. A refusal by the app's settings has a
 * sample of its own per reason, so a burst of rate limits cannot hide the one
 * request that names a path the app does not allow.
 */
export async function recordRejectionEvent(input: RejectionEventInput): Promise<void> {
  const { env, identity, attribution } = input;
  const createdAt = new Date().toISOString();
  const byConfig = isConfigRejectionReason(input.reason);
  const subject = JSON.stringify([
    identity.appId,
    identity.userId === null ? "api_key" : "user",
    identity.userId ?? identity.apiKeyId ?? "app",
    ...(byConfig ? [input.reason] : []),
  ]);
  try {
    if (!await claimDiagnosticSample(env, byConfig ? "refused-config" : "blocked-usage", subject, 60_000)) return;
  } catch {
    // If coordination is unavailable, fail closed for optional diagnostics.
    return;
  }
  const eventId = timeOrderedId();
  try {
    // The live-app guard and insert are atomic. A late waitUntil task cannot
    // restore history after application or account cleanup has deleted it.
    await env.DB.prepare(`INSERT INTO app_rejection_event
      (event_id, app_id, user_id, api_key_id, reason, scope, provider_slug,
       model, route, endpoint_slug, app_version, auth_method, latency_ms, created_at, install_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM app WHERE id = ?)
      ON CONFLICT(event_id) DO NOTHING`)
      .bind(eventId, identity.appId, identity.userId, identity.apiKeyId ?? null,
        input.reason, input.scope, attribution.providerSlug, attribution.model,
        attribution.route, input.endpointSlug ?? null, storedAppVersion(input.appVersion),
        identity.authMethod, input.latencyMs, createdAt, identity.installId, identity.appId)
      .run();
  } catch (error) {
    log("warn", "rejection_record_failed", {
      appId: identity.appId,
      eventId,
      error: errorFacts(error),
    });
  }
  if (identity.apiKeyId) {
    try {
      await markApiKeyUsed(env, identity.apiKeyId);
    } catch (error) {
      log("warn", "rejection_api_key_used_failed", {
        appId: identity.appId,
        eventId,
        error: errorFacts(error),
      });
    }
  }
}

export const REJECTION_RETENTION_DAYS = 90;

export async function pruneRejectionEvents(db: D1Database, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - REJECTION_RETENTION_DAYS * 86_400_000).toISOString();
  const result = await db.prepare("DELETE FROM app_rejection_event WHERE created_at < ?")
    .bind(cutoff).run();
  return result.meta.changes;
}
