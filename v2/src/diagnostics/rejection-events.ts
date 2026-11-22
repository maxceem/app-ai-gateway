/**
 * Rejection events: provider requests refused before they reached the
 * provider, ported from v1.
 *
 * Sampled, as v1 does: a refusal caused by the app's settings is recorded at
 * most once a minute per user and reason; any other refusal at most once a
 * minute per user. A failure to sample or record is logged and never changes
 * the answer the app already got.
 */
import { storedAppVersion } from "../core/app-version.ts";
import { errorFacts } from "../core/error-facts.ts";
import { claimDiagnosticSample } from "../core/flood-limit.ts";
import { timeOrderedId } from "../core/ids.ts";
import { log } from "../core/log.ts";
import { deletePass, type Pass } from "../core/chunked-delete.ts";
import type { GatewayIdentity } from "../core/types.ts";

/** Refusals caused by how the app is set up, rather than by who asked or how much. */
export const CONFIG_REJECTION_REASONS: ReadonlySet<string> = new Set([
  "path_not_allowed",
  "model_not_allowed",
  "provider_not_configured",
  "provider_disabled",
  "pricing_not_configured",
  "max_output_tokens_exceeded",
  "preset_not_found",
]);

/** Every refusal recorded as a rejection event, as v1's list. */
export const REJECTION_REASONS: ReadonlySet<string> = new Set([
  ...CONFIG_REJECTION_REASONS,
  "blocked_user",
  "blocked_app_rate",
  "blocked_app_budget",
  "blocked_billing",
  "blocked_replay",
  "payload_too_large",
]);

export const REJECTION_SAMPLE_WINDOW_MS = 60_000;

/**
 * What a refusal records instead of a requested model the gateway does not
 * know (`knownModel`), or a provider or preset the app does not have: those
 * are the caller's text, and a key or a prompt put there by mistake must
 * never be stored or shown.
 *
 * So every stored `model` and `provider_slug` was checked by this writer, and
 * a read shows them as stored. Only this writer sets `account_id`, and a read
 * never shows a row without one; a copy from v1 must check its models the
 * same way, or store this marker, before it sets an account.
 */
export const UNRECOGNIZED = "unrecognized";
export const REJECTION_RETENTION_DAYS = 90;

export interface RejectionEventInput {
  readonly identity: GatewayIdentity;
  /** The account that owns the app, as the request read it. */
  readonly accountId: string;
  readonly reason: string;
  readonly scope: string | null;
  /** A provider or preset the app has, or {@link UNRECOGNIZED}. */
  readonly providerSlug: string | null;
  /** The model the request named. Stored only when trusted, or when `modelKnown` says the gateway knows it. */
  readonly model: string | null;
  /**
   * For a model that is the caller's text: whether the gateway knows it.
   * Asked only once a refusal is sampled, so a served request never pays for
   * it; a model from the app's settings or a signed job id needs none.
   */
  readonly modelKnown?: () => boolean;
  readonly operation: string | null;
  readonly appVersion: string | null;
  readonly latencyMs: number;
}

export async function recordRejectionEvent(env: Env, input: RejectionEventInput): Promise<void> {
  const { identity } = input;
  const byConfig = CONFIG_REJECTION_REASONS.has(input.reason);
  const subject = JSON.stringify([
    identity.appId,
    identity.userId === null ? "api_key" : "user",
    identity.userId ?? identity.apiKeyId ?? "app",
    ...(byConfig ? [input.reason] : []),
  ]);
  try {
    if (!(await claimDiagnosticSample(env, byConfig ? "refused-config" : "blocked-usage", subject, REJECTION_SAMPLE_WINDOW_MS))) {
      return;
    }
  } catch {
    return;
  }
  const id = timeOrderedId();
  try {
    const model = input.model === null || input.modelKnown === undefined || input.modelKnown() ? input.model : UNRECOGNIZED;
    await env.DB.prepare(
      // Under the account the caller was verified for, and only while that
      // account still owns the app: an app id that comes back in another
      // account never shows this row.
      `INSERT INTO app_rejection_event
        (id, app_id, account_id, user_id, install_id, app_key_id, reason, scope, provider_slug, model, operation,
         app_version, auth_method, latency_ms, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM app WHERE id = ? AND account_id = ?)
       ON CONFLICT(id) DO NOTHING`,
    )
      .bind(
        id,
        identity.appId,
        input.accountId,
        identity.userId,
        identity.installId,
        identity.apiKeyId ?? null,
        input.reason,
        input.scope,
        input.providerSlug,
        model,
        input.operation,
        storedAppVersion(input.appVersion),
        identity.authMethod,
        input.latencyMs,
        Date.now(),
        identity.appId,
        input.accountId,
      )
      .run();
  } catch (error) {
    log("warn", "rejection_record_failed", { app: identity.appId, error: errorFacts(error) });
  }
}

/**
 * The nightly pass deleting rejection events older than the retention, a chunk at
 * a time (`../core/chunked-delete.ts`). Served by `app_rejection_event_created`.
 */
export function rejectionEventsPass(now: number): Pass {
  return deletePass("rejection_events_prune", {
    table: "app_rejection_event",
    rowids: "SELECT rowid FROM app_rejection_event WHERE created_at < ?",
    params: [now - REJECTION_RETENTION_DAYS * 86_400_000],
  });
}
