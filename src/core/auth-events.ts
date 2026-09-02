import { log } from "./log";
import { database } from "../db";
import { appAuthEvent, type AuthEventName, type AuthMethod } from "../db/schema";

/**
 * How long an authentication attempt stays on file. Long enough to answer "did
 * this get worse after the release three weeks ago?", short enough that a
 * diagnostic table never becomes the largest thing a deployment stores. Usage
 * events, which are billing history, are never pruned.
 */
export const AUTH_EVENT_RETENTION_DAYS = 90;

const RECORD_ATTEMPTS = 3;
const RECORD_RETRY_DELAY_MS = 25;

export interface AuthEventInput {
  env: Env;
  appId: string;
  event: AuthEventName;
  /** Null wherever the attempt never established a trusted identity. */
  userId?: string | null;
  authMethod?: AuthMethod | null;
  /** `ok`, or the error code the client was handed. */
  outcome: string;
  reason?: string | null;
  appVersion?: string | null;
  latencyMs: number;
  claimDelayMs?: number | null;
}

/**
 * Records one authentication attempt, and never fails the request that made it.
 *
 * The response has already been decided by the time this runs — the caller
 * hands it to `waitUntil` — so a recording failure is logged under its own code
 * and abandoned rather than thrown. Retrying is safe because the insert is
 * idempotent under `event_id`: an ambiguous failure that actually landed costs
 * a wasted no-op, never a duplicate row.
 */
export async function recordAuthEvent(input: AuthEventInput): Promise<void> {
  // Minted before any attempt so every retry, and any later replay, settles
  // under one identity.
  const eventId = crypto.randomUUID();
  let lastError: unknown;
  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt += 1) {
    try {
      await database(input.env.DB)
        .insert(appAuthEvent)
        .values({
          eventId,
          appId: input.appId,
          userId: input.userId ?? null,
          event: input.event,
          authMethod: input.authMethod ?? null,
          outcome: input.outcome,
          reason: input.reason ?? null,
          appVersion: input.appVersion ?? null,
          latencyMs: input.latencyMs,
          claimDelayMs: input.claimDelayMs ?? null,
        })
        .onConflictDoNothing({ target: appAuthEvent.eventId });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < RECORD_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RECORD_RETRY_DELAY_MS * attempt));
      }
    }
  }
  log("error", "auth_event_record_failed", {
    eventId,
    appId: input.appId,
    userId: input.userId ?? null,
    event: input.event,
    outcome: input.outcome,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

/**
 * Drops authentication attempts past the retention window.
 *
 * Scoped to `app_auth_event` on purpose and forever: `app_usage_event` is
 * accounting history, and nothing scheduled is allowed to delete a row that
 * something was billed for.
 */
export async function pruneAuthEvents(
  env: Env,
  retentionDays = AUTH_EVENT_RETENTION_DAYS,
): Promise<number> {
  const result = await env.DB
    .prepare("DELETE FROM app_auth_event WHERE created_at < datetime('now', ?)")
    .bind(`-${retentionDays} days`)
    .run();
  return result.meta.changes ?? 0;
}
