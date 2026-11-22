/**
 * App sign-in: `/v2/apps/{app}/auth/challenge`, `/register`, `/token` and
 * `/failure`. Same bodies and behaviour as v1's `/v1/apps/{app}/auth/*`.
 *
 * Every register and token attempt, successful or refused, leaves one auth
 * event. Each route is flood-limited per app and network address before any
 * D1 read, and a refused flood request records nothing.
 */
import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import { assertAppActive, loadApp } from "../apps/app-records.ts";
import { clientAuth, type ExchangeType, type TokenExchange } from "../client-auth/client-auth.ts";
import {
  CHALLENGE_TTL_SECONDS,
  markChallengeAttempted,
  recordAuthEvent,
  settleExpiredChallenges,
} from "../client-auth/auth-events.ts";
import { EXCHANGES, type AuthAttempt, type IssuedToken } from "../client-auth/token-exchange.ts";
import { AppAttestFailureReportSchema } from "../contracts/auth.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { contained } from "../core/background.ts";
import { clientNetwork } from "../core/client-network.ts";
import { CLIENT_SDK_HEADER, storedClientSdk } from "../core/client-sdk.ts";
import { storedAppVersion } from "../core/app-version.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError, type ErrorCode, type GatewayErrorReason } from "../core/errors.ts";
import { clientAddress, enforceEndpointRateLimit, type EndpointRateLimitName } from "../core/flood-limit.ts";
import { log } from "../core/log.ts";
import { asGatewayError } from "../core/platform-errors.ts";
import type { AppRecord } from "../core/types.ts";
import { database } from "../db/index.ts";
import { appAuthChallenge, type AuthEventName } from "../db/schema.ts";
import { jsonObject, readBody } from "../http/body.ts";
import type { DeadlineVariables } from "../http/deadline.ts";

type AuthContext = Context<{ Bindings: Env; Variables: DeadlineVariables }>;

/** The largest sign-in body: an attestation is a few kilobytes, an AppTransaction up to 16 KiB. */
const AUTH_BODY_LIMIT = 256 * 1024;

/** Parses a body with a schema, refusing with the first problem. */
export function parseRequest<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
  throw new GatewayError(400, "invalid_request", `${where}${issue?.message ?? "The request body is invalid"}`);
}

async function jsonObjectBody(c: AuthContext): Promise<Record<string, unknown>> {
  return jsonObject(await readBody(c.req.raw, AUTH_BODY_LIMIT));
}

function appIdOf(c: AuthContext): string {
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  return appId;
}

/** The refusal an app that registers no App Attest keys gives these routes. */
function attestNotSupported(): GatewayError {
  return new GatewayError(403, "auth_method_not_supported", "Issuer token exchange is not supported for this app");
}

function assertAppAttest(app: AppRecord): void {
  if (clientAuth(app).exchange?.type !== "app_attest") throw attestNotSupported();
}

async function exchangeToken<K extends ExchangeType>(input: {
  env: Env;
  appId: string;
  exchange: TokenExchange<K>;
  rawBody: Record<string, unknown>;
  attempt: AuthAttempt;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<IssuedToken> {
  const handler = EXCHANGES[input.exchange.type];
  handler.refuseBody?.(input.rawBody);
  input.attempt.authMethod = handler.authMethod;
  const body = parseRequest(handler.tokenBody(input.exchange), input.rawBody);
  return handler.token({ ...input, body });
}

async function registerKey<K extends ExchangeType>(input: {
  env: Env;
  appId: string;
  exchange: TokenExchange<K>;
  rawBody: Record<string, unknown>;
  attempt: AuthAttempt;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<{ user_id: string }> {
  const handler = EXCHANGES[input.exchange.type];
  const { registration } = handler;
  if (!registration) throw attestNotSupported();
  input.attempt.authMethod = handler.authMethod;
  const body = parseRequest(registration.body(input.exchange), input.rawBody);
  return registration.run({ ...input, body });
}

/**
 * Runs one sign-in handler so every attempt leaves exactly one auth event.
 * The event is written in the background, so nothing waits on it. An attempt
 * still running when the deadline passes is recorded then, as the client got
 * its answer then, and not again when it finishes.
 */
async function recorded(
  c: AuthContext,
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
  const challenge = typeof rawBody.challenge === "string" && rawBody.challenge.length <= 200 ? rawBody.challenge : null;
  const attempt: AuthAttempt = { authMethod: null, userId: null, accountId: null };
  let settled = false;
  const record = (outcome: "ok" | ErrorCode, reason?: GatewayErrorReason): void => {
    if (settled) return;
    settled = true;
    // An app that does not exist has nothing to attribute a row to, and
    // recording one would let anyone grow this table with made-up app ids.
    if (outcome === "app_not_found") return;
    // A refused attempt may not have spent its challenge: marked, its expiry
    // is not counted again as abandoned.
    if (outcome !== "ok" && challenge !== null) {
      c.executionCtx.waitUntil(contained("challenge_attempted", markChallengeAttempted(c.env, appId, challenge)));
    }
    c.executionCtx.waitUntil(
      contained(
        "auth_event",
        recordAuthEvent({
          env: c.env,
          appId,
          accountId: attempt.accountId,
          event,
          userId: attempt.userId,
          authMethod: attempt.authMethod,
          outcome,
          reason: reason ?? null,
          appVersion,
          clientSdk,
          network,
          latencyMs: Date.now() - startedAt,
        }),
      ),
    );
  };

  const deadline = c.get("deadline");
  const recordDeadline = (): void => {
    const refusal = asGatewayError(deadline.reason);
    record(refusal?.code ?? "internal_error", refusal?.reason);
  };
  if (deadline.aborted) {
    recordDeadline();
    return new Response(null, { status: 503 });
  }
  deadline.addEventListener("abort", recordDeadline, { once: true });

  try {
    const response = await handler(attempt);
    record("ok");
    return response;
  } catch (error) {
    const gateway = asGatewayError(error);
    // An issuer token missing an entitlement claim is the one refusal that knows who it refused.
    attempt.userId = attempt.userId ?? gateway?.userId ?? null;
    record(gateway?.code ?? "internal_error", gateway?.reason);
    throw gateway ?? error;
  } finally {
    deadline.removeEventListener("abort", recordDeadline);
  }
}

/**
 * Limits one app's sign-in routes per network address, before any D1 read.
 * A refused request writes no auth event: recording it would give a flood a
 * database write per request.
 */
export function appAuthFloodLimit(
  policy: Extract<EndpointRateLimitName, `app_auth_${string}`>,
): MiddlewareHandler<{ Bindings: Env; Variables: DeadlineVariables }> {
  return async (c, next) => {
    await enforceEndpointRateLimit(c.env, policy, `${c.req.param("app") ?? ""}:${clientAddress(c.req.raw)}`);
    await next();
  };
}

export async function challengeHandler(c: AuthContext): Promise<Response> {
  const appId = appIdOf(c);
  const app = await loadApp(c.env, appId);
  assertAppActive(app);
  assertAppAttest(app);
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const challenge = btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
  const network = clientNetwork(c.req.raw);
  await database(c.env.DB)
    .insert(appAuthChallenge)
    .values({
      challenge,
      appId,
      expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000,
      appVersion: storedAppVersion(c.req.header("x-app-version") ?? null),
      clientSdk: storedClientSdk(c.req.header(CLIENT_SDK_HEADER) ?? null),
      networkAsn: network.asn,
      networkName: network.name,
    });
  // One challenge in a hundred also settles the expired ones, so the table
  // stays small where no cron runs, such as local development.
  if (Math.random() < 0.01) {
    c.executionCtx.waitUntil(
      settleExpiredChallenges(c.env.DB).catch((error: unknown) => {
        log("warn", "auth_challenges_prune_failed", { error: errorFacts(error) });
      }),
    );
  }
  return c.json({
    challenge,
    expires_in: CHALLENGE_TTL_SECONDS,
    accepts_app_transaction: true,
  } satisfies OperationResponse<"appAuthChallenge">);
}

/** A reported error's domain, kept only when it is a short token. */
const ERROR_DOMAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function errorPart(error: { domain: string; code: number }): string {
  return `${ERROR_DOMAIN.test(error.domain) ? error.domain : "other"}:${error.code}`;
}

/** `<step>:<domain>:<code>`, plus `>` and the underlying error, such as `attest_key:com.apple.devicecheck.error:3>NSURLErrorDomain:-1001`. */
function failureReason(report: z.output<typeof AppAttestFailureReportSchema>): string {
  const underlying = report.underlying_error === undefined ? "" : `>${errorPart(report.underlying_error)}`;
  return `${report.step}:${errorPart(report.error)}${underlying}`;
}

/**
 * A step that failed on the device after a challenge was issued. Diagnostic
 * only, and bounded: it must name an unspent challenge of this app, and
 * spends it, so one challenge carries at most one report. Answers
 * `recorded: false` for a challenge it does not hold.
 */
export async function failureHandler(c: AuthContext): Promise<Response> {
  const appId = appIdOf(c);
  const report = parseRequest(AppAttestFailureReportSchema, await jsonObjectBody(c));
  // The report is recorded under the account that owns the app now, read
  // before the challenge is spent: an app gone since holds no challenges.
  const app = await loadApp(c.env, appId).catch(() => null);
  if (app === null) return c.json({ recorded: false } satisfies OperationResponse<"appAuthFailure">);
  const [issued] = await database(c.env.DB)
    .delete(appAuthChallenge)
    .where(and(eq(appAuthChallenge.challenge, report.challenge), eq(appAuthChallenge.appId, appId)))
    .returning({
      expiresAt: appAuthChallenge.expiresAt,
      appVersion: appAuthChallenge.appVersion,
      clientSdk: appAuthChallenge.clientSdk,
    });
  if (issued === undefined) return c.json({ recorded: false } satisfies OperationResponse<"appAuthFailure">);
  const issuedAt = issued.expiresAt - CHALLENGE_TTL_SECONDS * 1000;
  await recordAuthEvent({
    env: c.env,
    appId,
    accountId: app.accountId,
    event: "challenge",
    outcome: report.recovered === true ? "client_recovered" : "client_failed",
    reason: failureReason(report),
    appVersion: c.req.header("x-app-version") ?? issued.appVersion,
    clientSdk: c.req.header(CLIENT_SDK_HEADER) ?? issued.clientSdk,
    network: clientNetwork(c.req.raw),
    // From the challenge to the report: how long the device spent on the step that failed.
    latencyMs: Math.max(0, Date.now() - issuedAt),
  });
  return c.json({ recorded: true } satisfies OperationResponse<"appAuthFailure">);
}

export async function registerHandler(c: AuthContext): Promise<Response> {
  const rawBody = await jsonObjectBody(c);
  return recorded(c, "register", rawBody, async (attempt) => {
    const appId = appIdOf(c);
    const app = await loadApp(c.env, appId);
    attempt.accountId = app.accountId;
    assertAppActive(app);
    const { exchange } = clientAuth(app);
    if (exchange === null) throw attestNotSupported();
    const waitUntil = (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise);
    const registered = await registerKey({ env: c.env, appId, exchange, rawBody, attempt, waitUntil });
    return c.json(registered satisfies OperationResponse<"appAuthRegister">);
  });
}

export async function tokenHandler(c: AuthContext): Promise<Response> {
  const rawBody = await jsonObjectBody(c);
  return recorded(c, "token_exchange", rawBody, async (attempt) => {
    const appId = appIdOf(c);
    const app = await loadApp(c.env, appId);
    attempt.accountId = app.accountId;
    assertAppActive(app);
    const { exchange } = clientAuth(app);
    if (exchange === null) {
      throw new GatewayError(400, "auth_method_not_supported", "API key token exchange requires an issuer end-user source");
    }
    const waitUntil = (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise);
    const issued = await exchangeToken({ env: c.env, appId, exchange, rawBody, attempt, waitUntil });
    return c.json({
      access_token: issued.token,
      expires_in: issued.expiresIn,
      // So the Swift package follows the app's setting without one of its own.
      ...(exchange.type === "app_attest" ? { verify_on: exchange.authentication.app_attest.verify_on } : {}),
    } satisfies OperationResponse<"appAuthToken">);
  });
}
