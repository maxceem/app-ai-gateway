/**
 * Provider connections as the request path reads them: by account and slug,
 * cached in the isolate with a fallback to the last known record when D1 is
 * slow (`known_record_served`), as v1's provider store does.
 *
 * The opened key is cached in memory too, keyed by the blob it came from, so
 * a rotated key is never served from the cache. It is never logged or
 * returned.
 */
import { and, eq } from "drizzle-orm";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { readOrKnown } from "../core/stale-read.ts";
import { ttlCache } from "../core/ttl-cache.ts";
import { database } from "../db/index.ts";
import { providerConnection } from "../db/schema.ts";
import type { CustomerRates } from "../pricing/prices.ts";
import { openSecret } from "../vault/secrets.ts";
import { builtInProvider } from "./index.ts";
import type { PassthroughPath } from "./matcher.ts";
import { CUSTOM_PROVIDER_TYPE, customDescription } from "./custom.ts";
import type { ProviderAuth, ProviderDescription } from "./operation.ts";
import { readCustomAuth, readPassthrough } from "./passthrough.ts";

/** A connection's Cloudflare AI Gateway setting, as stored (D13). The token is sealed. */
export interface CloudflareGatewaySetting {
  readonly accountId: string;
  readonly gatewayId: string;
  readonly tokenBlob: string;
  readonly tokenHint: string | null;
}

export interface ConnectionRecord {
  readonly id: string;
  readonly accountId: string;
  readonly type: string;
  readonly slug: string;
  readonly status: "active" | "disabled";
  readonly baseUrl: string | null;
  readonly secretBlob: string | null;
  readonly rates: CustomerRates | null;
  /** Sending this connection's traffic through Cloudflare AI Gateway, or null. */
  readonly cloudflareGateway: CloudflareGatewaySetting | null;
  /** The serving providers pinned on every request, for a gateway that has them (`servingProvidersField`), or null. */
  readonly servingProviders: readonly string[] | null;
  /** The paths it lists for passthrough (`./passthrough.ts`). None when left out. */
  readonly passthrough?: readonly PassthroughPath[];
  /** A custom provider's key header and format (`./custom.ts`). Null or left out for a built-in provider. */
  readonly customAuth?: ProviderAuth | null;
}

/**
 * A stored `cloudflare_gateway_json`, read. Null when unset; a value that
 * does not read is null too, and logged: the connection then goes direct only
 * if it has a key of its own, and refuses otherwise.
 */
export function readCloudflareGateway(stored: unknown): CloudflareGatewaySetting | null {
  if (stored === null || stored === undefined) return null;
  let value: unknown = stored;
  if (typeof stored === "string") {
    try {
      value = JSON.parse(stored) as unknown;
    } catch (error) {
      log("error", "cloudflare_gateway_unreadable", { error: errorFacts(error) });
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { account_id: accountId, gateway_id: gatewayId, token_blob: tokenBlob, token_hint: tokenHint } = record;
  if (typeof accountId !== "string" || typeof gatewayId !== "string" || typeof tokenBlob !== "string") return null;
  return { accountId, gatewayId, tokenBlob, tokenHint: typeof tokenHint === "string" ? tokenHint : null };
}

const CONNECTION_CACHE_TTL_MS = 60_000;
const SECRET_CACHE_TTL_MS = 10 * 60_000;

const connectionCache = ttlCache<string, ConnectionRecord | null>({
  name: "provider_connection",
  ttlMs: CONNECTION_CACHE_TTL_MS,
  maxEntries: 10_000,
});
const secretCache = ttlCache<string, string>({ name: "provider_secret", ttlMs: SECRET_CACHE_TTL_MS, maxEntries: 10_000 });

function cacheKey(accountId: string, slug: string): string {
  return `${accountId}\u0000${slug}`;
}

/** The connection named by `slug` in an account, or null when there is none. */
export async function loadConnection(env: Env, accountId: string, slug: string): Promise<ConnectionRecord | null> {
  const key = cacheKey(accountId, slug);
  const cached = connectionCache.get(key);
  if (cached !== undefined) return cached;
  return readOrKnown("provider_connection", connectionCache.peek(key), () => readConnection(env, accountId, slug));
}

/**
 * A connection read from D1 now, never from this isolate's cache or a stale
 * copy: for work that must see a status another isolate just changed (the
 * sweep, before it opens a key). Throws when D1 cannot answer.
 */
export function loadConnectionFresh(env: Env, accountId: string, slug: string): Promise<ConnectionRecord | null> {
  return readConnection(env, accountId, slug);
}

async function readConnection(env: Env, accountId: string, slug: string): Promise<ConnectionRecord | null> {
  const startedAt = Date.now();
  const row = await database(env.DB).query.providerConnection.findFirst({
    where: and(eq(providerConnection.accountId, accountId), eq(providerConnection.slug, slug)),
  });
  const value: ConnectionRecord | null =
    row === undefined
      ? null
      : {
          id: row.id,
          accountId: row.accountId,
          type: row.type,
          slug: row.slug,
          status: row.status,
          baseUrl: row.baseUrl,
          secretBlob: row.secretBlob,
          rates: (row.rates as CustomerRates | null) ?? null,
          cloudflareGateway: readCloudflareGateway(row.cloudflareGateway),
          servingProviders: Array.isArray(row.servingProviders) ? row.servingProviders : null,
          passthrough: readPassthrough(row.passthrough),
          customAuth: readCustomAuth(row.passthrough),
        };
  connectionCache.set(cacheKey(accountId, slug), value, { storedAt: startedAt });
  return value;
}

/** Forgets a connection after a management write, in this isolate. Others catch up within the cache time. */
export function invalidateConnection(accountId: string, slug: string): void {
  connectionCache.delete(cacheKey(accountId, slug));
}

const CUSTOM_DESCRIPTIONS = new WeakMap<object, ProviderDescription>();

/**
 * A connection's description: the built-in one for its type, or, for a
 * custom provider, the one built from what it stores (`./custom.ts`). Null
 * for a type this build does not know, or a custom provider stored without a
 * base URL or key header, which saving never allows.
 */
export function describeConnection(connection: {
  readonly type: string;
  readonly baseUrl: string | null;
  readonly passthrough?: readonly PassthroughPath[];
  readonly customAuth?: ProviderAuth | null;
}): ProviderDescription | null {
  if (connection.type !== CUSTOM_PROVIDER_TYPE) return builtInProvider(connection.type);
  if (connection.baseUrl === null || connection.customAuth === undefined || connection.customAuth === null) return null;
  return customDescription({ baseUrl: connection.baseUrl, auth: connection.customAuth, paths: connection.passthrough ?? [] });
}

/** A loaded connection's description (`describeConnection`), built once per loaded record. */
export function connectionDescription(connection: ConnectionRecord): ProviderDescription | null {
  if (connection.type !== CUSTOM_PROVIDER_TYPE) return builtInProvider(connection.type);
  const cached = CUSTOM_DESCRIPTIONS.get(connection);
  if (cached !== undefined) return cached;
  const description = describeConnection(connection);
  if (description !== null) CUSTOM_DESCRIPTIONS.set(connection, description);
  return description;
}

/**
 * Where Cloudflare AI Gateway lives, reached only through a connection's
 * Cloudflare setting, never a base URL. Only a test deployment's own build
 * moves it (`./route.ts`).
 */
export const CLOUDFLARE_AI_GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.com/";

/**
 * The origin a connection's provider key is given for, which seals it: the
 * connection's base URL, its Cloudflare AI Gateway, or "" for the provider's
 * own host. A key is never sent anywhere else: moving a connection to a new
 * origin needs the key again (`src/admin/providers.ts`).
 */
export function keyOrigin(connection: {
  readonly baseUrl: string | null;
  readonly cloudflareGateway: { readonly accountId: string; readonly gatewayId: string } | null;
}): string {
  if (connection.baseUrl !== null) return connection.baseUrl;
  const gateway = connection.cloudflareGateway;
  if (gateway === null) return "";
  return `${CLOUDFLARE_AI_GATEWAY_ORIGIN}v1/${encodeURIComponent(gateway.accountId)}/${encodeURIComponent(gateway.gatewayId)}/`;
}

/**
 * What a connection's requests authenticate with: the provider's key, and
 * the Cloudflare AI Gateway token when its traffic goes through Cloudflare.
 * Either may be absent where the other is enough: a connection through
 * Cloudflare may keep its provider keys in Cloudflare's own key store (v1).
 */
export interface UpstreamCredentials {
  readonly providerKey: string | null;
  readonly cloudflareToken: string | null;
}

/** One sealed credential, opened once and cached by the blob it came from, so a rotated one is never served from the cache. */
async function opened(connection: ConnectionRecord, what: string, open: () => Promise<string>, blob: string): Promise<string> {
  const key = `${connection.id}\u0000${what}\u0000${blob}`;
  const cached = secretCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const secret = await open();
    secretCache.set(key, secret);
    return secret;
  } catch (error) {
    log("error", "provider_secret_unavailable", {
      account: connection.accountId,
      connection: connection.id,
      providerType: connection.type,
      credential: what,
      error: errorFacts(error),
    });
    throw new GatewayError(502, "provider_unavailable", "The provider credential could not be opened");
  }
}

/**
 * Opens a connection's credentials. A failure is a 502: the request cannot be
 * sent without them. A connection with neither a key nor a Cloudflare token
 * has nothing to send.
 */
export async function connectionCredentials(env: Env, connection: ConnectionRecord): Promise<UpstreamCredentials> {
  const gateway = connection.cloudflareGateway;
  if (connection.secretBlob === null && gateway === null) {
    throw new GatewayError(502, "provider_unavailable", "Provider credential is missing");
  }
  const providerKey =
    connection.secretBlob === null
      ? null
      : await opened(
          connection,
          "providerKey",
          () =>
            openSecret(env, "providerKey", [connection.accountId, connection.id, connection.type, keyOrigin(connection)], connection.secretBlob!),
          connection.secretBlob,
        );
  const cloudflareToken =
    gateway === null
      ? null
      : await opened(
          connection,
          "cloudflareGatewayToken",
          () => openSecret(env, "cloudflareGatewayToken", [connection.accountId, connection.id], gateway.tokenBlob),
          gateway.tokenBlob,
        );
  return { providerKey, cloudflareToken };
}

/**
 * The origin a request is sent to, ending in `/`: the connection's own base
 * URL, or the provider's host. A connection with a base URL sends every
 * request there, never to the provider's own hosts, so its key goes only
 * where the customer pointed it: the main host at the base URL itself, any
 * other host (fal's `queue`) under a path named after it, such as
 * `<base URL>queue/`.
 */
export function upstreamOrigin(connection: ConnectionRecord, description: ProviderDescription, hostKey: string): string {
  const host = description.hosts[hostKey];
  if (host === undefined) throw new GatewayError(500, "internal_error", "The provider description names an unknown host");
  if (connection.baseUrl !== null) return hostKey === "main" ? connection.baseUrl : `${connection.baseUrl}${hostKey}/`;
  return `https://${host}/`;
}
