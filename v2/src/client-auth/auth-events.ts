/**
 * Auth events: one `app_auth_event` row per sign-in attempt, successful or
 * refused, kept 90 days, so a developer can see why their app's users cannot
 * sign in.
 */
import { and, eq, lt } from "drizzle-orm";
import { errorFacts } from "../core/error-facts.ts";
import type { ErrorCode } from "../core/errors.ts";
import { timeOrderedId } from "../core/ids.ts";
import { log } from "../core/log.ts";
import type { AuthMethod } from "../core/types.ts";
import type { ClientNetwork } from "../core/client-network.ts";
import { storedAppVersion } from "../core/app-version.ts";
import { storedClientSdk } from "../core/client-sdk.ts";
import { database } from "../db/index.ts";
import { appAuthChallenge, appAuthEvent, type AuthEventName } from "../db/schema.ts";

export const AUTH_EVENT_RETENTION_DAYS = 90;

/** How long an issued challenge can be used. */
export const CHALLENGE_TTL_SECONDS = 300;

/** What became of a challenge that no register or token call used. */
export type ChallengeOutcome = "abandoned" | "client_failed" | "client_recovered";

/** A success is worth a few tries: it is what tells a developer sign-in works. A refusal gets one. */
const SUCCESS_RECORD_ATTEMPTS = 3;
const RECORD_RETRY_DELAY_MS = 25;

export interface AuthEventInput {
  env: Env;
  appId: string;
  event: AuthEventName;
  userId?: string | null;
  authMethod?: AuthMethod | null;
  outcome: "ok" | ErrorCode | ChallengeOutcome;
  reason?: string | null;
  appVersion?: string | null;
  clientSdk?: string | null;
  network?: ClientNetwork | null;
  latencyMs: number;
}

/** Writes one auth event. A failure is logged, never thrown: a diagnostic never fails sign-in. */
export async function recordAuthEvent(input: AuthEventInput): Promise<void> {
  const id = timeOrderedId();
  const attempts = input.outcome === "ok" ? SUCCESS_RECORD_ATTEMPTS : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await database(input.env.DB)
        .insert(appAuthEvent)
        .values({
          id,
          appId: input.appId,
          userId: input.userId ?? null,
          event: input.event,
          authMethod: input.authMethod ?? null,
          outcome: input.outcome,
          reason: input.reason ?? null,
          appVersion: storedAppVersion(input.appVersion),
          clientSdk: storedClientSdk(input.clientSdk),
          networkAsn: input.network?.asn ?? null,
          networkName: input.network?.name ?? null,
          latencyMs: input.latencyMs,
          createdAt: Date.now(),
        })
        .onConflictDoNothing({ target: appAuthEvent.id });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, RECORD_RETRY_DELAY_MS * attempt));
    }
  }
  log("error", "auth_event_record_failed", {
    id,
    appId: input.appId,
    event: input.event,
    outcome: input.outcome,
    error: errorFacts(lastError),
  });
}

/** Marks a challenge as used by a refused attempt, so its expiry is not also counted as abandoned. */
export async function markChallengeAttempted(env: Env, appId: string, challenge: string): Promise<void> {
  await database(env.DB)
    .update(appAuthChallenge)
    .set({ attempted: true })
    .where(and(eq(appAuthChallenge.challenge, challenge), eq(appAuthChallenge.appId, appId)));
}

/**
 * Records every expired challenge nobody used as an `abandoned` event, then
 * deletes all expired challenges. The event id comes from the challenge, so
 * running this twice records each one once.
 */
export async function settleExpiredChallenges(
  db: D1Database,
  now: number = Date.now(),
): Promise<{ abandoned: number; deleted: number }> {
  const [recorded, deleted] = await db.batch([
    db
      .prepare(
        `INSERT INTO app_auth_event
           (id, app_id, event, outcome, reason, app_version, client_sdk, network_asn, network_name, created_at)
         SELECT 'challenge:' || challenge, app_id, 'challenge', 'abandoned', 'challenge_unused',
                app_version, client_sdk, network_asn, network_name, expires_at - ?
           FROM app_auth_challenge
          WHERE expires_at < ? AND attempted = 0
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(CHALLENGE_TTL_SECONDS * 1000, now),
    db.prepare("DELETE FROM app_auth_challenge WHERE expires_at < ?").bind(now),
  ]);
  return { abandoned: recorded?.meta.changes ?? 0, deleted: deleted?.meta.changes ?? 0 };
}

/** Deletes auth events older than the retention. */
export async function pruneAuthEvents(db: D1Database, now: number = Date.now()): Promise<number> {
  const cutoff = now - AUTH_EVENT_RETENTION_DAYS * 86_400_000;
  const result = await database(db).delete(appAuthEvent).where(lt(appAuthEvent.createdAt, cutoff));
  return result.meta.changes ?? 0;
}
