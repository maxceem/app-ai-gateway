/**
 * The sign-in library (`@maxceem/cf-auth`), loaded on first use.
 *
 * A provider request signs nobody in through it, so nothing on its path may
 * import it: everything that needs the library asks for it through
 * {@link cfAuth}. Type-only imports are fine, because they are erased.
 * `@maxceem/cf-auth/schema` is fine too: the table definitions in
 * `../db/schema.ts` are on every request's path already.
 *
 * This is the only module that imports the library at run time.
 */
import type { AuthState, CfAuth, CfAuthError } from "@maxceem/cf-auth";
import { mgmtAuthTables } from "../db/schema.ts";
import { emailVerificationRequired } from "../core/account-standing.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError, type ErrorCode } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { BETTER_AUTH_MESSAGES } from "./better-auth-messages.ts";
import { gatewayOperationKinds, OPERATION_LIMITS } from "./operation-kinds.ts";
import { oauthClients } from "./oauth-clients.ts";
import {
  cimdEnabled,
  consoleOrigin,
  googleAuthEnabled,
  oauthIssuer,
  operationsRealm,
  registrationAllowed,
  setting,
  V2_PATH,
} from "./settings.ts";

let loaded: Promise<typeof import("@maxceem/cf-auth")> | undefined;

/**
 * The library, evaluated once per isolate. A failed load is forgotten, so a
 * passing failure does not answer every later request in the isolate.
 */
export const cfAuth = (): Promise<typeof import("@maxceem/cf-auth")> =>
  (loaded ??= import("@maxceem/cf-auth").catch((error: unknown) => {
    loaded = undefined;
    throw error;
  }));

/** Where Better Auth's own routes live: sign-up, sign-in, sign-out, the session. */
export const IDENTITY_BASE_PATH = `${V2_PATH}/auth`;
export const MANAGEMENT_KEY_PREFIX = "agw_mgmt_";
/** What an OAuth connection's tokens begin with. A bearer token is routed by its prefix. */
export const OAUTH_ACCESS_TOKEN_PREFIX = "agw_oat_";
export const OAUTH_REFRESH_TOKEN_PREFIX = "agw_ort_";
/** The header the console sends with every cookie-authenticated management call. */
export const CONSOLE_REQUEST_HEADER = "x-console-request";
/**
 * v2's own cookie names, so a v2 sign-in never collides with v1's on the same
 * host (v1's are `agw_identity_*`).
 */
export const IDENTITY_COOKIE_PREFIX = "agw2_identity";
/** The CLI (`agw` 2.0), registered as a built-in public OAuth client. */
export const CLI_CLIENT_ID = "agw-cli";
export const CLI_CLIENT_NAME = "agw";
/** The console pages the OAuth flows send a browser to (built with the console). */
export const CONSENT_PAGE_PATH = `${V2_PATH}/oauth/consent`;
export const DEVICE_PAGE_PATH = `${V2_PATH}/device`;

/** Where Google's callback goes when a relay sits in front of it. */
export function oauthRelayOrigin(env: Env): string | undefined {
  const raw = setting(env, "OAUTH_RELAY_URL");
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayError(503, "service_unavailable", "OAUTH_RELAY_URL must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GatewayError(503, "service_unavailable", "OAUTH_RELAY_URL must be an absolute http(s) URL");
  }
  return url.origin;
}

/** Refuses a registration in the shape Better Auth answers with. */
async function registrationDenied(onDenied?: () => void): Promise<never> {
  onDenied?.();
  // Better Auth's own error, reached through `import()` for the same reason
  // as the library: this only runs inside a Better Auth hook, so it is loaded.
  const { APIError } = await import("better-auth/api");
  throw APIError.from("FORBIDDEN", { code: "REGISTRATION_DISABLED", message: "signup disabled" });
}

/** Better Auth's log lines: only its fixed messages, never a value from the request. */
function reportBetterAuthLog(requestId: string | null, level: "debug" | "info" | "warn" | "error", message: string, ...args: unknown[]): void {
  const error = args.find((arg) => arg instanceof Error);
  log(level === "debug" ? "info" : level, "better_auth_log", {
    ray: requestId ?? undefined,
    betterAuth: BETTER_AUTH_MESSAGES.has(message) ? message : undefined,
    ...(error === undefined ? {} : { error: errorFacts(error) }),
  });
}

/**
 * Marks the address of a person about to be made as waiting to be verified,
 * where the deployment verifies addresses (`../core/account-standing.ts`).
 * It runs before the person is written, so before their account and its
 * membership exist: no request can see the account unmarked. Only a person
 * whose address is not verified yet: a password sign-up. Google's arrive
 * verified, and a key-made account never comes here. Never an address that
 * already belongs to someone: a sign-up attempt with another person's address
 * must not hold their account back.
 *
 * If the mark cannot be written, the account serves, as every unmarked one
 * does, and the failure is logged for the monitor: never an account refused
 * that should serve.
 */
async function markPendingVerification(db: D1Database, email: string): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO email_pending_verification(email, marked_at)
         SELECT lower(?1), ?2 WHERE NOT EXISTS (SELECT 1 FROM mgmt_user WHERE email = ?1 COLLATE NOCASE)`,
      )
      .bind(email, Date.now())
      .run();
  } catch (error) {
    log("warn", "email_pending_mark_failed", { error: errorFacts(error) });
  }
}

export interface IdentityOptions {
  /** Called when a sign-up is refused by the registration rule. */
  readonly onRegistrationDenied?: () => void;
}

/**
 * A cf-auth instance for one request. Workers give a fresh `env` per request,
 * so it is built per request; {@link identityFor} keeps one per request.
 */
export async function createIdentity(
  env: Env,
  requestUrl: string,
  options: IdentityOptions = {},
  requestId: string | null = null,
): Promise<CfAuth> {
  if (!env.BETTER_AUTH_SECRET) {
    throw new GatewayError(503, "service_unavailable", "Sign-in is not configured on this deployment (BETTER_AUTH_SECRET)");
  }
  const { createCfAuth } = await cfAuth();
  const origin = new URL(requestUrl).origin;
  const consoleAt = consoleOrigin(env);
  const issuer = oauthIssuer(env);
  const realm = operationsRealm(env);
  const relay = googleAuthEnabled(env) ? oauthRelayOrigin(env) : undefined;
  const instance: CfAuth = createCfAuth({
    appName: "App AI Gateway",
    d1: env.DB,
    tables: mgmtAuthTables,
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: origin,
    basePath: IDENTITY_BASE_PATH,
    trustedOrigins: [...new Set([origin, ...(consoleAt === null ? [] : [consoleAt])])],
    userHooks: {
      beforeCreate: async (user) => {
        if (!registrationAllowed(env, user.email)) await registrationDenied(options.onRegistrationDenied);
        if (!user.emailVerified && user.email && emailVerificationRequired(env)) await markPendingVerification(env.DB, user.email);
      },
    },
    emailAndPassword: { enabled: true, revokeOtherSessionsOnPasswordChange: true },
    // Every person who signs up gets an account of their own (owner, 2026-11-19:
    // there are no unclaimed accounts in v2).
    organizations: { autoProvisionDefaultOrganization: true },
    apiKeys: { enabled: true, tokenPrefix: MANAGEMENT_KEY_PREFIX },
    // When each person last used their account, from the console, the CLI or
    // the API: written at most once an hour, after the response.
    memberActivity: true,
    cookies: { prefix: IDENTITY_COOKIE_PREFIX },
    onError: (error, { scope }) =>
      log("error", "identity_internal_error", { ray: requestId ?? undefined, scope, error: errorFacts(error) }),
    logger: { log: (level, message, ...args) => reportBetterAuthLog(requestId, level, message, ...args) },
    // Browser approvals: the OAuth flows, and the writes an agent hands to a
    // person (a key entered in a browser, a created key revealed on a page).
    ...(realm === null
      ? {}
      : { operations: { enabled: true, realm, kinds: gatewayOperationKinds(() => instance), limits: OPERATION_LIMITS } }),
    ...(issuer === null || realm === null || consoleAt === null
      ? {}
      : {
          oauth: {
            enabled: true,
            issuer,
            tokenPrefix: { access: OAUTH_ACCESS_TOKEN_PREFIX, refresh: OAUTH_REFRESH_TOKEN_PREFIX },
            clients: oauthClients(setting(env, "OAUTH_CLIENTS"), [CLI_CLIENT_ID]).map((client) => ({ ...client, redirectUris: [...client.redirectUris] })),
            cli: { clientId: CLI_CLIENT_ID, name: CLI_CLIENT_NAME },
            deviceFlow: { verificationUri: `${consoleAt}${DEVICE_PAGE_PATH}` },
            cimd: cimdEnabled(env) ? {} : (false as const),
          },
        }),
    ...(googleAuthEnabled(env)
      ? {
          google: {
            clientId: setting(env, "GOOGLE_CLIENT_ID")!,
            clientSecret: setting(env, "GOOGLE_CLIENT_SECRET")!,
            ...(relay === undefined ? {} : { redirectURI: `${relay}/callback/google` }),
          },
        }
      : {}),
  });
  return instance;
}

/** The part of a request context {@link identityFor} needs. */
export interface IdentityScope {
  readonly env: Env;
  readonly req: { readonly url: string; header(name: string): string | undefined };
  get(key: "identity"): Promise<CfAuth> | undefined;
  set(key: "identity", value: Promise<CfAuth>): void;
}

/** The request's cf-auth instance, built once per request. A failed build is not kept. */
export function identityFor(c: IdentityScope): Promise<CfAuth> {
  const existing = c.get("identity");
  if (existing !== undefined) return existing;
  const built = createIdentity(c.env, c.req.url, {}, c.req.header("cf-ray") ?? null);
  c.set("identity", built);
  return built;
}

/**
 * Recognises a cf-auth refusal without loading cf-auth: `CfAuthError` sets
 * its own `name` and carries a `code` and a `status`.
 */
export function isCfAuthError(error: unknown): error is CfAuthError {
  if (!(error instanceof Error) || error.name !== "CfAuthError") return false;
  const candidate = error as Partial<CfAuthError>;
  return typeof candidate.code === "string" && typeof candidate.status === "number";
}

const MAPPED_CODES: Readonly<Record<string, ErrorCode>> = {
  unauthorized: "auth_required",
  forbidden: "forbidden",
  session_required: "session_required",
  grant_insufficient: "grant_insufficient",
  validation_error: "invalid_request",
  conflict: "conflict",
  not_found: "not_found",
  not_a_member: "not_a_member",
  last_owner: "last_owner",
  operation_not_found: "not_found",
  invalid_proof: "forbidden",
  too_many_pending: "rate_limited",
  api_key_required: "forbidden",
  operation_expired: "operation_expired",
  operation_denied: "operation_denied",
  already_completed: "already_completed",
  already_revealed: "already_revealed",
  operation_mismatch: "operation_mismatch",
  no_eligible_organization: "no_eligible_organization",
};

/** A cf-auth refusal as the gateway's own error, with v1's codes. */
export function asGatewayAuthError(error: CfAuthError): GatewayError {
  return new GatewayError(error.status, MAPPED_CODES[error.code] ?? "invalid_request", error.message);
}

/** Any failure, with a cf-auth refusal turned into the gateway's own error. */
export function gatewayErrorOf(error: unknown): unknown {
  return isCfAuthError(error) ? asGatewayAuthError(error) : error;
}

/** The interactive human session this state is, or null for anything else. */
export function humanSession(state: AuthState | undefined): AuthState | null {
  return state?.authenticated === true
    && state.credentialType === "session"
    && state.assurance === "interactive"
    && state.user?.kind === "human"
    ? state
    : null;
}
