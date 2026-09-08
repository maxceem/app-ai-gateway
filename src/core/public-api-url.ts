/**
 * The origin a deployment advertises to application clients.
 *
 * One Worker can answer on two custom domains: the console host operators sign
 * in to, and an API host the iOS apps and servers call. `PUBLIC_API_URL` names
 * the second one so the console prints it as the client base URL instead of its
 * own origin. Unset — the self-hosted default — means there is no second host
 * and nothing here runs.
 *
 * The value is deployment configuration, not client input, so the rules exist
 * to catch an operator typo early and loudly rather than to contain an
 * attacker: a path or a query here would silently produce base URLs no client
 * can call.
 *
 * Deliberately import-free: the host guard reads it on every request that
 * reaches `/v1/auth/*` or `/v1/console/*`.
 */

/** Loopback names, the only hosts allowed to drop TLS, so local dev can test this. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

/**
 * Last parsed value, keyed by the raw string it came from. One deployment only
 * ever has one, but tests hand different envs to the same isolate, so the key
 * is the string rather than "already resolved".
 */
let cached: { raw: string; url: URL } | undefined;

function parse(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PUBLIC_API_URL must be an absolute URL, for example https://api.example.com");
  }
  const loopback = LOOPBACK_HOSTNAMES.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("PUBLIC_API_URL must use https, except on localhost");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("PUBLIC_API_URL must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("PUBLIC_API_URL must not contain a query string or fragment");
  }
  if (url.pathname !== "/") {
    throw new Error(`PUBLIC_API_URL must be an origin with no path; got ${url.pathname}`);
  }
  return url;
}

function configured(env: Env): URL | undefined {
  const raw = env.PUBLIC_API_URL?.trim();
  if (!raw) return undefined;
  if (cached?.raw === raw) return cached.url;
  const url = parse(raw);
  cached = { raw, url };
  return url;
}

/** The advertised origin, with no trailing slash, or undefined when unset. */
export function publicApiOrigin(env: Env): string | undefined {
  return configured(env)?.origin;
}

/** The advertised host, lower-cased by the URL parser, for comparing with a request's. */
export function publicApiHost(env: Env): string | undefined {
  return configured(env)?.host;
}
