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
  upstreamOrigin,
  type ConnectionRecord,
  type SealedCredentials,
  type UpstreamCredentials,
} from "./connections.ts";
import type { SealedCallCredentials, SealedCloudflareToken, SealedProviderKey } from "../vault/client.ts";
import type { ApiStyle, ProviderAuth, ProviderDescription } from "./operation.ts";
import { cloudflareGatewayOrigin } from "./destinations.ts";

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
  /** A listed passthrough path: it always goes to the connection's base URL, if one is set. */
  readonly passthrough?: boolean;
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

export { cloudflareOrigin } from "./destinations.ts";

/** The connection type's own request decoration (`attributionHeaders`). */
function attribution(description: ProviderDescription, input: Pick<UpstreamRequestInput, "appId" | "userId">): Record<string, string> {
  return { ...(description.attributionHeaders?.({ appId: input.appId, userId: input.userId }) ?? {}) };
}

/**
 * The URL of one request to a connection's provider, without credentials: the
 * same place `upstreamRequest` sends it. Throws as `upstreamRequest` does for
 * a request Cloudflare AI Gateway cannot carry.
 */
export function upstreamUrl(
  connection: ConnectionRecord,
  description: ProviderDescription,
  input: Pick<UpstreamRequestInput, "hostKey" | "path" | "query" | "passthrough">,
): string {
  const gateway = connection.cloudflareGateway;
  if (gateway === null) return `${upstreamOrigin(connection, description, input.hostKey, input.passthrough === true)}${input.path}${input.query}`;
  const route = description.cloudflareGateway;
  if (route === undefined) {
    throw new GatewayError(502, "provider_unavailable", `${description.label} cannot be reached through Cloudflare AI Gateway`);
  }
  // Cloudflare serves a provider's main API only.
  if (input.hostKey !== "main") {
    throw new GatewayError(502, "provider_unavailable", "This operation cannot be sent through Cloudflare AI Gateway");
  }
  const prefix = route.stripPathPrefix;
  const path = prefix !== undefined && input.path.startsWith(prefix) ? input.path.slice(prefix.length) : input.path;
  const origin = cloudflareGatewayOrigin(gateway);
  // Ids saved before the rule could change the address once parsed: nothing is sent there.
  if (origin === null) {
    throw new GatewayError(502, "provider_unavailable", "This connection's Cloudflare AI Gateway ids are not plain path segments; save them again");
  }
  return `${origin}${route.slug}/${path}${input.query}`;
}

/** Where one request goes and its headers, without any credential, and how the credentials go in. */
interface UpstreamTarget {
  readonly url: string;
  readonly headers: Record<string, string>;
  /** The provider key's header and format, or null when no provider key is sent. */
  readonly keyAuth: ProviderAuth | null;
  /** Whether a Cloudflare AI Gateway token is sent. */
  readonly cloudflare: boolean;
}

function upstreamTarget(
  connection: ConnectionRecord,
  description: ProviderDescription,
  input: Omit<UpstreamRequestInput, "credentials"> & { readonly hasProviderKey: boolean; readonly hasCloudflareToken: boolean },
): UpstreamTarget {
  const gateway = connection.cloudflareGateway;
  if (gateway === null) {
    if (!input.hasProviderKey) {
      throw new GatewayError(502, "provider_unavailable", "Provider credential is missing");
    }
    return { url: upstreamUrl(connection, description, input), headers: attribution(description, input), keyAuth: description.auth, cloudflare: false };
  }
  if (!input.hasCloudflareToken) {
    throw new GatewayError(502, "provider_unavailable", `${description.label} cannot be reached through Cloudflare AI Gateway`);
  }
  const url = upstreamUrl(connection, description, input);
  const headers: Record<string, string> = {};
  input.client?.forEach((value, name) => {
    if (CLOUDFLARE_CLIENT_HEADERS.includes(name.toLowerCase())) headers[name.toLowerCase()] = value;
  });
  Object.assign(headers, attribution(description, input), {
    // Cloudflare's own logs, under the real app and user: set here alone.
    "cf-aig-metadata": asciiJson({ app_id: input.appId, ...(input.userId === null ? {} : { user_id: input.userId }) }),
  });
  return { url, headers, keyAuth: input.hasProviderKey ? keyAuth(connection, description, input.style) : null, cloudflare: true };
}

/**
 * The URL and headers of one request to a connection's provider, with the
 * opened credentials in them: for the work that does not go through the vault
 * yet (jobs, the key test). Calls go through `sealedUpstreamRequest`.
 */
export function upstreamRequest(
  connection: ConnectionRecord,
  description: ProviderDescription,
  input: UpstreamRequestInput,
): UpstreamRequest {
  const { credentials } = input;
  const target = upstreamTarget(connection, description, {
    ...input,
    hasProviderKey: credentials.providerKey !== null,
    hasCloudflareToken: credentials.cloudflareToken !== null,
  });
  const headers = { ...target.headers };
  if (target.cloudflare && credentials.cloudflareToken !== null) headers["cf-aig-authorization"] = `Bearer ${credentials.cloudflareToken}`;
  if (target.keyAuth !== null && credentials.providerKey !== null) Object.assign(headers, providerAuth(target.keyAuth, credentials.providerKey));
  return { url: target.url, headers, keyHeader: (target.keyAuth ?? keyAuth(connection, description, input.style)).header.toLowerCase() };
}

/** One request whose credentials stay sealed: the vault adds them (`src/vault/client.ts`). */
export interface SealedUpstreamRequest {
  readonly url: string;
  /** Set on the outgoing headers last, over anything else. Never a credential. */
  readonly headers: Readonly<Record<string, string>>;
  /** The header the provider key is sent in: never forwarded from the client, never passed back to it. */
  readonly keyHeader: string;
  readonly credentials: SealedCallCredentials;
}

/** The URL and headers of one request to a connection's provider, with its credentials sealed for the vault. */
export function sealedUpstreamRequest(
  connection: ConnectionRecord,
  description: ProviderDescription,
  input: Omit<UpstreamRequestInput, "credentials"> & { readonly credentials: SealedCredentials },
): SealedUpstreamRequest {
  const { credentials } = input;
  const target = upstreamTarget(connection, description, {
    ...input,
    hasProviderKey: credentials.providerKey !== null,
    hasCloudflareToken: credentials.cloudflareToken !== null,
  });
  const sealed: { providerKey?: SealedProviderKey; cloudflareToken?: SealedCloudflareToken } = {};
  if (target.keyAuth !== null && credentials.providerKey !== null) {
    sealed.providerKey = { ...credentials.providerKey, header: target.keyAuth.header, format: target.keyAuth.format };
  }
  if (target.cloudflare && credentials.cloudflareToken !== null) sealed.cloudflareToken = credentials.cloudflareToken;
  return {
    url: target.url,
    headers: target.headers,
    keyHeader: (target.keyAuth ?? keyAuth(connection, description, input.style)).header.toLowerCase(),
    credentials: sealed,
  };
}
