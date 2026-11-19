/**
 * How this deployment signs people in: read from the environment, never from
 * a request, and cheap enough to read anywhere. Nothing here loads the
 * sign-in library (`./identity.ts` does that).
 *
 * The settings, all optional:
 *
 * - `CONSOLE_ORIGIN`: where the console is served, such as
 *   `https://console.example.com`. The OAuth issuer is this origin plus `/v2`.
 *   Without it there is no OAuth: no CLI sign-in and no MCP connections, and
 *   the console's own API answers 404. Password and Google sign-in still work.
 * - `DEPLOYMENT_ID`: a stable public name for this deployment. Browser
 *   approvals are bound to it. Without it, the issuer is used.
 * - `ALLOWED_REGISTRATION_EMAILS`: on a self-hosted deployment, who may sign
 *   up (comma-separated; `*` admits anyone). A hosted deployment admits anyone.
 * - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: Google sign-in.
 * - `OAUTH_RELAY_URL`: a relay in front of Google's callback, for hosts that
 *   change (v1's).
 * - `OAUTH_CLIENTS`: extra registered OAuth clients, as a JSON array.
 * - `OAUTH_CIMD`: `false` stops clients from naming themselves with a
 *   metadata document.
 * - `MCP_ALLOWED_ORIGINS`: browser origins, besides the console's, that may
 *   call the OAuth endpoints.
 * - `TERMS_OF_SERVICE_URL`, `PRIVACY_POLICY_URL`: shown on the sign-up page.
 */
import { billingBinding } from "../billing/contract.ts";
import { log } from "../core/log.ts";

/** One optional string setting, trimmed; undefined when unset or blank. */
export function setting(env: Env, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Where every v2 sign-in, OAuth and console path starts. */
export const V2_PATH = "/v2";

/** `localhost`, or a name under it whose every label is non-empty. */
const LOCALHOST_NAME = /^(?:localhost|(?:[^.]+\.)+localhost)$/u;

/** A host that can only be this machine (RFC 6761 §6.3 for `.localhost`). */
export function loopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || LOCALHOST_NAME.test(hostname);
}

/** HTTPS, or plain HTTP on a loopback host for local development; never with credentials. */
export function secureOrigin(url: URL): boolean {
  return (url.protocol === "https:" || (url.protocol === "http:" && loopbackHost(url.hostname)))
    && !url.username
    && !url.password;
}

/**
 * `CONSOLE_ORIGIN` as an origin, or null when it is unset or not one a
 * sign-in may be bound to. A bad value is logged once per isolate, by name.
 */
export function consoleOrigin(env: Env): string | null {
  const raw = setting(env, "CONSOLE_ORIGIN");
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    warnOnce("console_origin_ignored", "CONSOLE_ORIGIN is not a URL");
    return null;
  }
  if (!secureOrigin(url) || url.pathname !== "/" || url.search || url.hash) {
    warnOnce("console_origin_ignored", "CONSOLE_ORIGIN must be an https origin (http only on a loopback host)");
    return null;
  }
  return url.origin;
}

/** The OAuth issuer: the console origin plus `/v2`, or null where there is no console origin. */
export function oauthIssuer(env: Env): string | null {
  const origin = consoleOrigin(env);
  return origin === null ? null : `${origin}${V2_PATH}`;
}

/** What browser approvals are bound to: `DEPLOYMENT_ID`, or else the issuer. Null without either. */
export function operationsRealm(env: Env): string | null {
  return setting(env, "DEPLOYMENT_ID") ?? oauthIssuer(env);
}

/** A hosted deployment is one with the billing service bound. */
export function hostedDeployment(env: Env): boolean {
  return billingBinding(env) !== null;
}

/** `ALLOWED_REGISTRATION_EMAILS`, lower case. */
function registrationEmails(env: Env): ReadonlySet<string> {
  return new Set(
    (setting(env, "ALLOWED_REGISTRATION_EMAILS") ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Whether a person with `email` may sign up: anyone when hosted, a listed email when self-hosted. */
export function registrationAllowed(env: Env, email: string | null): boolean {
  if (hostedDeployment(env)) return true;
  const emails = registrationEmails(env);
  return emails.has("*") || (email !== null && emails.has(email.trim().toLowerCase()));
}

/** Whether anyone at all could sign up here, which the console asks before offering it. */
export function registrationOpen(env: Env): boolean {
  return hostedDeployment(env) || registrationEmails(env).size > 0;
}

export function googleAuthEnabled(env: Env): boolean {
  return setting(env, "GOOGLE_CLIENT_ID") !== undefined && setting(env, "GOOGLE_CLIENT_SECRET") !== undefined;
}

/** Whether a client may name itself with a metadata document. On unless `OAUTH_CIMD` is `false`. */
export function cimdEnabled(env: Env): boolean {
  return setting(env, "OAUTH_CIMD")?.toLowerCase() !== "false";
}

/** The last `MCP_ALLOWED_ORIGINS` value parsed, so an isolate parses and warns about one value once. */
let parsedOrigins: { raw: string; origins: readonly string[] } | undefined;

/**
 * `MCP_ALLOWED_ORIGINS` as exact browser origins. An entry that is not an
 * exact https origin (http only on a loopback host) is dropped with a warning
 * naming its position, never its text.
 */
export function allowedBrowserOrigins(env: Env): readonly string[] {
  const value = setting(env, "MCP_ALLOWED_ORIGINS") ?? "";
  if (value === "") return [];
  if (parsedOrigins?.raw === value) return parsedOrigins.origins;
  const origins: string[] = [];
  const entries = value.split(",").map((part) => part.trim()).filter(Boolean);
  for (const [index, entry] of entries.entries()) {
    let url: URL | undefined;
    try {
      url = new URL(entry);
    } catch {
      url = undefined;
    }
    const exact = url !== undefined
      && secureOrigin(url)
      && !url.hostname.includes("*")
      && url.pathname === "/"
      && !url.search
      && !url.hash;
    if (!url || !exact) {
      log("warn", "mcp_allowed_origin_ignored", { position: index + 1 });
      continue;
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  parsedOrigins = { raw: value, origins };
  return origins;
}

const warned = new Set<string>();

function warnOnce(message: string, reason: string): void {
  const key = `${message}:${reason}`;
  if (warned.has(key)) return;
  warned.add(key);
  log("warn", message, { reason });
}
