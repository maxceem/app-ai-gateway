/**
 * Where a request to a provider goes, and the credentials it carries. The one
 * place this is decided, for live requests and key tests alike, so the two
 * always reach the same host with the same headers.
 *
 * - Direct: the connection's base URL, or the provider's host, with the
 *   provider's key in the provider's own header.
 * - Through Cloudflare AI Gateway (D13): Cloudflare's URL for the account and
 *   gateway, then the provider's name in Cloudflare's URL space. Cloudflare's
 *   token goes in `cf-aig-authorization`. The provider's key, when the
 *   connection keeps one, goes in the provider's own header, and Cloudflare
 *   passes it on; without one, Cloudflare uses the keys in its own key store.
 *   Cloudflare returns the provider's own response, so nothing else changes.
 *
 * A provider's own attribution headers (Vercel's) are set here too, from the
 * connection's own type. Client
 * headers are chosen before this (`src/proxy/headers.ts`) and never carry any
 * of these: whatever this sets wins.
 */
import { GatewayError } from "../core/errors.ts";
import {
  CLOUDFLARE_AI_GATEWAY_ORIGIN,
  upstreamOrigin,
  type ConnectionRecord,
  type UpstreamCredentials,
} from "./connections.ts";
import type { ApiStyle, ProviderAuth, ProviderDescription } from "./operation.ts";

/** Cloudflare AI Gateway's own request headers that an app may send: caching and retries (v1). */
const CLOUDFLARE_CLIENT_HEADERS: readonly string[] = [
  "cf-aig-cache-ttl",
  "cf-aig-skip-cache",
  "cf-aig-max-attempts",
  "cf-aig-backoff",
  "cf-aig-retry-delay",
];

export interface UpstreamRequestInput {
  /** The description's host key: `main` unless the operation names another. */
  readonly hostKey: string;
  /** The upstream path, without a leading `/`. */
  readonly path: string;
  /** The query string, with its `?`, or "". */
  readonly query: string;
  /** The operation's API style, which may choose how the key is sent (`authByStyle`). None for a key test. */
  readonly style?: ApiStyle;
  readonly credentials: UpstreamCredentials;
  /**
   * The app's request headers, for the Cloudflare headers it may send, with
   * the gateway's own credentials and end-user ids already taken out: a header
   * an app's sign-in uses is never forwarded, whatever its name.
   */
  readonly client?: Headers;
  readonly appId: string;
  readonly userId: string | null;
}

export interface UpstreamRequest {
  readonly url: string;
  /** Set on the outgoing headers last, over anything else. */
  readonly headers: Readonly<Record<string, string>>;
  /** The header the provider key is sent in (`keyAuth`): never forwarded from the client, never passed back to it. */
  readonly keyHeader: string;
}

/**
 * How a connection's provider key is sent for an operation of `style`: through
 * Cloudflare AI Gateway, the way Cloudflare's endpoint for that style takes it
 * (`authByStyle`), else the provider's own way. The one place this is decided.
 */
export function keyAuth(
  connection: { readonly cloudflareGateway: object | null },
  description: ProviderDescription,
  style: ApiStyle | undefined,
): ProviderAuth {
  if (connection.cloudflareGateway === null) return description.auth;
  return (style !== undefined ? description.cloudflareGateway?.authByStyle?.[style] : undefined) ?? description.auth;
}

/** The provider's key, in the header and format given. A callback, so a key with `$&` is sent as it is. */
function providerAuth(auth: ProviderAuth, key: string): Record<string, string> {
  return { [auth.header]: auth.format.replace("{key}", () => key) };
}

/**
 * JSON with every character past ASCII escaped, so it can be a header value:
 * a user id from the app's own sign-in may hold any character, and a header
 * outside the ByteString range would make every request of that user fail.
 */
function asciiJson(value: unknown): string {
  // No `u` flag on purpose: each half of a surrogate pair is escaped on its own, which JSON reads back as one character.
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * A test deployment's stand-in for Cloudflare AI Gateway (the mock), set at
 * build time by `define` in its own gitignored Wrangler config, and in no other
 * build. Nothing at run time can set it: a Worker variable could otherwise
 * send Cloudflare tokens and provider keys to any origin.
 */
declare const __TEST_CLOUDFLARE_AI_GATEWAY_ORIGIN__: string | undefined;

/** Where requests through Cloudflare AI Gateway go: Cloudflare, unless this is a test deployment's build. */
export function cloudflareOrigin(): string {
  const moved = typeof __TEST_CLOUDFLARE_AI_GATEWAY_ORIGIN__ === "string" ? __TEST_CLOUDFLARE_AI_GATEWAY_ORIGIN__ : "";
  if (moved === "") return CLOUDFLARE_AI_GATEWAY_ORIGIN;
  return moved.endsWith("/") ? moved : `${moved}/`;
}

/** The connection type's own request decoration (`attributionHeaders`). */
function attribution(description: ProviderDescription, input: UpstreamRequestInput): Record<string, string> {
  return { ...(description.attributionHeaders?.({ appId: input.appId, userId: input.userId }) ?? {}) };
}

/** The URL and headers of one request to a connection's provider. */
export function upstreamRequest(
  connection: ConnectionRecord,
  description: ProviderDescription,
  input: UpstreamRequestInput,
): UpstreamRequest {
  const gateway = connection.cloudflareGateway;
  if (gateway === null) {
    if (input.credentials.providerKey === null) {
      throw new GatewayError(502, "provider_unavailable", "Provider credential is missing");
    }
    const url = `${upstreamOrigin(connection, description, input.hostKey)}${input.path}${input.query}`;
    return {
      url,
      headers: { ...attribution(description, input), ...providerAuth(description.auth, input.credentials.providerKey) },
      keyHeader: description.auth.header.toLowerCase(),
    };
  }
  const route = description.cloudflareGateway;
  if (route === undefined || input.credentials.cloudflareToken === null) {
    throw new GatewayError(502, "provider_unavailable", `${description.label} cannot be reached through Cloudflare AI Gateway`);
  }
  // Cloudflare serves a provider's main API only.
  if (input.hostKey !== "main") {
    throw new GatewayError(502, "provider_unavailable", "This operation cannot be sent through Cloudflare AI Gateway");
  }
  const prefix = route.stripPathPrefix;
  const path = prefix !== undefined && input.path.startsWith(prefix) ? input.path.slice(prefix.length) : input.path;
  const headers: Record<string, string> = {};
  input.client?.forEach((value, name) => {
    if (CLOUDFLARE_CLIENT_HEADERS.includes(name.toLowerCase())) headers[name.toLowerCase()] = value;
  });
  const url = `${cloudflareOrigin()}v1/${encodeURIComponent(gateway.accountId)}/${encodeURIComponent(gateway.gatewayId)}/${route.slug}/${path}${input.query}`;
  Object.assign(headers, attribution(description, input), {
    "cf-aig-authorization": `Bearer ${input.credentials.cloudflareToken}`,
    // Cloudflare's own logs, under the real app and user: set here alone.
    "cf-aig-metadata": asciiJson({ app_id: input.appId, ...(input.userId === null ? {} : { user_id: input.userId }) }),
  });
  const auth = keyAuth(connection, description, input.style);
  if (input.credentials.providerKey !== null) Object.assign(headers, providerAuth(auth, input.credentials.providerKey));
  return {
    url,
    headers,
    keyHeader: auth.header.toLowerCase(),
  };
}
