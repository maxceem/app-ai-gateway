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
 * A provider's own attribution headers (Vercel's) are set here too. Client
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
import type { ProviderDescription } from "./operation.ts";

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
  readonly credentials: UpstreamCredentials;
  /** The app's own request headers, for the Cloudflare headers it may send. */
  readonly client?: Headers;
  readonly appId: string;
  readonly userId: string | null;
}

export interface UpstreamRequest {
  readonly url: string;
  /** Set on the outgoing headers last, over anything else. */
  readonly headers: Readonly<Record<string, string>>;
}

/** The provider's key, in the provider's own header and format. A callback, so a key with `$&` is sent as it is. */
function providerAuth(description: ProviderDescription, key: string): Record<string, string> {
  return { [description.auth.header]: description.auth.format.replace("{key}", () => key) };
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

/** Where `cloudflare_gateway` sends requests: `CLOUDFLARE_AI_GATEWAY_ORIGIN`, unless a test deployment moved it. */
function cloudflareOrigin(env: Env): string {
  const moved = (env as { CLOUDFLARE_AI_GATEWAY_ORIGIN?: string }).CLOUDFLARE_AI_GATEWAY_ORIGIN;
  if (moved === undefined || moved === "") return CLOUDFLARE_AI_GATEWAY_ORIGIN;
  return moved.endsWith("/") ? moved : `${moved}/`;
}

/** The URL and headers of one request to a connection's provider. */
export function upstreamRequest(
  env: Env,
  connection: ConnectionRecord,
  description: ProviderDescription,
  input: UpstreamRequestInput,
): UpstreamRequest {
  const attribution = description.attributionHeaders?.({ appId: input.appId, userId: input.userId }) ?? {};
  const gateway = connection.cloudflareGateway;
  if (gateway === null) {
    if (input.credentials.providerKey === null) {
      throw new GatewayError(502, "provider_unavailable", "Provider credential is missing");
    }
    return {
      url: `${upstreamOrigin(connection, description, input.hostKey)}${input.path}${input.query}`,
      headers: { ...attribution, ...providerAuth(description, input.credentials.providerKey) },
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
  Object.assign(headers, attribution, {
    "cf-aig-authorization": `Bearer ${input.credentials.cloudflareToken}`,
    // Cloudflare's own logs, under the real app and user: set here alone.
    "cf-aig-metadata": asciiJson({ app_id: input.appId, ...(input.userId === null ? {} : { user_id: input.userId }) }),
  });
  if (input.credentials.providerKey !== null) Object.assign(headers, providerAuth(description, input.credentials.providerKey));
  return {
    url: `${cloudflareOrigin(env)}v1/${encodeURIComponent(gateway.accountId)}/${encodeURIComponent(gateway.gatewayId)}/${route.slug}/${path}${input.query}`,
    headers,
  };
}
