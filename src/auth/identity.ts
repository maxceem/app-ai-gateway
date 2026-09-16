import { createCfAuth, type CfAuth, type CfAuthError, isCfAuthError } from "@maxceem/cf-auth";
import { APIError } from "better-auth/api";
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
  if (!(await registrationAllowed(env, claimRegistration))) {
    onDenied?.();
    throw APIError.from("FORBIDDEN", {
      code: "REGISTRATION_DISABLED",
      message: "signup disabled",
    });
  }
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
  return createCfAuth({
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
  });
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
