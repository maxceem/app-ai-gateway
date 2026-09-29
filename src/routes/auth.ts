import { Hono, type Context } from "hono";
import { sql } from "drizzle-orm";
import { pruneAuthChallenges, recordAuthEvent } from "../client-auth/auth-events";
import { assertAppActive, loadApp } from "../core/app-records";
import { clientAddress, enforceEndpointRateLimit } from "../core/endpoint-rate-limit";
import { GatewayError } from "../core/errors";
import { log } from "../core/log";
import { clientAuth, type ExchangeType, type TokenExchange } from "../client-auth/client-auth";
import {
  EXCHANGES,
  markClaimPending,
  type AuthAttempt,
  type IssuedToken,
} from "../client-auth/token-exchange";
import type { AppRecord } from "../core/types";
import { database } from "../db";
import { parseRequest } from "../management/validation";
import { jsonBody } from "./admin/body";
import { appAuthChallenge, type AuthEventName } from "../db/schema";

/** A JSON body that is an object, which every documented body on this surface is. */
async function jsonObjectBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const value = await jsonBody(c);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
  return value as Record<string, unknown>;
}

/** The refusal an application that registers no App Attest keys gives the routes that do. */
function attestNotSupported(): GatewayError {
  return new GatewayError(
    403,
    "auth_method_not_supported",
    "Issuer token exchange is not supported for this app",
  );
}

/** Refuses the challenge route to an application that is not App Attest. */
function assertAppAttest(app: AppRecord): void {
  if (clientAuth(app).exchange?.type !== "app_attest") throw attestNotSupported();
}

/**
 * The application's exchange, run on a `/auth/token` body. Generic in the
 * exchange type so the handler, the schema it parses with and the
 * configuration it is handed all belong to the same exchange.
 */
async function exchangeToken<K extends ExchangeType>(input: {
  env: Env;
  appId: string;
  exchange: TokenExchange<K>;
  rawBody: Record<string, unknown>;
  attempt: AuthAttempt;
}): Promise<IssuedToken> {
  const { exchange, attempt } = input;
  const handler = EXCHANGES[exchange.type];
  handler.refuseBody?.(input.rawBody);
  attempt.authMethod = handler.authMethod;
  const body = parseRequest(handler.tokenBody(exchange), input.rawBody);
  return handler.token({ env: input.env, appId: input.appId, exchange, body, attempt });
}

/** The application's key registration, run on a `/auth/register` body, or the refusal where its exchange has none. */
async function registerKey<K extends ExchangeType>(input: {
  env: Env;
  appId: string;
  exchange: TokenExchange<K>;
  rawBody: Record<string, unknown>;
  attempt: AuthAttempt;
}): Promise<{ user_id: string }> {
  const { exchange, attempt } = input;
  const handler = EXCHANGES[exchange.type];
  const { registration } = handler;
  if (!registration) throw attestNotSupported();
  attempt.authMethod = handler.authMethod;
  const body = parseRequest(registration.body(exchange), input.rawBody);
  return registration.run({ env: input.env, appId: input.appId, exchange, body, attempt });
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

/**
 * Bounds flooding of one application's unauthenticated authentication routes
 * from one network address.
 *
 * Counted per application *and* address, so a flood aimed at one app never
 * spends another app's allowance, and the `scope` on the refusal names the
 * endpoint its developer has to look at.
 *
 * Deliberately outside `recorded`: a refused request is not an authentication
 * attempt, and it is the one request that must not write an `app_auth_event`
 * row. Recording it would give a flood a database write per request, which is
 * exactly the cost this limit exists to refuse, and would bury the app's real
 * failures under rows nobody acted on. For the same reason it runs before the
 * app is loaded, so a flood aimed at an invented app id costs no read either.
 */
async function enforceAppAuthLimit(
  c: Context<{ Bindings: Env }>,
  policy: "app_auth_challenge" | "app_auth_register" | "app_auth_token",
): Promise<void> {
  const appId = c.req.param("app") ?? "";
  await enforceEndpointRateLimit(c.env, policy, `${appId}:${clientAddress(c.req.raw)}`);
}

authRoutes.post("/challenge", async (c) => {
  await enforceAppAuthLimit(c, "app_auth_challenge");
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadApp(c.env, appId);
  assertAppActive(app);
  assertAppAttest(app);
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
      pruneAuthChallenges(c.env.DB).catch((error: unknown) => {
        log("warn", "auth_challenges_prune_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  }
  return c.json({ challenge, expires_in: 300 });
});

authRoutes.post("/register", async (c) => {
  await enforceAppAuthLimit(c, "app_auth_register");
  const rawBody = await jsonObjectBody(c);
  return recorded(c, "register", async (attempt) => {
    const appId = c.req.param("app");
    if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
    const app = await loadApp(c.env, appId);
    assertAppActive(app);
    const { exchange } = clientAuth(app);
    if (exchange === null) throw attestNotSupported();
    return c.json(await registerKey({ env: c.env, appId, exchange, rawBody, attempt }));
  });
});

authRoutes.post("/token", async (c) => {
  await enforceAppAuthLimit(c, "app_auth_token");
  const rawBody = await jsonObjectBody(c);
  return recorded(c, "token_exchange", async (attempt) => {
    const appId = c.req.param("app");
    if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
    const app = await loadApp(c.env, appId);
    assertAppActive(app);
    const { exchange } = clientAuth(app);
    if (exchange === null) {
      throw new GatewayError(
        400,
        "auth_method_not_supported",
        "API key token exchange requires an issuer end-user source",
      );
    }
    const issued = await exchangeToken({ env: c.env, appId, exchange, rawBody, attempt });
    return c.json({ access_token: issued.token, expires_in: issued.expiresIn });
  });
});
