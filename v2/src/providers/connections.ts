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
import { BUILT_IN_PROVIDERS } from "./index.ts";
import type { ProviderDescription } from "./operation.ts";

export interface ConnectionRecord {
  readonly id: string;
  readonly accountId: string;
  readonly type: string;
  readonly slug: string;
  readonly status: "active" | "disabled";
  readonly baseUrl: string | null;
  readonly secretBlob: string | null;
  readonly rates: CustomerRates | null;
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
  return readOrKnown("provider_connection", connectionCache.peek(key), async () => {
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
          };
    connectionCache.set(key, value, { storedAt: startedAt });
    return value;
  });
}

/** Forgets a connection after a management write, in this isolate. Others catch up within the cache time. */
export function invalidateConnection(accountId: string, slug: string): void {
  connectionCache.delete(cacheKey(accountId, slug));
}

/** The built-in description for a connection's type, or null for a type this build does not know. */
export function connectionDescription(connection: ConnectionRecord): ProviderDescription | null {
  return BUILT_IN_PROVIDERS[connection.type] ?? null;
}

/** Opens a connection's key. A failure is a 502: the request cannot be sent without it. */
export async function connectionSecret(env: Env, connection: ConnectionRecord): Promise<string> {
  if (connection.secretBlob === null) {
    throw new GatewayError(502, "provider_unavailable", "Provider credential is missing");
  }
  const key = `${connection.id}\u0000${connection.secretBlob}`;
  const cached = secretCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const secret = await openSecret(
      env,
      "providerKey",
      [connection.accountId, connection.id, connection.type, connection.baseUrl ?? ""],
      connection.secretBlob,
    );
    secretCache.set(key, secret);
    return secret;
  } catch (error) {
    log("error", "provider_secret_unavailable", {
      account: connection.accountId,
      connection: connection.id,
      providerType: connection.type,
      error: errorFacts(error),
    });
    throw new GatewayError(502, "provider_unavailable", "The provider credential could not be opened");
  }
}

/** The origin a request is sent to, ending in `/`: the connection's own base URL, or the provider's host. */
export function upstreamOrigin(connection: ConnectionRecord, description: ProviderDescription, hostKey: string): string {
  if (connection.baseUrl !== null && hostKey === "main") return connection.baseUrl;
  const host = description.hosts[hostKey];
  if (host === undefined) throw new GatewayError(500, "internal_error", "The provider description names an unknown host");
  return `https://${host}/`;
}
