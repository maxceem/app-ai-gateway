/**
 * Signing this CLI in to a v2 gateway, through the gateway's own OAuth server
 * (plan section 9.0). The CLI is a built-in public client, `agw-cli`:
 *
 * - with a browser on this machine, the authorization code with PKCE and a
 *   loopback redirect (RFC 7636, RFC 8252);
 * - without one, the device flow (RFC 8628): a link and a short code, approved
 *   in any browser.
 *
 * Either way it ends with a short-lived access token and a refresh token that
 * the server rotates on every use. The issuer is the console origin plus
 * `/v2`, and every endpoint must be on that same origin.
 */
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CliError, fail } from "./common.ts";
import type { OAuthLogin } from "./state.ts";
import { ACCOUNT_LOGIN, type SignInRetry } from "./sign-in-retry.ts";
import type { FormResponse, Transport } from "./transport.ts";

/** The CLI's client id; the gateway registers it as a built-in public client. */
export const CLI_CLIENT_ID = "agw-cli";

/** The path every v2 gateway serves its API, OAuth server and console under. */
export const V2_PATH = "/v2";

export const DISCOVERY_PATH = `/.well-known/oauth-authorization-server${V2_PATH}`;

/** What the CLI reads from the authorization server's metadata (RFC 8414). */
export interface OAuthServer {
  issuer: string;
  /** Paths on the gateway's origin. */
  authorize: string;
  token: string;
  revoke: string;
  device: string | null;
}

export type OAuthTransport = Pick<Transport, "request" | "postForm">;

/** The path of an endpoint URL, refused unless it is on the gateway's own origin. */
function pathOn(url: string, value: unknown, name: string, nextAction?: string): string {
  if (typeof value !== "string") fail("invalid_response", `The gateway's sign-in metadata has no ${name}.`, nextAction, 3);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("invalid_response", `The gateway's sign-in metadata has an unusable ${name}.`, nextAction, 3);
  }
  if (parsed.origin !== url || parsed.username || parsed.password || parsed.hash)
    fail("invalid_response", `The gateway's ${name} is not on its own origin, so agw will not send credentials there.`, nextAction, 3);
  return parsed.pathname + parsed.search;
}

/**
 * The gateway's OAuth server, read from its metadata. A gateway that has no
 * `/v2` metadata is checked once for being a v1 gateway, which this agw
 * cannot manage.
 */
export async function discover(transport: OAuthTransport, url: string): Promise<OAuthServer> {
  let data: unknown;
  try {
    data = (await transport.request(url, DISCOVERY_PATH)).data;
  } catch (error) {
    if (error instanceof CliError && error.details?.status === 404) await refuseOlderGateway(transport, url);
    if (error instanceof CliError && error.details?.status === 404)
      fail(
        "oauth_unavailable",
        "This gateway does not offer sign-in for the CLI.",
        "Check the URL is the gateway's console address, or set AGW_MANAGEMENT_KEY to a management key.",
        3,
      );
    throw error;
  }
  const meta = (data ?? {}) as Record<string, unknown>;
  const issuer = url + V2_PATH;
  if (meta["issuer"] !== issuer)
    fail("invalid_response", "The gateway's sign-in metadata names another issuer.", "Check the gateway URL.", 3);
  return {
    issuer,
    authorize: pathOn(url, meta["authorization_endpoint"], "authorization endpoint"),
    token: pathOn(url, meta["token_endpoint"], "token endpoint"),
    revoke: pathOn(url, meta["revocation_endpoint"], "revocation endpoint"),
    device: meta["device_authorization_endpoint"] === undefined ? null : pathOn(url, meta["device_authorization_endpoint"], "device endpoint"),
  };
}

/**
 * Stops with a short message when the gateway is a v1 one: agw 2 manages v2
 * gateways only. Anything else, including no answer, lets the caller go on.
 */
export async function refuseOlderGateway(transport: Pick<Transport, "request">, url: string): Promise<void> {
  let v1 = false;
  try {
    const { data } = await transport.request(url, "/v1/cli/capabilities", { timeoutMs: 10_000 });
    v1 = typeof data === "object" && data !== null;
  } catch {
    v1 = false;
  }
  if (v1)
    fail(
      "gateway_v1",
      "This is an App AI Gateway v1 deployment. agw 2 manages v2 gateways only.",
      "Use agw 1.x for this gateway (npm install -g @maxceem/agw@1), or migrate it to v2.",
      3,
    );
}

/** A PKCE pair (RFC 7636, S256). */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** The browser address of an authorization request. */
export function authorizeUrl(
  url: string,
  server: OAuthServer,
  input: { redirect: string; challenge: string; state: string; grant: "read" | "manage" },
): string {
  const target = new URL(server.authorize, url);
  target.search = new URLSearchParams({
    response_type: "code",
    client_id: CLI_CLIENT_ID,
    redirect_uri: input.redirect,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    resource: server.issuer,
    scope: input.grant,
    state: input.state,
  }).toString();
  return target.toString();
}

const GRANTS = new Set(["read", "manage"]);

/** A new sign-in's id, kept through every renewal. */
const newLoginId = (): string => randomBytes(12).toString("base64url");

/** A token endpoint's success, as a stored sign-in; anything else is refused. */
function loginFrom(answer: FormResponse, now: number, id: string, retry: SignInRetry = ACCOUNT_LOGIN): OAuthLogin {
  const data = answer.data;
  const access = data["access_token"];
  const refresh = data["refresh_token"];
  const expiresIn = data["expires_in"];
  const scope = data["scope"];
  if (
    answer.status !== 200 ||
    typeof access !== "string" ||
    !access ||
    typeof refresh !== "string" ||
    !refresh ||
    typeof expiresIn !== "number" ||
    !(expiresIn > 0)
  )
    fail("invalid_response", "The gateway answered the sign-in with an unusable token response.", retry.again(), 3);
  return {
    id,
    clientId: CLI_CLIENT_ID,
    accessToken: access,
    refreshToken: refresh,
    expiresAt: new Date(now + expiresIn * 1000).toISOString(),
    grant: typeof scope === "string" && GRANTS.has(scope) ? (scope as OAuthLogin["grant"]) : "manage",
  };
}

/** A refusal from the token endpoint, with its OAuth error code. */
function tokenRefusal(answer: FormResponse, what: string, retry: SignInRetry = ACCOUNT_LOGIN): never {
  const code = typeof answer.data["error"] === "string" ? (answer.data["error"] as string) : `http_${answer.status}`;
  const description = typeof answer.data["error_description"] === "string" ? (answer.data["error_description"] as string) : "";
  fail(
    code === "invalid_grant" ? "login_failed" : code,
    `${what} was refused (${code})${description ? `: ${description.replace(/\p{C}/gu, " ").slice(0, 300)}` : "."}`,
    retry.again(),
    3,
    { status: answer.status },
  );
}

/** Exchanges an authorization code for the first token pair. */
export async function exchangeCode(
  transport: OAuthTransport,
  url: string,
  server: OAuthServer,
  input: { code: string; redirect: string; verifier: string },
  now: () => number = Date.now,
  retry: SignInRetry = ACCOUNT_LOGIN,
): Promise<OAuthLogin> {
  const answer = await transport.postForm(url, server.token, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirect,
    client_id: CLI_CLIENT_ID,
    code_verifier: input.verifier,
    resource: server.issuer,
  });
  if (answer.status !== 200) tokenRefusal(answer, "The sign-in", retry);
  return loginFrom(answer, now(), newLoginId(), retry);
}

/** What the device flow shows the person. */
export interface DevicePrompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
}

/** The device flow's pacing and its clock, replaced in tests. */
export interface DeviceClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: DeviceClock = { now: Date.now, sleep: (ms) => delay(ms) };

/**
 * The device flow: asks for a code, shows it through `show`, then polls until
 * the person approves or declines in any browser, or the code expires.
 */
export async function deviceLogin(
  transport: OAuthTransport,
  url: string,
  server: OAuthServer,
  grant: "read" | "manage",
  show: (prompt: DevicePrompt) => void,
  clock: DeviceClock = realClock,
  given: SignInRetry = ACCOUNT_LOGIN,
): Promise<OAuthLogin> {
  const retry = given.withDevice(server.device !== null).asCode();
  if (!server.device)
    fail("device_flow_unavailable", "This gateway does not offer sign-in with a code.", retry.onBrowserMachine(), 3);
  const opened = await transport.postForm(url, server.device, { client_id: CLI_CLIENT_ID, scope: grant, resource: server.issuer });
  const data = opened.data;
  const deviceCode = data["device_code"];
  const userCode = data["user_code"];
  const verification = data["verification_uri"];
  if (opened.status !== 200) tokenRefusal(opened, "Starting the sign-in", retry);
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verification !== "string")
    fail("invalid_response", "The gateway answered the sign-in request with an unusable body.", retry.again(), 3);
  // The person opens these, so they too must be on the gateway's own origin.
  pathOn(url, verification, "sign-in page", retry.again());
  const complete = typeof data["verification_uri_complete"] === "string" ? (data["verification_uri_complete"] as string) : null;
  if (complete) pathOn(url, complete, "sign-in page", retry.again());
  const expiresIn = typeof data["expires_in"] === "number" ? (data["expires_in"] as number) : 600;
  let interval = typeof data["interval"] === "number" && (data["interval"] as number) > 0 ? (data["interval"] as number) : 5;
  show({ userCode, verificationUri: verification, verificationUriComplete: complete, expiresIn });
  const deadline = clock.now() + expiresIn * 1000;
  while (clock.now() < deadline) {
    await clock.sleep(interval * 1000);
    const answer = await transport.postForm(url, server.token, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: CLI_CLIENT_ID,
    });
    if (answer.status === 200) return loginFrom(answer, clock.now(), newLoginId(), retry);
    const error = answer.data["error"];
    if (error === "authorization_pending") continue;
    // RFC 8628 §3.5: every slow_down adds five seconds to the interval.
    if (error === "slow_down") {
      interval += 5;
      continue;
    }
    if (error === "access_denied") fail("login_denied", "The sign-in was declined in the browser.", retry.startOver(), 4);
    if (error === "expired_token") break;
    tokenRefusal(answer, "The sign-in", retry);
  }
  fail("login_expired", "The sign-in code expired before it was approved.", retry.newCode(), 4);
}

/**
 * Trades the refresh token for a new pair. `null` means the sign-in has ended
 * (revoked, expired, or the token was already used), so a new sign-in is
 * needed; any other failure is thrown.
 */
export async function refresh(
  transport: OAuthTransport,
  url: string,
  login: OAuthLogin,
  now: () => number = Date.now,
): Promise<OAuthLogin | null> {
  const answer = await transport.postForm(url, `${V2_PATH}/oauth/token`, {
    grant_type: "refresh_token",
    refresh_token: login.refreshToken,
    client_id: login.clientId,
    resource: url + V2_PATH,
  });
  if (answer.status === 200) return loginFrom(answer, now(), login.id);
  if (answer.data["error"] === "invalid_grant") return null;
  tokenRefusal(answer, "Renewing the sign-in");
}

/** Revokes a sign-in (RFC 7009). True when the gateway accepted it. */
export async function revoke(transport: OAuthTransport, url: string, login: OAuthLogin): Promise<boolean> {
  const answer = await transport.postForm(url, `${V2_PATH}/oauth/revoke`, {
    token: login.refreshToken,
    token_type_hint: "refresh_token",
    client_id: login.clientId,
  });
  return answer.status === 200;
}
