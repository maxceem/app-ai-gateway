import {
  createCfAuth,
  type CfAuth,
  type CfAuthError,
  isCfAuthError,
} from "@maxceem/cf-auth";
import { consoleAuthTables } from "../db/schema";
import { GatewayError, type ErrorCode } from "../core/errors";

export const OPERATOR_AUTH_BASE_PATH = "/v1/auth";
export const MANAGEMENT_KEY_PREFIX = "agw_mgmt_";
export const CONSOLE_REQUEST_HEADER = "x-console-request";

export function registrationOpen(env: Env): boolean {
  return env.ALLOW_PUBLIC_REGISTRATION?.trim().toLowerCase() !== "false";
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

export function createOperatorAuth(env: Env, requestUrl: string): CfAuth {
  const origin = new URL(requestUrl).origin;
  const googleEnabled = googleAuthEnabled(env);
  const googleRedirectUri = googleEnabled ? googleRelayRedirectUri(env) : undefined;
  return createCfAuth({
    appName: "App AI Gateway",
    d1: env.DB,
    tables: consoleAuthTables,
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: origin,
    basePath: OPERATOR_AUTH_BASE_PATH,
    trustedOrigins: [origin],
    disableSignUp: !registrationOpen(env),
    emailAndPassword: { enabled: true },
    organizations: { autoProvisionDefaultOrganization: true },
    apiKeys: { enabled: true, tokenPrefix: MANAGEMENT_KEY_PREFIX },
    cookies: { prefix: "agw_operator" },
    ...(googleEnabled
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID!,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
            disableSignUp: !registrationOpen(env),
            ...(googleRedirectUri ? { redirectURI: googleRedirectUri } : {}),
          },
        }
      : {}),
  });
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

  const body = await response.clone().json().catch(() => undefined) as
    | Record<string, unknown>
    | undefined;
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
    new URL(`${OPERATOR_AUTH_BASE_PATH}/callback/google`, requestUrl).toString(),
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
  };
  const code = mappedCodes[error.code] ?? "invalid_request";
  return new GatewayError(error.status, code, error.message);
}

export function rethrowCfAuthError(error: unknown): never {
  if (isCfAuthError(error)) throw asGatewayAuthError(error);
  throw error;
}
