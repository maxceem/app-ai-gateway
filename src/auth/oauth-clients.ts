import { log } from "../core/log";

/**
 * The OAuth clients a deployment registers itself, from `OAUTH_CLIENTS`.
 *
 * Parsed where the identity library is built (`./identity`), which only a
 * management, MCP or OAuth request reaches, so a proxied request on a cold
 * isolate never reads the variable. `resolveDeployment` carries the raw value.
 */

/** One client a deployment registers itself, as `OAUTH_CLIENTS` lists it. */
export interface OAuthClientRegistration {
  clientId: string;
  name: string;
  redirectUris: string[];
}

/**
 * Whether a registered client may declare `value` as a redirect URI: the
 * identity library's own rule, which refuses its whole configuration over one
 * entry that breaks it. Absolute with no fragment, and https; http on a
 * loopback host written exactly so, any port; or a private-use scheme in
 * reverse-DNS form (`com.example.app:/cb`).
 */
function acceptableRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return Boolean(url.hostname);
  if (url.protocol === "http:") {
    // The authority as written, since a loopback URI is matched by its text.
    const authority = /^http:\/\/([^/?#]*)/iu.exec(value)?.[1] ?? "";
    const match = /^(127\.0\.0\.1|\[::1\]|localhost)(?::(\d{1,5}))?$/u.exec(authority);
    return match !== null && (match[2] === undefined || Number(match[2]) <= 65535);
  }
  return /^[a-z][a-z0-9+-]*(?:\.[a-z0-9+-]+)+$/u.test(url.protocol.slice(0, -1));
}

/** The last `OAUTH_CLIENTS` value parsed, so an isolate parses and warns about one value once. */
let parsedOAuthClients: { raw: string; clients: readonly OAuthClientRegistration[] } | undefined;

/**
 * `OAUTH_CLIENTS` as the clients it registers: a JSON array of
 * `{ clientId, name, redirectUris }`. An entry the identity library would
 * refuse — and with it every sign-in on the deployment — is dropped with a
 * warning naming its position and why, never its content.
 */
export function oauthClients(raw: string | undefined): readonly OAuthClientRegistration[] {
  const value = raw?.trim() ?? "";
  if (value === "") return [];
  if (parsedOAuthClients?.raw === value) return parsedOAuthClients.clients;
  const clients: OAuthClientRegistration[] = [];
  let entries: unknown;
  try {
    entries = JSON.parse(value);
  } catch {
    entries = undefined;
  }
  if (!Array.isArray(entries)) {
    log("warn", "oauth_clients_ignored", { reason: "not a JSON array" });
  } else {
    for (const [index, entry] of entries.entries()) {
      const candidate = entry as Partial<Record<keyof OAuthClientRegistration, unknown>> | null;
      const clientId = typeof candidate?.clientId === "string" ? candidate.clientId : "";
      const name = typeof candidate?.name === "string" ? candidate.name.trim() : "";
      const redirectUris = Array.isArray(candidate?.redirectUris) ? candidate.redirectUris : [];
      const reason = !clientId || clientId !== clientId.trim() || clientId.length > 2048
        ? "clientId must be a non-empty string of at most 2048 characters with no surrounding spaces"
        : clients.some((client) => client.clientId === clientId)
          ? "clientId is declared twice"
          : !name || name.length > 200
            ? "name must be a non-empty string of at most 200 characters"
            : redirectUris.length === 0 || !redirectUris.every(acceptableRedirectUri)
              ? "redirectUris must list absolute URIs without a fragment: https, http on 127.0.0.1, [::1] or localhost, or a private-use scheme"
              : null;
      if (reason !== null) {
        log("warn", "oauth_client_ignored", { position: index + 1, reason });
        continue;
      }
      clients.push({ clientId, name, redirectUris: redirectUris as string[] });
    }
  }
  parsedOAuthClients = { raw: value, clients };
  return clients;
}
