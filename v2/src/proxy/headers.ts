/**
 * Which headers cross the gateway, ported from v1.
 *
 * Toward the provider, only an allowlist of client headers is sent: what
 * official SDKs need. Everything else, including the client's own
 * credentials and proof, stays at the gateway. The provider key is set last,
 * so a client can never supply one.
 *
 * Toward the app, the provider's headers pass through, except the ones that
 * would be wrong after the body is streamed again, a provider cookie, and
 * which OpenAI organization and project the key belongs to.
 */

const FORWARDED_EXACT: ReadonlySet<string> = new Set([
  "content-type",
  "accept",
  "accept-language",
  "user-agent",
  "anthropic-version",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "openai-beta",
  "x-goog-api-client",
  "idempotency-key",
]);
const FORWARDED_PREFIXES: readonly string[] = ["x-stainless-"];

export function isForwardedClientHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return FORWARDED_EXACT.has(lower) || FORWARDED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** A copy of `client` without `names`: the gateway's own credentials, taken out before anything is forwarded. */
export function withoutHeaders(client: Headers, names: readonly string[]): Headers {
  const headers = new Headers(client);
  for (const name of names) headers.delete(name);
  return headers;
}

/**
 * Words that, as a part of a header's name (between `-`s), mean it may carry
 * a credential. Such a header is never forwarded, whatever list names it: the
 * provider key is the gateway's alone.
 */
const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  "auth",
  "authorization",
  "apikey",
  "key",
  "token",
  "secret",
  "password",
  "credential",
  "credentials",
  "cookie",
  "session",
  "signature",
]);

/** Allowlisted names with such a word that carry no credential: a retry key is a request id. */
const NOT_CREDENTIALS: ReadonlySet<string> = new Set(["idempotency-key"]);

/** Whether a header's name says it may carry a credential. */
export function mayCarryCredential(name: string): boolean {
  const lower = name.toLowerCase();
  if (NOT_CREDENTIALS.has(lower)) return false;
  return lower.split(/[-_]/u).some((word) => CREDENTIAL_WORDS.has(word));
}

/** Whether `name` is one of `extra`: an exact name, or a prefix ending in `-`. */
export function isExtraClientHeader(name: string, extra: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return extra.some((entry) => (entry.endsWith("-") ? lower.startsWith(entry) : lower === entry));
}

/**
 * The client's headers a provider may see: the allowlist, plus, on a listed
 * passthrough path, the headers its provider declares for one
 * (`passthroughHeaders`, such as Gemini's `x-goog-upload-*`). The app's own
 * credential headers were taken out before (`withoutHeaders`), and no header
 * whose name says it may carry a credential is sent (`mayCarryCredential`).
 */
export function upstreamHeaders(client: Headers, extra: readonly string[] = []): Headers {
  const headers = new Headers();
  client.forEach((value, name) => {
    const listed = isForwardedClientHeader(name) || (extra.length > 0 && isExtraClientHeader(name, extra));
    // Checked last, on every header a list lets through, `x-stainless-*` included.
    if (listed && !mayCarryCredential(name)) headers.set(name, value);
  });
  return headers;
}

const STRIPPED_RESPONSE_HEADERS: readonly string[] = [
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "set-cookie",
  "openai-organization",
  "openai-project",
];

/** The provider's headers an app may see. */
export function clientResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name);
  return headers;
}
