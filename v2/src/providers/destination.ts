/**
 * Where a request really goes, as far as whose rules judge it: the built-in
 * provider that owns a base URL's host, and the providers Cloudflare AI
 * Gateway's endpoints reach. Refused paths and live-session token paths
 * follow the destination, not the connection's type (`./matcher.ts`): a
 * connection of one type pointed at another provider's host, or at another
 * provider's Cloudflare endpoint, is judged by that provider's rules too.
 */
import { BUILT_IN_PROVIDERS } from "./index.ts";
import type { ProviderDescription } from "./operation.ts";

/** Cloudflare AI Gateway's host: its path names the provider endpoint a request reaches. */
export const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";

/** Segments of Cloudflare AI Gateway's path up to and including the provider endpoint: `v1`, the account, the gateway, the endpoint. */
export const CLOUDFLARE_ENDPOINT_SEGMENTS = 4;

/** A provider's declared host names, lower-cased: its `hosts` and its `otherHosts`. */
export function declaredHostNames(description: ProviderDescription): readonly string[] {
  return [
    ...Object.values(description.hosts).map((value) => value.split("/")[0]!.toLowerCase()),
    ...(description.otherHosts ?? []).map((value) => value.toLowerCase()),
  ];
}

/** Whether `host` is the declared `name`, or under it for a `*.` name. */
function hostMatches(name: string, host: string): boolean {
  return name.startsWith("*.") ? host.endsWith(name.slice(1)) : host === name;
}

/** The built-in provider that declares a host name (`declaredHostNames`), or null. */
export function hostOwner(host: string): ProviderDescription | null {
  const lower = host.toLowerCase();
  return Object.values(BUILT_IN_PROVIDERS).find((description) => declaredHostNames(description).some((name) => hostMatches(name, lower))) ?? null;
}

/**
 * The built-in provider whose host a base URL is on, or null. Compared on
 * the host name alone, so a base URL with its own path on that host is still
 * that provider's.
 */
export function knownHostOwner(baseUrl: string): ProviderDescription | null {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return null;
  }
  return hostOwner(host);
}

/**
 * The built-in providers Cloudflare AI Gateway reaches, each through its
 * endpoint (`cloudflareEndpoint`). This is where a request on Cloudflare's
 * host goes, whether or not a connection of that type may use the
 * `cloudflareGateway` setting. An endpoint name not here reaches nothing v2
 * knows, so it gets no provider's rules, as a custom upstream would.
 */
export const CLOUDFLARE_PROVIDERS: readonly ProviderDescription[] = Object.values(BUILT_IN_PROVIDERS).filter(
  (description) => description.cloudflareEndpoint !== undefined,
);

/** The built-in provider Cloudflare AI Gateway's endpoint `slug` reaches, or null. */
export function cloudflareEndpointOwner(slug: string): ProviderDescription | null {
  const lower = slug.toLowerCase();
  return CLOUDFLARE_PROVIDERS.find((description) => description.cloudflareEndpoint!.slug.toLowerCase() === lower) ?? null;
}

/** The path prefix Cloudflare's endpoint for a provider adds back (`cloudflareEndpoint.stripPathPrefix`), in segments. */
export function cloudflarePrefixOf(description: ProviderDescription): readonly string[] {
  return (description.cloudflareEndpoint?.stripPathPrefix ?? "").split("/").filter((piece) => piece !== "");
}

/**
 * Why a built-in connection of `description` may not be saved with
 * `baseUrl`, or null: the base URL is another provider's host, or names
 * another Cloudflare AI Gateway endpoint than its own. Its requests would
 * reach that provider, whose rules then judge them anyway; saving says so
 * instead. A Cloudflare base URL that stops before the endpoint is allowed:
 * each request names its endpoint, and is judged by its provider.
 */
export function baseUrlOwnerProblem(description: ProviderDescription, baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === CLOUDFLARE_AI_GATEWAY_HOST) {
    const endpoint = url.pathname.split("/").filter((piece) => piece !== "")[CLOUDFLARE_ENDPOINT_SEGMENTS - 1];
    if (endpoint === undefined) return null;
    const other = cloudflareEndpointOwner(endpoint);
    if (other !== null && other.type === description.type) return null;
    return other === null
      ? `this base URL reaches Cloudflare AI Gateway's ${endpoint} endpoint, not ${description.label}'s; use ${description.label}'s own endpoint`
      : `this base URL reaches ${other.label} through Cloudflare AI Gateway; use a ${other.label} connection for it`;
  }
  const owner = hostOwner(host);
  if (owner === null || owner.type === description.type) return null;
  return `${host} is ${owner.label}'s host; use a ${owner.label} connection for it, or a custom provider`;
}
