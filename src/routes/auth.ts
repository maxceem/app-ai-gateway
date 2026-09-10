import { Hono, type Context } from "hono";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { pruneAuthChallenges, recordAuthEvent } from "../core/auth-events";
import { assertAppActive, endUserIssuer, loadAppConfig } from "../core/config";
import { GatewayError } from "../core/errors";
import { log } from "../core/log";
import { lookupApiKeyUncached } from "../core/apikeys";
import { verifyIssuerToken } from "../core/issuer";
import { issueGatewayToken } from "../core/jwt";
import type {
  AppAttestEndUser,
  AppAttestEnvironment,
  AppConfig,
  AppleAppAttestAuthentication,
} from "../core/types";
import { database } from "../db";
import { appAuthChallenge, appUser, type AuthEventName, type AuthMethod } from "../db/schema";
import {
  AppAttestRegisterRequestSchema,
  AppAttestTokenRequestSchema,
  ApiKeyTokenRequestSchema,
} from "../contracts/schemas";

const GATEWAY_TOKEN_TTL_SECONDS = 3600;

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
  return value as Record<string, unknown>;
}

function schemaBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new GatewayError(
    400,
    "invalid_request",
    issue
      ? issue.path.length > 0
        ? `${issue.path.join(".")} is required`
        : issue.message
      : "Invalid request body",
  );
}

async function consumeChallenge(env: Env, appId: string, challenge: string): Promise<void> {
  const consumed = await database(env.DB)
    .delete(appAuthChallenge)
    .where(and(
      eq(appAuthChallenge.challenge, challenge),
      eq(appAuthChallenge.appId, appId),
      gt(appAuthChallenge.expiresAt, sql`datetime('now')`),
    ))
    .returning({ challenge: appAuthChallenge.challenge });
  if (consumed.length === 0) {
    throw new GatewayError(403, "attest_failed", "Challenge is invalid, expired, or already used");
  }
}

function accessTtl(): number {
  return GATEWAY_TOKEN_TTL_SECONDS;
}

function appleAuth(app: AppConfig): AppleAppAttestAuthentication {
  if (app.authentication.type !== "apple_app_attest") {
    throw new GatewayError(
      403,
      "auth_method_not_supported",
      "Issuer token exchange is not supported for this app",
    );
  }
  return app.authentication;
}

/**
 * Who an App Attest request acts for, which is the application's own choice
 * rather than the client's. Under `issuer` the user is whoever the presented
 * token names; under `app_install` the attested key *is* the identity, so the
 * key id is the user id and there is no token to present.
 *
 * A token sent to an `app_install` application is refused rather than ignored:
 * a client presenting one believes it is authenticating a person, and quietly
 * handing it an installation-scoped identity instead would file that user's
 * traffic — and their limits, and their block — under the wrong subject.
 *
 * `trusted` says whether the id has been proved yet. An issuer's has: the token
 * was verified to get it. An `app_install` id is the caller's own `key_id` and
 * is proved only once the attestation or assertion verifies against it, so it
 * must not be written to the auth-event row before then — an unauthenticated
 * caller could otherwise name any string and have the failure filed against it.
 */
async function attestedUserId(
  endUser: AppAttestEndUser,
  body: { issuer_token?: string; key_id: string },
): Promise<{ userId: string; trusted: boolean }> {
  if (endUser.source === "app_install") {
    if (body.issuer_token !== undefined) {
      throw new GatewayError(
        400,
        "invalid_request",
        "This application identifies users by app installation, so issuer_token is not accepted",
      );
    }
    return { userId: body.key_id, trusted: false };
  }
  if (body.issuer_token === undefined) {
    throw new GatewayError(400, "invalid_request", "issuer_token is required");
  }
  const { userId } = await verifyIssuerToken(body.issuer_token, endUser.issuer);
  return { userId, trusted: true };
}

export async function storeAttestedUser(input: {
  env: Env;
  appId: string;
  userId: string;
  keyId: string;
  publicKeyPem: string;
  environment: AppAttestEnvironment;
}): Promise<void> {
  await database(input.env.DB)
    .insert(appUser)
    .values({
      appId: input.appId,
      id: input.userId,
      attestKeyId: input.keyId,
      attestPublicKey: input.publicKeyPem,
      attestCounter: 0,
      attestEnvironment: input.environment,
      lastSeenAt: sql`datetime('now')`,
    })
    .onConflictDoUpdate({
      target: [appUser.appId, appUser.id],
      set: {
        attestKeyId: input.keyId,
        attestPublicKey: input.publicKeyPem,
        attestCounter: 0,
        attestEnvironment: input.environment,
        lastSeenAt: sql`datetime('now')`,
      },
    });
}

/**
 * Upserts the issuer identity and reports whether it was waiting on a claim.
 *
 * The pending timestamp comes back from the same statement rather than from a
 * second read: `RETURNING` answers with the row's post-update values and this
 * update never touches that column, so what it returns is the window that was
 * already open — which is exactly what {@link settleClaimDelay} needs.
 */
async function storeIssuerUser(
  env: Env,
  appId: string,
  userId: string,
): Promise<{ claimPendingSince: string | null }> {
  const [user] = await database(env.DB)
    .insert(appUser)
    .values({ appId, id: userId, lastSeenAt: sql`datetime('now')` })
    .onConflictDoUpdate({
      target: [appUser.appId, appUser.id],
      set: { lastSeenAt: sql`datetime('now')` },
      setWhere: eq(appUser.status, "active"),
    })
    .returning({ status: appUser.status, claimPendingSince: appUser.claimPendingSince });
  if (!user || user.status !== "active") {
    throw new GatewayError(403, "auth_required", "User is blocked");
  }
  return { claimPendingSince: user.claimPendingSince };
}

async function assertExistingUserActive(
  env: Env,
  appId: string,
  userId: string,
): Promise<{ claimPendingSince: string | null }> {
  const user = await database(env.DB).query.appUser.findFirst({
    columns: { status: true, claimPendingSince: true },
    where: and(eq(appUser.appId, appId), eq(appUser.id, userId)),
  });
  if (user?.status !== undefined && user.status !== "active") {
    throw new GatewayError(403, "auth_required", "User is blocked");
  }
  return { claimPendingSince: user?.claimPendingSince ?? null };
}

/**
 * Opens a claim-propagation window for a user the issuer vouched for but whose
 * entitlement claim has not arrived yet.
 *
 * Only if one is not already open: the metric is the wait from the *first*
 * rejection, and a client retrying every few seconds would otherwise keep
 * resetting it to zero. Inserts the row when the user has never been seen,
 * which is the common shape of this incident — the purchase is the first thing
 * the user does, so the gateway has no record of them yet.
 *
 * Never throws: this is measurement, and the request has already been refused.
 */
async function markClaimPending(env: Env, appId: string, userId: string): Promise<void> {
  try {
    await database(env.DB)
      .insert(appUser)
      .values({ appId, id: userId, claimPendingSince: sql`datetime('now')` })
      .onConflictDoUpdate({
        target: [appUser.appId, appUser.id],
        set: { claimPendingSince: sql`datetime('now')` },
        // Blocked users are excluded: no exchange of theirs can ever succeed, so
        // a window opened for one would stay open forever and inflate the count
        // of people the operator is supposed to be waiting on.
        setWhere: and(isNull(appUser.claimPendingSince), eq(appUser.status, "active")),
      });
  } catch (error) {
    log("warn", "claim_pending_mark_failed", {
      app: appId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Closes an open claim-propagation window, returning how long it stayed open.
 *
 * `datetime('now')` is UTC without a zone marker, so it is read back as one.
 *
 * Never throws, for the same reason {@link markClaimPending} does not — and with
 * more at stake. This runs on the *success* path, after the App Attest key has
 * been stored or the assertion counter advanced, so letting a transient D1
 * failure escape would turn a completed authentication into a 500 and cost the
 * client work it has already done. A failure here loses one measurement and
 * leaves the window open; the user's next successful exchange closes it.
 */
async function settleClaimDelay(
  env: Env,
  appId: string,
  userId: string,
  pendingSince: string | null,
): Promise<number | null> {
  if (pendingSince === null) return null;
  const openedAt = Date.parse(`${pendingSince.replace(" ", "T")}Z`);
  if (Number.isNaN(openedAt)) return null;
  const delayMs = Math.max(0, Date.now() - openedAt);
  try {
    await database(env.DB)
      .update(appUser)
      .set({ claimPendingSince: null })
      .where(and(eq(appUser.appId, appId), eq(appUser.id, userId)));
  } catch (error) {
    log("warn", "claim_settle_failed", {
      app: appId,
      userId,
      delayMs,
      error: error instanceof Error ? error.message : String(error),
    });
    // Not reported as recovered, and not recorded on the event: a window that
    // is still open has not been measured, and a figure written next to one
    // would be counted again when the window really does close.
    return null;
  }
  log("info", "claim_propagation_recovered", { app: appId, userId, delayMs });
  return delayMs;
}

/**
 * What a handler learns about the attempt as it runs, for the event row it will
 * produce either way. Mutable because the interesting facts — which client
 * proof was used, whose identity the issuer vouched for — are only known part
 * way through, and the row has to be written from the failure path too.
 */
interface AuthAttempt {
  authMethod: AuthMethod | null;
  userId: string | null;
  claimDelayMs: number | null;
}

/**
 * Wraps one authentication handler so every attempt, successful or refused,
 * leaves exactly one `app_auth_event` row behind.
 *
 * Failures are recorded and rethrown unchanged: the client contract is
 * untouched, and `app.onError` still logs and serializes the error. Recording
 * happens in `waitUntil` so neither path waits on a diagnostic write.
 */
async function recorded(
  c: Context<{ Bindings: Env }>,
  event: AuthEventName,
  handler: (attempt: AuthAttempt) => Promise<Response>,
): Promise<Response> {
  const startedAt = Date.now();
  const appId = c.req.param("app") ?? "";
  const appVersion = c.req.header("x-app-version") ?? null;
  const attempt: AuthAttempt = { authMethod: null, userId: null, claimDelayMs: null };
  const record = (outcome: string, reason?: string): void => {
    // An app that does not exist has nothing to attribute a row to, and
    // recording one would let anyone grow this table with invented app ids.
    if (outcome === "app_not_found") return;
    c.executionCtx.waitUntil(recordAuthEvent({
      env: c.env,
      appId,
      event,
      userId: attempt.userId,
      authMethod: attempt.authMethod,
      outcome,
      reason,
      appVersion,
      latencyMs: Date.now() - startedAt,
      claimDelayMs: attempt.claimDelayMs,
    }));
  };

  try {
    const response = await handler(attempt);
    record("ok");
    return response;
  } catch (error) {
    const gateway = error instanceof GatewayError ? error : null;
    // The verified user id travels on the error for exactly this: a
    // claims-missing rejection is the one failure that knows who it refused.
    attempt.userId = attempt.userId ?? gateway?.userId ?? null;
    if (gateway?.code === "issuer_claims_missing" && attempt.userId) {
      c.executionCtx.waitUntil(markClaimPending(c.env, appId, attempt.userId));
    }
    record(gateway?.code ?? "internal_error", gateway?.reason);
    throw error;
  }
}

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.post("/challenge", async (c) => {
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadAppConfig(c.env, appId);
  assertAppActive(app);
  appleAuth(app);
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const challenge = btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
  await database(c.env.DB).insert(appAuthChallenge).values({
    challenge,
    appId,
    expiresAt: sql`datetime('now', '+5 minutes')`,
  });
  // One issued challenge in a hundred pays for a sweep of the expired ones, off
  // the response path. The nightly cron does the same thing; this keeps the
  // table small where no cron runs at all, such as local development.
  if (Math.random() < 0.01) {
    c.executionCtx.waitUntil(
      pruneAuthChallenges(c.env).catch((error: unknown) => {
        log("warn", "auth_challenges_prune_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  }
  return c.json({ challenge, expires_in: 300 });
});

authRoutes.post("/register", (c) => recorded(c, "register", async (attempt) => {
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadAppConfig(c.env, appId);
  assertAppActive(app);
  const auth = appleAuth(app);
  attempt.authMethod = "attest";
  const body = schemaBody(AppAttestRegisterRequestSchema, await c.req.json());
  const { userId, trusted } = await attestedUserId(auth.end_user, body);
  if (trusted) attempt.userId = userId;
  // Do not spend a challenge or ask Apple to attest a replacement key for a
  // user whom the operator has blocked.
  const { claimPendingSince } = await assertExistingUserActive(c.env, appId, userId);
  await consumeChallenge(c.env, appId, body.challenge);
  // Imported here rather than at the top of the module: App Attest verification
  // pulls in pkijs, asn1js and cbor-x, which would otherwise be parsed at every
  // isolate cold start for the sake of these two handlers.
  const { verifyAppAttestation } = await import("../core/appattest");
  const verifiedAttestation = await verifyAppAttestation({
    appId: `${auth.app_attest.team_id}.${auth.app_attest.bundle_id}`,
    allowedEnvironments: auth.app_attest.environments,
    keyId: body.key_id,
    challenge: body.challenge,
    attestation: body.attestation,
  });
  // Proved now: the attestation verified against this very key id, so recording
  // it as the attempt's identity no longer takes the caller's word for it.
  attempt.userId = userId;
  await storeAttestedUser({
    env: c.env,
    appId,
    userId,
    keyId: body.key_id,
    publicKeyPem: verifiedAttestation.publicKeyPem,
    environment: verifiedAttestation.environment,
  });
  attempt.claimDelayMs = await settleClaimDelay(c.env, appId, userId, claimPendingSince);
  return c.json({ user_id: userId });
}));

authRoutes.post("/token", (c) => recorded(c, "token_exchange", async (attempt) => {
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadAppConfig(c.env, appId);
  assertAppActive(app);
  const rawBody = objectBody(await c.req.json());

  if ("api_key" in rawBody) {
    if (app.authentication.type !== "api_key") {
      throw new GatewayError(
        400,
        "auth_method_not_supported",
        "API key token exchange is not supported for this app",
      );
    }
    const issuer = endUserIssuer(app.authentication);
    if (!issuer) {
      throw new GatewayError(
        400,
        "auth_method_not_supported",
        "API key token exchange requires an issuer end-user source",
      );
    }
    attempt.authMethod = "api_key";
    const body = schemaBody(ApiKeyTokenRequestSchema, rawBody);
    // Token exchange is a security boundary where revocation must take effect
    // immediately. Issuer-less data-plane authentication keeps the short
    // verification cache, but an exchange always confirms the key's current
    // status against D1.
    const apiKeyRecord = await lookupApiKeyUncached(c.env, body.api_key);
    if (!apiKeyRecord || apiKeyRecord.appId !== appId) {
      throw new GatewayError(403, "auth_required", "Gateway API key was rejected");
    }
    const apiKeyId = apiKeyRecord.id;
    const { userId } = await verifyIssuerToken(body.issuer_token, issuer);
    attempt.userId = userId;
    const { claimPendingSince } = await storeIssuerUser(c.env, appId, userId);
    attempt.claimDelayMs = await settleClaimDelay(c.env, appId, userId, claimPendingSince);
    const issued = await issueGatewayToken(
      c.env.JWT_SECRET,
      appId,
      userId,
      "api_key",
      accessTtl(),
      { apiKeyId },
    );
    return c.json({ access_token: issued.token, expires_in: issued.expiresIn });
  }

  if (app.authentication.type === "api_key") {
    throw new GatewayError(
      400,
      "invalid_request",
      endUserIssuer(app.authentication)
        ? "api_key and issuer_token are required"
        : "API key token exchange requires an issuer end-user source",
    );
  }

  const auth = appleAuth(app);
  attempt.authMethod = "attest";
  const body = schemaBody(AppAttestTokenRequestSchema, rawBody);
  const { userId, trusted } = await attestedUserId(auth.end_user, body);
  if (trusted) attempt.userId = userId;
  const user = await database(c.env.DB).query.appUser.findFirst({
    columns: {
      attestKeyId: true,
      attestPublicKey: true,
      attestCounter: true,
      attestEnvironment: true,
      status: true,
      // Read alongside the key material rather than in a second round trip:
      // this branch already has to fetch the row.
      claimPendingSince: true,
    },
    where: and(eq(appUser.appId, appId), eq(appUser.id, userId)),
  });
  if (user?.status !== undefined && user.status !== "active") {
    throw new GatewayError(403, "auth_required", "User is blocked");
  }
  if (!user || user.attestKeyId !== body.key_id || !user.attestPublicKey) {
    throw new GatewayError(403, "attest_failed", "No matching registered App Attest key");
  }
  // Withdrawing an environment has to stop the keys it admitted, not just new
  // registrations: an assertion carries no aaguid, so the environment the key
  // was registered in is the only record of it. Null predates the column and
  // can only be production, which no application can refuse.
  if (
    user.attestEnvironment !== null &&
    !auth.app_attest.environments.includes(user.attestEnvironment)
  ) {
    throw new GatewayError(403, "attest_failed", "The registered App Attest environment is no longer allowed");
  }
  await consumeChallenge(c.env, appId, body.challenge);
  const { verifyAppAssertion } = await import("../core/appattest");
  const counter = await verifyAppAssertion({
    gatewayAppId: appId,
    rpId: `${auth.app_attest.team_id}.${auth.app_attest.bundle_id}`,
    keyId: body.key_id,
    challenge: body.challenge,
    assertion: body.assertion,
    publicKeyPem: user.attestPublicKey,
    previousCounter: user.attestCounter,
  });
  const updated = await database(c.env.DB)
    .update(appUser)
    .set({ attestCounter: counter, lastSeenAt: sql`datetime('now')` })
    .where(and(
      eq(appUser.appId, appId),
      eq(appUser.id, userId),
      lt(appUser.attestCounter, counter),
    ))
    .returning({ id: appUser.id });
  if (updated.length !== 1) {
    throw new GatewayError(403, "attest_failed", "App Attest assertion counter was replayed");
  }
  // Proved now: the assertion verified against the stored public key for this
  // key id, so the identity is the gateway's own conclusion rather than a
  // string the caller supplied.
  attempt.userId = userId;
  attempt.claimDelayMs = await settleClaimDelay(c.env, appId, userId, user.claimPendingSince);
  const issued = await issueGatewayToken(c.env.JWT_SECRET, appId, userId, "attest", accessTtl());
  return c.json({ access_token: issued.token, expires_in: issued.expiresIn });
}));
