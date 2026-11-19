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

/** The client's headers a provider may see. */
export function upstreamHeaders(client: Headers): Headers {
  const headers = new Headers();
  client.forEach((value, name) => {
    if (isForwardedClientHeader(name)) headers.set(name, value);
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
