import type { CfAuth, CfAuthError, OperationSweepStatements } from "@maxceem/cf-auth";
import { mgmtAuthTables } from "../db/schema";
import { GatewayError, type ErrorCode } from "../core/errors";
import {
  registrationAllowed as policyRegistrationAllowed,
  registrationRule,
  registrationUnrestricted,
  shouldProvisionDefaultOrganization,
  type Deployment,
} from "../policy/deployment";
import { registrationCreateCondition } from "../policy/sql";
import { gatewayOperationKinds, OPERATION_LIMITS } from "./operation-kinds";

/**
 * The identity library, loaded on first use and shared by every caller in the
 * isolate.
 *
 * A proxied request authenticates nobody through better-auth, `@better-auth/core`
 * behind cf-auth, or the `@opentelemetry` semantic conventions they pull in, so
 * none of that is on its path: everything that needs the library asks for it
 * through this — the same way App Attest is deferred inside the two handlers in
 * `../routes/auth`.
 *
 * What this buys is deferred *evaluation*, not a smaller bundle: wrangler does
 * not emit a separate chunk, it inlines the module as a lazily initialised
 * wrapper that runs on first use. The file stays the same size; the work moves.
 *
 * The promise is memoised, so the module is evaluated once per isolate however
 * many requests arrive. A rejection is forgotten rather than kept, because a
 * pinned failed promise would answer every later request in the isolate with a
 * transient failure the next one might not have hit.
 *
 * Type-only imports are exempt: they are erased, so naming a cf-auth type
 * costs a proxied request nothing. `@maxceem/cf-auth/schema` is exempt too —
 * the drizzle table definitions in `../db/schema` are on every request's path
 * already.
 */
export const cfAuth = (): Promise<typeof import("@maxceem/cf-auth")> =>
  (loaded ??= import("@maxceem/cf-auth").catch(forget));

let loaded: Promise<typeof import("@maxceem/cf-auth")> | undefined;

function forget(error: unknown): never {
  loaded = undefined;
  throw error;
}

export const IDENTITY_AUTH_BASE_PATH = "/v1/auth";
export const MANAGEMENT_KEY_PREFIX = "agw_mgmt_";
export const CONSOLE_REQUEST_HEADER = "x-console-request";

async function registrationState(env: Env): Promise<{
  humanExists: boolean;
  accountExists: boolean;
}> {
  const row = await env.DB.prepare(
    `SELECT
      EXISTS(SELECT 1 FROM mgmt_user WHERE kind='human') AS human_exists,
      EXISTS(SELECT 1 FROM mgmt_organization) AS account_exists`,
  ).first<{ human_exists: number; account_exists: number }>();
  return {
    humanExists: Boolean(row?.human_exists),
    accountExists: Boolean(row?.account_exists),
  };
}

export async function registrationOpen(deployment: Deployment, env: Env): Promise<boolean> {
  return registrationAllowed(deployment, env, false);
}

async function registrationAllowed(
  deployment: Deployment,
  env: Env,
  claimRegistration: boolean,
): Promise<boolean> {
  const rule = registrationRule(deployment, claimRegistration);
  if (registrationUnrestricted(rule)) return true;
  return policyRegistrationAllowed(rule, await registrationState(env));
}

async function assertRegistrationAllowed(
  deployment: Deployment,
  env: Env,
  claimRegistration: boolean,
  onDenied?: () => void,
): Promise<void> {
  if (!(await registrationAllowed(deployment, env, claimRegistration))) {
    await registrationDenied(onDenied);
  }
}

/**
 * Refuses a registration in the shape Better Auth answers with.
 *
 * `APIError` is Better Auth's own, so it is reached through an `import()` for
 * the same reason cf-auth is: nothing may put better-auth on the cold path of a
 * proxied request. By the time this runs the library is evaluated — only a
 * Better Auth user hook calls it — so the import resolves from the registry.
 */
async function registrationDenied(onDenied?: () => void): Promise<never> {
  onDenied?.();
  const { APIError } = await import("better-auth/api");
  throw APIError.from("FORBIDDEN", {
    code: "REGISTRATION_DISABLED",
    message: "signup disabled",
  });
}

export function googleAuthEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
}

/** Where the OAuth callback relay listens, e.g. `https://dev-oauth.example.com`. */
export function oauthRelayOrigin(env: Env): string | undefined {
  const raw = env.OAUTH_RELAY_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OAUTH_RELAY_URL must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OAUTH_RELAY_URL must be an absolute http(s) URL");
  }
  // The origin, so a trailing slash or a stray path cannot double up below.
  return url.origin;
}

/**
 * The redirect URI Google is given when the relay is in use.
 *
 * Better Auth sends it in the authorization request *and* in the code
 * exchange, so both name the relay and the two match, which is what the token
 * endpoint checks.
 */
export function googleRelayRedirectUri(env: Env): string | undefined {
  const relay = oauthRelayOrigin(env);
  return relay === undefined ? undefined : `${relay}/callback/google`;
}

export interface IdentityAuthOptions {
  suppressDefaultOrganization?: boolean;
  provisionRegistration?: boolean;
  /**
   * Trusted claim route only: pass it after validating the handoff proofs, and
   * never mount the resulting instance's handler.
   */
  claimRegistration?: boolean;
  onRegistrationDenied?: () => void;
}

/**
 * The options the management surface builds its cf-auth instance with: the
 * CLI's routes, the management services and the MCP server share it. It never
 * provisions an account as a side effect, since nothing there registers anyone.
 */
export const MANAGEMENT_IDENTITY: IdentityAuthOptions = { suppressDefaultOrganization: true };

/**
 * What every browser proof and user code is bound to: the deployment's public
 * identity, so a proof made for one deployment means nothing to another. Null
 * where the deployment has none, and then there are no operations to prove.
 */
function operationsRealm(deployment: Deployment): string | null {
  try {
    return deployment.identity().id;
  } catch {
    return null;
  }
}

export async function createIdentityAuth(
  deployment: Deployment,
  env: Env,
  requestUrl: string,
  {
    suppressDefaultOrganization = false,
    provisionRegistration = false,
    claimRegistration = false,
    onRegistrationDenied,
  }: IdentityAuthOptions = {},
): Promise<CfAuth> {
  const { createCfAuth } = await cfAuth();
  const origin = new URL(requestUrl).origin;
  const googleEnabled = googleAuthEnabled(env);
  const googleRedirectUri = googleEnabled ? googleRelayRedirectUri(env) : undefined;
  const rule = registrationRule(deployment, claimRegistration);
  const realm = operationsRealm(deployment);
  // Read lazily by the claim kind, whose approval is this instance's own
  // `claimOrganization`: no request reaches it before it is built.
  const instance: CfAuth = createCfAuth({
    appName: "App AI Gateway",
    d1: env.DB,
    tables: mgmtAuthTables,
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: origin,
    basePath: IDENTITY_AUTH_BASE_PATH,
    trustedOrigins: [origin],
    userHooks: {
      beforeCreate: () =>
        assertRegistrationAllowed(deployment, env, claimRegistration, onRegistrationDenied),
      ...(!registrationUnrestricted(rule)
        ? {
            atomicCreateGuard: {
              condition: (tables: typeof mgmtAuthTables) =>
                registrationCreateCondition(rule, tables),
              onDenied: onRegistrationDenied,
            },
          }
        : {}),
    },
    emailAndPassword: { enabled: true, revokeOtherSessionsOnPasswordChange: true },
    organizations: {
      autoProvisionDefaultOrganization: shouldProvisionDefaultOrganization(deployment, {
        claimRegistration,
        suppressDefaultOrganization,
        provisionRegistration,
      }),
    },
    apiKeys: { enabled: true, tokenPrefix: MANAGEMENT_KEY_PREFIX },
    // The CLI's operations: the engine, its table and the built-in `login`
    // are cf-auth's; the kinds and what completes them are this gateway's.
    operations: {
      enabled: realm !== null,
      ...(realm === null ? {} : { realm }),
      kinds: gatewayOperationKinds(() => instance),
      // Any member may log a CLI in to their account, with a key that carries
      // their own role; the library's default asks for an admin.
      // A login's record is kept a day from when it was asked for: its key is
      // collected within minutes or not at all, nothing retries a login days
      // later, and an address that asks and declines over and over leaves
      // nothing behind for long.
      login: { minRole: "member", pendingTtlMs: 15 * 60_000, recordTtlMs: 86_400_000 },
      limits: OPERATION_LIMITS,
    },
    cookies: { prefix: "agw_identity" },
    ...(googleEnabled
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID!,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
            ...(googleRedirectUri ? { redirectURI: googleRedirectUri } : {}),
          },
        }
      : {}),
  });
  return instance;
}

/**
 * cf-auth's operation sweep as statements for the nightly run to batch itself,
 * built over `binding` — the run's budgeted view of the database — so its
 * allowance counts them as they go out. Built from an instance of its own,
 * since the run has no request: the origin it is given only names cookies and
 * callbacks nothing here issues.
 */
export async function operationSweepStatements(
  deployment: Deployment,
  env: Env,
  binding: D1Database,
  now: number,
): Promise<OperationSweepStatements> {
  const scoped = new Proxy(env, {
    get: (target, key, receiver) => (key === "DB" ? binding : Reflect.get(target, key, receiver)),
  });
  const identity = await createIdentityAuth(deployment, scoped, "https://maintenance.invalid");
  return identity.operations.sweepStatements(now);
}

/** The part of a request context this needs: the environment, the URL, and somewhere to memoize. */
export interface IdentityAuthScope {
  env: Env;
  req: { url: string };
  get(key: "deployment"): Deployment;
  get(key: "identityAuthCache"): Map<string, Promise<CfAuth>>;
}

/**
 * The cf-auth instance for this request and these options, built once.
 *
 * Building one constructs a Better Auth instance, and a single claim submission
 * needs three: one to read the approver's session, one to register them and one
 * to claim. They are pure functions of the deployment,
 * the request origin and these three flags, so the flags, each named, are the
 * cache key.
 * An instance carrying a `onRegistrationDenied` callback is not shared, since
 * the callback belongs to one caller's control flow.
 */
export function identityAuthFor(
  c: IdentityAuthScope,
  options: IdentityAuthOptions = {},
): Promise<CfAuth> {
  const deployment = c.get("deployment");
  if (options.onRegistrationDenied) {
    return createIdentityAuth(deployment, c.env, c.req.url, options);
  }
  const key = JSON.stringify({
    suppressDefaultOrganization: options.suppressDefaultOrganization ?? false,
    provisionRegistration: options.provisionRegistration ?? false,
    claimRegistration: options.claimRegistration ?? false,
  });
  const cache = c.get("identityAuthCache");
  const existing = cache.get(key);
  if (existing) return existing;
  // The promise is cached before it settles, so two callers awaiting the same
  // options concurrently share one build. A rejection is forgotten rather than
  // kept, for the reason `cfAuth()` forgets its own: a pinned failed promise
  // would answer the rest of this request with a transient failure a second
  // attempt might not hit.
  const built = createIdentityAuth(deployment, c.env, c.req.url, options).catch(
    (error: unknown) => {
      cache.delete(key);
      throw error;
    },
  );
  cache.set(key, built);
  return built;
}

/** Google's authorization host, and the only URL the relay is put in front of. */
const GOOGLE_AUTHORIZATION_HOST = "accounts.google.com";

/**
 * Sends the browser to the relay instead of straight to Google.
 *
 * `POST /v1/auth/sign-in/social` answers with the provider URL for the browser
 * to follow. With `OAUTH_RELAY_URL` set, that URL is wrapped in a relay
 * `/start` call carrying this origin's own callback, so Google can redirect to
 * the one URI it has registered — the relay's — and the code still comes back
 * to whichever local host asked for it. Everything else about the flow, the
 * `state` cookie and the code exchange included, stays here.
 *
 * Anything that is not a Google authorization URL is passed through untouched,
 * which covers the ID-token sign-in path (no `url` at all) and every other
 * provider.
 */
export async function relaySocialSignIn(
  env: Env,
  requestUrl: string,
  response: Response,
): Promise<Response> {
  const relay = oauthRelayOrigin(env);
  if (relay === undefined) return response;
  if (!response.headers.get("content-type")?.includes("application/json")) return response;

  const body = (await response
    .clone()
    .json()
    .catch(() => undefined)) as Record<string, unknown> | undefined;
  if (typeof body?.url !== "string") return response;

  let providerUrl: URL;
  try {
    providerUrl = new URL(body.url);
  } catch {
    return response;
  }
  if (providerUrl.hostname !== GOOGLE_AUTHORIZATION_HOST) return response;

  const start = new URL(`${relay}/start`);
  start.searchParams.set(
    "return",
    new URL(`${IDENTITY_AUTH_BASE_PATH}/callback/google`, requestUrl).toString(),
  );
  start.searchParams.set("next", providerUrl.toString());

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({ ...body, url: start.toString() }), {
    status: response.status,
    headers,
  });
}

/**
 * Recognises a cf-auth rejection without loading cf-auth.
 *
 * The library's own `isCfAuthError` is an `instanceof` test, so reaching it
 * means importing the library — and this module is the one place that does
 * that, precisely so no error handler drags better-auth onto the cold path of
 * a proxied request by asking what kind of error it is holding. `CfAuthError`
 * sets its own `name` in its constructor and carries a machine-readable `code`
 * and an HTTP `status`, so it is identifiable by shape; see
 * `node_modules/@maxceem/cf-auth/dist/errors.js`. Its caller today is
 * `../routes/management`, which maps a rejection and rethrows it for the entry
 * module to format.
 */
export function isCfAuthError(error: unknown): error is CfAuthError {
  if (!(error instanceof Error) || error.name !== "CfAuthError") return false;
  const candidate = error as Partial<CfAuthError>;
  return typeof candidate.code === "string" && typeof candidate.status === "number";
}

/** Whether a failure is cf-auth — its operation engine, typically — refusing with `code`. */
export function engineRefused(error: unknown, code: string): boolean {
  return isCfAuthError(error) && error.code === code;
}

export function asGatewayAuthError(error: CfAuthError): GatewayError {
  const mappedCodes: Record<string, ErrorCode> = {
    unauthorized: "auth_required",
    forbidden: "forbidden",
    session_required: "session_required",
    grant_insufficient: "grant_insufficient",
    validation_error: "validation_error",
    conflict: "conflict",
    not_found: "not_found",
    not_a_member: "not_a_member",
    last_owner: "last_owner",
    organization_expired: "account_expired",
    not_claimable: "conflict",
    // The operation engine's refusals. The gateway's own codes where it has one
    // that means the same; the engine's where a client acts on the difference.
    operation_not_found: "not_found",
    invalid_proof: "forbidden",
    too_many_pending: "rate_limited",
    api_key_required: "forbidden",
    operation_expired: "operation_expired",
    operation_denied: "operation_denied",
    operation_pending: "operation_pending",
    already_completed: "already_completed",
    operation_mismatch: "operation_mismatch",
    already_revealed: "already_revealed",
    no_eligible_organization: "no_eligible_organization",
  };
  // A claim kind's own refusals, when the engine's `approve` reaches them
  // after the approval page's own check did not: answered exactly as the
  // gateway answers them itself, so the page reads one vocabulary.
  if (error.code === "registration_required")
    return new GatewayError(401, "session_required", "Create a sign-in on the approval page before approving this request");
  if (error.code === "sign_out_required")
    return new GatewayError(
      403,
      "account_exists",
      "This sign-in already has an account; sign out and create a new sign-in to claim this one",
    );
  const code = mappedCodes[error.code] ?? "invalid_request";
  return new GatewayError(error.status, code, error.message);
}
