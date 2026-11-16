import { Hono, type Context, type MiddlewareHandler } from "hono";
import { and, eq, sql } from "drizzle-orm";
import {
  CHALLENGE_TTL_SECONDS,
  markChallengeAttempted,
  recordAuthEvent,
  settleExpiredChallenges,
} from "../client-auth/auth-events";
import { clientNetwork } from "../core/client-network";
import { storedAppVersion } from "../core/app-version";
import { storedClientSdk } from "../core/client-sdk";
import { assertAppActive, loadApp } from "../core/app-records";
import { CLIENT_SDK_HEADER } from "../core/client-sdk";
import { clientAddress, enforceEndpointRateLimit } from "../core/endpoint-rate-limit";
import { GatewayError, type ErrorCode, type GatewayErrorReason } from "../core/errors";
import { log } from "../core/log";
import { asGatewayError } from "../core/platform-errors";
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
import { AppAttestFailureReportSchema } from "../contracts/schemas";
import { appAuthChallenge, type AuthEventName } from "../db/schema";
import type { RequestVariables } from "../middleware/request-scope";
import { errorFacts } from "../core/error-facts";
import { contained } from "../core/background";

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
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<IssuedToken> {
  const { exchange, attempt } = input;
  const handler = EXCHANGES[exchange.type];
  handler.refuseBody?.(input.rawBody);
  attempt.authMethod = handler.authMethod;
  const body = parseRequest(handler.tokenBody(exchange), input.rawBody);
  return handler.token({ env: input.env, appId: input.appId, exchange, body, attempt, waitUntil: input.waitUntil });
}

/** The application's key registration, run on a `/auth/register` body, or the refusal where its exchange has none. */
async function registerKey<K extends ExchangeType>(input: {
  env: Env;
  appId: string;
  exchange: TokenExchange<K>;
  rawBody: Record<string, unknown>;
  attempt: AuthAttempt;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<{ user_id: string }> {
  const { exchange, attempt } = input;
  const handler = EXCHANGES[exchange.type];
  const { registration } = handler;
  if (!registration) throw attestNotSupported();
  attempt.authMethod = handler.authMethod;
  const body = parseRequest(registration.body(exchange), input.rawBody);
  return registration.run({ env: input.env, appId: input.appId, exchange, body, attempt, waitUntil: input.waitUntil });
}

/**
 * Wraps one authentication handler so every attempt, successful or refused,
 * leaves exactly one `app_auth_event` row behind.
 *
 * Failures are recorded and rethrown, a platform failure as the
 * `service_unavailable` it is answered with, so `app.onError` still logs and
 * serializes the error. Recording happens in `waitUntil` so neither path waits
 * on a diagnostic write.
 *
 * An attempt that runs past the request's deadline is recorded when the
 * deadline passes, since the client has its answer then, and not again should
 * the abandoned call finish afterwards.
 */
async function recorded(
  c: Context<{ Bindings: Env; Variables: RequestVariables }>,
  event: AuthEventName,
  rawBody: Record<string, unknown>,
  handler: (attempt: AuthAttempt) => Promise<Response>,
): Promise<Response> {
  const startedAt = Date.now();
  const appId = c.req.param("app") ?? "";
  const appVersion = c.req.header("x-app-version") ?? null;
  const clientSdk = c.req.header(CLIENT_SDK_HEADER) ?? null;
  const network = clientNetwork(c.req.raw);
  // Only a value the challenge route could have issued is worth a lookup.
  const challenge = typeof rawBody.challenge === "string" && rawBody.challenge.length <= 200
    ? rawBody.challenge
    : null;
  const attempt: AuthAttempt = { authMethod: null, userId: null, claimDelayMs: null };
  let settled = false;
  const record = (outcome: "ok" | ErrorCode, reason?: GatewayErrorReason): void => {
    if (settled) return;
    settled = true;
    // An app that does not exist has nothing to attribute a row to, and
    // recording one would let anyone grow this table with invented app ids.
    if (outcome === "app_not_found") return;
    // A refused attempt may not have spent its challenge, and has just been
    // recorded on its own: marked, the challenge is not counted again as
    // abandoned when it expires.
    if (outcome !== "ok" && challenge !== null) {
      c.executionCtx.waitUntil(contained("challenge_attempted", markChallengeAttempted(c.env, appId, challenge)));
    }
    c.executionCtx.waitUntil(contained("auth_event", recordAuthEvent({
      env: c.env,
      appId,
      event,
      userId: attempt.userId,
      authMethod: attempt.authMethod,
      outcome,
      reason,
      appVersion,
      clientSdk,
      network,
      latencyMs: Date.now() - startedAt,
      claimDelayMs: attempt.claimDelayMs,
    })));
  };

  const deadline = c.get("deadline");
  const recordDeadline = (): void => {
    const refusal = asGatewayError(deadline?.reason);
    record(refusal?.code ?? "internal_error", refusal?.reason);
  };
  if (deadline?.aborted) {
    // Reached only after the client was answered — the steps in front of this
    // one took the whole deadline. The attempt is recorded as what the client
    // got and not started: nobody is waiting for its result, and starting it
    // would spend a challenge and write rows for an answer never read.
    recordDeadline();
    return new Response(null, { status: 503 });
  }
  deadline?.addEventListener("abort", recordDeadline, { once: true });

  try {
    const response = await handler(attempt);
    record("ok");
    return response;
  } catch (error) {
    const gateway = asGatewayError(error);
    // The verified user id travels on the error for exactly this: a
    // claims-missing rejection is the one failure that knows who it refused.
    attempt.userId = attempt.userId ?? gateway?.userId ?? null;
    // Not for an attempt the deadline already settled: a retry may have
    // succeeded and closed the window since, which this would reopen.
    if (!settled && gateway?.code === "issuer_claims_missing" && attempt.userId) {
      c.executionCtx.waitUntil(contained("claim_pending", markClaimPending(c.env, appId, attempt.userId)));
    }
    record(gateway?.code ?? "internal_error", gateway?.reason);
    throw gateway ?? error;
  }
}

export const authRoutes = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

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
 * failures under rows nobody acted on. For the same reason it is mounted ahead
 * of the billing gate, which loads the app and its account, so a flood at an
 * invented app id on these three routes costs no read either.
 *
 * Mounted on each route's own pattern rather than by reading the path here, so
 * it matches exactly what the router hands to the route: a percent-encoded
 * spelling of the endpoint reaches the same handler, and is counted the same.
 */
export function appAuthRateLimit(
  policy: "app_auth_challenge" | "app_auth_register" | "app_auth_token" | "app_auth_failure",
): MiddlewareHandler<{ Bindings: Env; Variables: RequestVariables }> {
  return async (c, next) => {
    if (c.req.method === "POST") {
      await enforceEndpointRateLimit(c.env, policy, `${c.req.param("app") ?? ""}:${clientAddress(c.req.raw)}`);
    }
    await next();
  };
}

authRoutes.post("/challenge", async (c) => {
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadApp(c.env, appId);
  assertAppActive(app);
  assertAppAttest(app);
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const challenge = btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
  // Who asked is kept beside the challenge for the one case nobody comes back
  // for it: the `abandoned` event its expiry records can only describe this
  // request.
  const network = clientNetwork(c.req.raw);
  await database(c.env.DB).insert(appAuthChallenge).values({
    challenge,
    appId,
    expiresAt: sql`datetime('now', ${`+${CHALLENGE_TTL_SECONDS} seconds`})`,
    appVersion: storedAppVersion(c.req.header("x-app-version") ?? null),
    clientSdk: storedClientSdk(c.req.header(CLIENT_SDK_HEADER) ?? null),
    networkAsn: network.asn,
    networkName: network.name,
  });
  // One issued challenge in a hundred pays for a settling of the expired ones,
  // off the response path. The hourly cron does the same thing; this keeps the
  // table small where no cron runs at all, such as local development.
  if (Math.random() < 0.01) {
    c.executionCtx.waitUntil(
      settleExpiredChallenges(c.env.DB).catch((error: unknown) => {
        log("warn", "auth_challenges_prune_failed", {
          error: errorFacts(error),
        });
      }),
    );
  }
  return c.json({ challenge, expires_in: CHALLENGE_TTL_SECONDS, accepts_app_transaction: true });
});

/**
 * A step that failed on the device after it was handed a challenge, reported
 * by the app so the challenge's auth event can say why instead of only that
 * nothing came back.
 *
 * Unauthenticated by necessity: the device is reporting that it could not
 * prove itself. What makes it safe to accept is that it is diagnostic only and
 * bounded. It must name a challenge this app issued and nothing has spent, and
 * spends it, so one challenge carries at most one report and never also
 * becomes `abandoned`. It stores only the step and the error's domain and code,
 * each a short token, never text the device wrote. And it is rate limited per
 * address like the other routes here.
 *
 * Answers `recorded: false`, rather than an error, for a challenge it does not
 * hold: a client sends this without waiting on it, and has nothing to do about
 * either answer.
 */
authRoutes.post("/failure", async (c) => {
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const report = parseRequest(AppAttestFailureReportSchema, await jsonObjectBody(c));
  const [issued] = await database(c.env.DB)
    .delete(appAuthChallenge)
    .where(and(eq(appAuthChallenge.challenge, report.challenge), eq(appAuthChallenge.appId, appId)))
    .returning({
      expiresAt: appAuthChallenge.expiresAt,
      appVersion: appAuthChallenge.appVersion,
      clientSdk: appAuthChallenge.clientSdk,
    });
  if (issued === undefined) return c.json({ recorded: false });
  const issuedAt = Date.parse(`${issued.expiresAt.replace(" ", "T")}Z`) - CHALLENGE_TTL_SECONDS * 1000;
  await recordAuthEvent({
    env: c.env,
    appId,
    event: "challenge",
    outcome: report.recovered === true ? "client_recovered" : "client_failed",
    reason: failureReason(report),
    appVersion: c.req.header("x-app-version") ?? issued.appVersion,
    clientSdk: c.req.header(CLIENT_SDK_HEADER) ?? issued.clientSdk,
    network: clientNetwork(c.req.raw),
    // From the challenge to the report: how long the device spent on the step
    // that failed, such as an App Attest call left waiting on Apple.
    latencyMs: Number.isFinite(issuedAt) ? Math.max(0, Date.now() - issuedAt) : 0,
  });
  return c.json({ recorded: true });
});

/** A reported error's domain, kept only when it is a short token; anything else is `other`. */
const ERROR_DOMAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function errorPart(error: { domain: string; code: number }): string {
  return `${ERROR_DOMAIN.test(error.domain) ? error.domain : "other"}:${error.code}`;
}

/**
 * `<step>:<domain>:<code>`, and `>` and the underlying error's domain and code
 * where the report names one, such as
 * `attest_key:com.apple.devicecheck.error:3>NSURLErrorDomain:-1001`.
 */
function failureReason(report: {
  step: string;
  error: { domain: string; code: number };
  underlying_error?: { domain: string; code: number } | undefined;
}): string {
  const underlying = report.underlying_error === undefined ? "" : `>${errorPart(report.underlying_error)}`;
  return `${report.step}:${errorPart(report.error)}${underlying}`;
}

authRoutes.post("/register", async (c) => {
  const rawBody = await jsonObjectBody(c);
  return recorded(c, "register", rawBody, async (attempt) => {
    const appId = c.req.param("app");
    if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
    const app = await loadApp(c.env, appId);
    assertAppActive(app);
    const { exchange } = clientAuth(app);
    if (exchange === null) throw attestNotSupported();
    const waitUntil = (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise);
    return c.json(await registerKey({ env: c.env, appId, exchange, rawBody, attempt, waitUntil }));
  });
});

authRoutes.post("/token", async (c) => {
  const rawBody = await jsonObjectBody(c);
  return recorded(c, "token_exchange", rawBody, async (attempt) => {
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
    const waitUntil = (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise);
    const issued = await exchangeToken({ env: c.env, appId, exchange, rawBody, attempt, waitUntil });
    return c.json({
      access_token: issued.token,
      expires_in: issued.expiresIn,
      // Whether the client signs every request it sends this token with, so
      // the Swift package follows the application's setting without one of
      // its own.
      ...(exchange.type === "app_attest" ? { verify_on: exchange.authentication.app_attest.verify_on } : {}),
    });
  });
});
