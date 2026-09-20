import {
  createAuthMiddleware,
  createAuthService,
  createBetterAuthOptions,
  createCfAuthRepository,
  createCurrentOrganizationCookie,
  resolveConfig,
  type CfAuth,
  type CfAuthConfig,
  type CfAuthError,
  isCfAuthError,
} from "@maxceem/cf-auth";
import { APIError, createAuthMiddleware as createBetterAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import type { DBAdapter, DBTransactionAdapter } from "better-auth/types";
import { billingBinding } from "../billing/gateway";
import { mgmtAuthTables } from "../db/schema";
import { GatewayError, type ErrorCode } from "../core/errors";

export const IDENTITY_AUTH_BASE_PATH = "/v1/auth";
export const MANAGEMENT_KEY_PREFIX = "agw_mgmt_";
export const CONSOLE_REQUEST_HEADER = "x-console-request";

function additionalRegistrationsAllowed(env: Env): boolean {
  return env.ALLOW_ADDITIONAL_REGISTRATIONS?.trim().toLowerCase() === "true";
}

async function selfHostedRegistrationState(env: Env): Promise<{
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

export async function registrationOpen(env: Env): Promise<boolean> {
  return registrationAllowed(env, false);
}

async function registrationAllowed(env: Env, claimRegistration: boolean): Promise<boolean> {
  if (billingBinding(env)) return true;
  const state = await selfHostedRegistrationState(env);
  if (state.humanExists) return additionalRegistrationsAllowed(env);
  return claimRegistration || !state.accountExists;
}

async function assertRegistrationAllowed(
  env: Env,
  claimRegistration: boolean,
  onDenied?: () => void,
): Promise<void> {
  if (!(await registrationAllowed(env, claimRegistration))) registrationDenied(onDenied);
}

function registrationDenied(onDenied?: () => void): never {
  onDenied?.();
  throw APIError.from("FORBIDDEN", {
    code: "REGISTRATION_DISABLED",
    message: "signup disabled",
  });
}

interface LogicalHumanUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  kind: "human";
  createdAt: Date;
  updatedAt: Date;
}

function userDate(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" || typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function selectedUser(
  user: LogicalHumanUser,
  select: string[] | undefined,
): Record<string, unknown> {
  if (!select?.length) return { ...user };
  const result: Record<string, unknown> = {};
  for (const field of select) {
    if (Object.hasOwn(user, field)) result[field] = user[field as keyof LogicalHumanUser];
  }
  return result;
}

async function insertHumanAtomically(
  env: Env,
  data: Record<string, unknown>,
  select: string[] | undefined,
  forceAllowId: boolean,
  claimRegistration: boolean,
  onDenied?: () => void,
): Promise<Record<string, unknown>> {
  // Better Auth's additional-field default must identify this as a human. Do
  // not let a caller choose another kind and sidestep the registration gate.
  if (data.kind !== undefined && data.kind !== "human") {
    throw new Error("Better Auth user creation must carry the human identity kind");
  }
  if (typeof data.name !== "string" || typeof data.email !== "string") {
    throw new Error("Better Auth user creation is missing normalized identity fields");
  }

  const createdAt = userDate(data.createdAt);
  const updatedAt = userDate(data.updatedAt);
  const user: LogicalHumanUser = {
    id:
      forceAllowId && typeof data.id === "string" && data.id.length > 0
        ? data.id
        : crypto.randomUUID(),
    name: data.name,
    email: data.email,
    emailVerified: data.emailVerified === true,
    image: typeof data.image === "string" ? data.image : null,
    kind: "human",
    createdAt,
    updatedAt,
  };
  const additionalAllowed = additionalRegistrationsAllowed(env);
  const inserted = await env.DB.prepare(
    `INSERT INTO mgmt_user(id,name,email,email_verified,image,kind,created_at,updated_at)
     SELECT ?,?,?,?,?, 'human',?,?
     WHERE
       (EXISTS (SELECT 1 FROM mgmt_user WHERE kind='human') AND ?)
       OR
       (NOT EXISTS (SELECT 1 FROM mgmt_user WHERE kind='human') AND
        (? OR NOT EXISTS (SELECT 1 FROM mgmt_organization)))
     RETURNING id`,
  ).bind(
    user.id,
    user.name,
    user.email,
    user.emailVerified ? 1 : 0,
    user.image,
    user.createdAt.getTime(),
    user.updatedAt.getTime(),
    additionalAllowed ? 1 : 0,
    claimRegistration ? 1 : 0,
  ).first<{ id: string }>();
  if (!inserted) registrationDenied(onDenied);
  return selectedUser(user, select);
}

/**
 * Keeps the guarded create method inside Better Auth's transaction callback.
 * D1's Drizzle adapter implements transactions as sequential adapter calls; if
 * the callback received the original adapter, signup and OAuth would bypass
 * the atomic user insertion even though top-level creates were wrapped.
 */
function guardUserCreates(
  env: Env,
  adapter: DBAdapter,
  claimRegistration: boolean,
  onDenied?: () => void,
): DBAdapter {
  const createGuarded = (delegate: DBTransactionAdapter["create"]): DBAdapter["create"] => async <
    T extends Record<string, unknown>,
    R = T,
  >(args: {
    model: string;
    data: Omit<T, "id">;
    select?: string[];
    forceAllowId?: boolean;
  }): Promise<R> => {
    if (args.model !== "user") return delegate<T, R>(args);
    return await insertHumanAtomically(
      env,
      args.data,
      args.select,
      args.forceAllowId ?? false,
      claimRegistration,
      onDenied,
    ) as R;
  };
  const guardedCreate = createGuarded(adapter.create);

  return {
    ...adapter,
    create: guardedCreate,
    transaction: <R>(callback: (trx: DBTransactionAdapter) => Promise<R>) =>
      adapter.transaction((trx) =>
        callback({
          ...trx,
          create: createGuarded(trx.create),
        }),
      ),
  };
}

function createGatewayIdentityAuth(
  env: Env,
  config: CfAuthConfig,
  claimRegistration: boolean,
  onRegistrationDenied?: () => void,
): CfAuth {
  const resolved = resolveConfig(config);
  const repository = createCfAuthRepository(resolved.db, resolved.tables, {
    onError: resolved.onError,
  });
  let service: ReturnType<typeof createAuthService> | undefined;
  const getService = () => {
    if (!service) throw new Error("cf-auth service accessed before initialization");
    return service;
  };
  const options = createBetterAuthOptions(resolved, getService);

  // Hosted registration is deliberately unrestricted, so it keeps cf-auth's
  // adapter untouched. Only self-hosted human creation needs the D1 predicate.
  if (!billingBinding(env)) {
    const adapterFactory = options.database;
    if (typeof adapterFactory !== "function") {
      throw new Error("cf-auth did not configure a database adapter");
    }
    options.database = (authOptions: Parameters<typeof adapterFactory>[0]) =>
      guardUserCreates(
        env,
        adapterFactory(authOptions),
        claimRegistration,
        onRegistrationDenied,
      );
  }

  options.hooks = {
    before: createBetterAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/change-password") return;
      return {
        context: {
          body: { ...ctx.body, revokeOtherSessions: true },
        },
      };
    }),
  };

  const auth = betterAuth(options);
  service = createAuthService(repository, resolved);
  const currentOrganizationCookie = createCurrentOrganizationCookie(resolved);
  const middleware = createAuthMiddleware(resolved, {
    auth,
    service,
    currentOrganizationCookie,
  });
  const routePattern = `${resolved.basePath === "/" ? "" : resolved.basePath}/*`;
  const handler = (request: Request): Promise<Response> => auth.handler(request);

  return {
    config: resolved,
    auth,
    service,
    repository,
    currentOrganizationCookie,
    basePath: resolved.basePath,
    routePattern,
    handler,
    middleware,
    mount(app) {
      app.all(routePattern, (c: { req: { raw: Request } }) => handler(c.req.raw));
    },
  };
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

function identityAuth(
  env: Env,
  requestUrl: string,
  claimRegistration: boolean,
  suppressDefaultOrganization = false,
  provisionRegistration = false,
  onRegistrationDenied?: () => void,
): CfAuth {
  const origin = new URL(requestUrl).origin;
  const googleEnabled = googleAuthEnabled(env);
  const googleRedirectUri = googleEnabled ? googleRelayRedirectUri(env) : undefined;
  return createGatewayIdentityAuth(env, {
    appName: "App AI Gateway",
    d1: env.DB,
    tables: mgmtAuthTables,
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: origin,
    basePath: IDENTITY_AUTH_BASE_PATH,
    trustedOrigins: [origin],
    userHooks: {
      beforeCreate: () =>
        assertRegistrationAllowed(env, claimRegistration, onRegistrationDenied),
    },
    emailAndPassword: { enabled: true },
    organizations: {
      autoProvisionDefaultOrganization:
        !claimRegistration &&
        !suppressDefaultOrganization &&
        (Boolean(billingBinding(env)) || provisionRegistration),
    },
    apiKeys: { enabled: true, tokenPrefix: MANAGEMENT_KEY_PREFIX },
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
  }, claimRegistration, onRegistrationDenied);
}

export function createIdentityAuth(
  env: Env,
  requestUrl: string,
  options: {
    suppressDefaultOrganization?: boolean;
    provisionRegistration?: boolean;
    onRegistrationDenied?: () => void;
  } = {},
): CfAuth {
  return identityAuth(
    env,
    requestUrl,
    false,
    options.suppressDefaultOrganization,
    options.provisionRegistration,
    options.onRegistrationDenied,
  );
}

/** Trusted claim route only: invoke after validating the handoff proofs. Never mount its handler. */
export function createClaimRegistrationAuth(
  env: Env,
  requestUrl: string,
  options: { onRegistrationDenied?: () => void } = {},
): CfAuth {
  return identityAuth(env, requestUrl, true, false, false, options.onRegistrationDenied);
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

export function asGatewayAuthError(error: CfAuthError): GatewayError {
  const mappedCodes: Record<string, ErrorCode> = {
    unauthorized: "auth_required",
    forbidden: "forbidden",
    session_required: "session_required",
    validation_error: "validation_error",
    conflict: "conflict",
    not_found: "not_found",
    not_a_member: "not_a_member",
    last_owner: "last_owner",
    organization_expired: "account_expired",
    not_claimable: "conflict",
  };
  const code = mappedCodes[error.code] ?? "invalid_request";
  return new GatewayError(error.status, code, error.message);
}

export function rethrowCfAuthError(error: unknown): never {
  if (isCfAuthError(error)) throw asGatewayAuthError(error);
  throw error;
}
