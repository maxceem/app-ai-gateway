import { eq } from "drizzle-orm";
import { database, type Database } from "../db";
import {
  provider as providerTable,
  providerGateway as providerGatewayTable,
  type GatewayRouteConfig,
  type ProviderGatewayConfig,
  type ProviderGatewayStatus,
  type ProviderPricing,
  type ProviderStatus,
} from "../db/schema";
import { isVaultTransportFailure } from "../vault";
import { openSecret } from "../vault/secrets";
import type { ProviderRoute } from "./capabilities";
import { GatewayError } from "./errors";
import { log } from "./log";
import { ttlCache } from "./ttl-cache";
import {
  DIRECT_ROUTE,
  isGatewayType,
  routeThroughGateway,
  type ResolvedRoute,
} from "./routes";
import { recordFromEntries } from "../shared/records";
import type { ProviderType } from "./types";

export interface ResolvedProvider {
  id: string;
  slug: string;
  type: ProviderType;
  /** Provider key for direct rows; gateway token for routed rows. */
  secret: string;
  /**
   * How this instance reaches its provider: the adapter that carries it, the
   * gateway row behind it where there is one, and that row's own routing
   * configuration. Resolved once, here, and passed around whole — nothing
   * downstream reassembles it or asks whether a gateway is present.
   */
  route: ResolvedRoute;
  /**
   * The operator's own origin for this instance, replacing the provider type's
   * `directBaseUrl`. Canonicalized by the origin guard before it was stored, and
   * always null on a gateway-routed row: the gateway owns that transport, so a
   * base URL there would be a silently ignored setting rather than a route.
   */
  baseUrl: string | null;
  pricing: ProviderPricing | null;
}

interface ProviderRow {
  id: string;
  slug: string;
  type: ProviderType;
  status: ProviderStatus;
  secretBlob: string | null;
  providerGatewayId: string | null;
  /**
   * The attached gateway's stored type and status, read whatever that status
   * is. A revoked gateway cannot carry traffic, but it still says what this row
   * *is*, which is what configuration has to be judged against — see
   * {@link OrganizationProvider.route}.
   */
  gatewayType: string | null;
  gatewayStatus: ProviderGatewayStatus | null;
  gatewayConfig: ProviderGatewayConfig | null;
  gatewaySecretBlob: string | null;
  gatewayRoute: GatewayRouteConfig | null;
  baseUrl: string | null;
  pricing: ProviderPricing | null;
}

export interface OrganizationProvider {
  id: string;
  slug: string;
  type: ProviderType;
  /**
   * How this instance reaches its provider, so configuration can be validated
   * against the same capability matrix requests are.
   *
   * A row attached to a gateway never reads as `direct`, whatever state that
   * gateway is in. Reading a revoked row as direct judged it against the
   * provider's *full* API surface, so a configuration the matrix approved —
   * a transcription endpoint on a Vercel-routed OpenAI row, say — started
   * answering 502 the moment the gateway came back. `null` where the stored
   * gateway type has no adapter at all: the row's real capabilities are not
   * knowable here, so it is treated as unroutable rather than guessed at.
   */
  route: ProviderRoute | null;
  pricing: ProviderPricing | null;
  /**
   * `disabled` rows stay in the index so configuration referencing them remains
   * editable, and so their slug still resolves to something: they hold it until
   * deleted. Requests to them fail with provider_disabled until re-enabled.
   */
  status: ProviderStatus;
}

/**
 * Provider instances indexed by their caller-visible slug, disabled rows
 * included. A slug is held by exactly one row until that row is deleted, so
 * every entry is unambiguous whatever its status.
 */
export type OrganizationProviders = Record<string, OrganizationProvider>;

const CACHE_TTL_MS = 60_000;

/**
 * How long an expired decrypt stays usable once the vault stops answering.
 *
 * A credential this isolate decrypted a minute ago is known state, and cf-kms
 * being unreachable is not a reason to stop spending it. An hour rides out a
 * cf-kms deploy or a network blip while still being far shorter than the
 * lifetime of a provider key, and a rotation writes a new blob, which is a new
 * cache key, so a replaced key is never served from here.
 */
const SECRET_STALE_MAX_MS = 60 * 60_000;

/**
 * One row set per organization: the ids come from D1 and no caller can invent
 * one, but a long-lived isolate in a large deployment would otherwise keep a
 * row set for every organization it ever served.
 *
 * Exported so tests can read its keys and narrow its bound; nothing in the
 * Worker reads it but this file.
 */
export const providerRowsCache = ttlCache<string, ProviderRow[]>({
  name: "provider-rows",
  ttlMs: CACHE_TTL_MS,
  maxEntries: 5_000,
});

/**
 * Decrypted secrets, keyed by the complete authenticated identity plus blob,
 * which is what makes an entry rotation-safe. Blobs come from D1, so this is
 * not caller-growable either, but the same long-running isolate would keep one
 * entry per blob it ever saw, rotations included.
 */
export const providerSecretCache = ttlCache<string, string>({
  name: "provider-secret",
  ttlMs: CACHE_TTL_MS,
  maxEntries: 5_000,
});

function secretCacheKey(
  kind: "providerKey" | "providerGatewayToken",
  identity: readonly string[],
  blob: string,
): string {
  // JSON arrays are unambiguous even when a D1-controlled value contains the
  // separator another encoding might choose. The cache must distinguish every
  // value the vault authenticates or a warm entry could bypass that check.
  return JSON.stringify([kind, ...identity, blob]);
}

/**
 * The last plaintext decrypted from this exact blob, when the vault has just
 * failed in a way another attempt could survive and the value is still inside
 * {@link SECRET_STALE_MAX_MS}. Null for a configuration fault, which does not
 * heal on its own and must surface instead of being papered over.
 *
 * Nothing is refreshed: the entry keeps its original expiry, so the next
 * request goes back to the vault.
 */
function staleSecret(key: string, error: unknown): { secret: string; ageMs: number } | null {
  if (!isVaultTransportFailure(error)) return null;
  // Read past its expiry deliberately, which is the whole point of this path.
  const cached = providerSecretCache.peek(key);
  if (!cached) return null;
  const now = Date.now();
  if (now - cached.expiresAt >= SECRET_STALE_MAX_MS) return null;
  return { secret: cached.value, ageMs: now - cached.storedAt };
}

export function invalidateOrganizationProviders(organizationId: string): void {
  providerRowsCache.delete(organizationId);
}

async function queryOrganizationRows(
  db: Database,
  organizationId: string,
): Promise<ProviderRow[]> {
  return db
    .select({
      id: providerTable.id,
      slug: providerTable.slug,
      type: providerTable.type,
      status: providerTable.status,
      secretBlob: providerTable.secretBlob,
      providerGatewayId: providerTable.providerGatewayId,
      gatewayType: providerGatewayTable.type,
      gatewayStatus: providerGatewayTable.status,
      gatewayConfig: providerGatewayTable.config,
      gatewaySecretBlob: providerGatewayTable.secretBlob,
      gatewayRoute: providerTable.gatewayRoute,
      baseUrl: providerTable.baseUrl,
      pricing: providerTable.pricing,
    })
    .from(providerTable)
    // Joined on the id alone, revoked gateways included: what a row *is* is a
    // different question from whether it can serve traffic right now, and only
    // this query can answer the first. Every reader of the joined columns gates
    // on `gatewayStatus` itself, which keeps the two questions apart instead of
    // hiding the second one in a join condition.
    .leftJoin(
      providerGatewayTable,
      eq(providerTable.providerGatewayId, providerGatewayTable.id),
    )
    // Disabled rows included: "this slug is paused" and "this slug does not
    // exist" are different answers, and only the full set can tell them apart.
    // They hold their slug too, so including them costs no ambiguity.
    .where(eq(providerTable.organizationId, organizationId));
}

async function organizationRows(env: Env, organizationId: string): Promise<ProviderRow[]> {
  const cached = providerRowsCache.get(organizationId);
  if (cached) return cached;
  // Fill from the authoritative primary. The row-cache TTL is the only
  // intentional configuration staleness window on the data plane.
  const rows = await queryOrganizationRows(database(env.DB), organizationId);
  providerRowsCache.set(organizationId, rows);
  return rows;
}

async function plaintextSecret(
  env: Env,
  organizationId: string,
  row: ProviderRow,
): Promise<string> {
  const gatewayRouted = row.providerGatewayId !== null;
  // A revoked gateway's token is not a credential this row may still spend
  // with, so it reads as absent — the join no longer filters it out.
  const blob = gatewayRouted
    ? (row.gatewayStatus === "active" ? row.gatewaySecretBlob : null)
    : row.secretBlob;
  if (!blob) {
    throw new GatewayError(
      502,
      "provider_unavailable",
      gatewayRouted
        ? "Provider gateway is missing or revoked"
        : "Provider credential is missing",
    );
  }
  if (row.providerGatewayId !== null) {
    return decryptProviderGatewaySecret(env, organizationId, row.providerGatewayId, blob);
  }
  const identity: [string, string, string, string] = [
    organizationId,
    row.id,
    row.type,
    row.baseUrl ?? "",
  ];
  const key = secretCacheKey("providerKey", identity, blob);
  const cached = providerSecretCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const secret = await openSecret(env, "providerKey", identity, blob);
    providerSecretCache.set(key, secret);
    return secret;
  } catch (error) {
    const stale = staleSecret(key, error);
    if (stale) {
      log("warn", "provider_secret_stale", {
        organizationId,
        providerId: row.id,
        providerSlug: row.slug,
        providerType: row.type,
        ageMs: stale.ageMs,
        error: error instanceof Error ? error.message : String(error),
      });
      return stale.secret;
    }
    log("error", "provider_secret_unavailable", {
      organizationId,
      providerId: row.id,
      providerSlug: row.slug,
      providerType: row.type,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new GatewayError(502, "provider_unavailable", "Provider credential could not be read");
  }
}

/** Decrypts a reusable gateway token once per authenticated identity and blob. */
export async function decryptProviderGatewaySecret(
  env: Env,
  organizationId: string,
  providerGatewayId: string,
  secretBlob: string,
): Promise<string> {
  const identity: [string, string] = [organizationId, providerGatewayId];
  const key = secretCacheKey("providerGatewayToken", identity, secretBlob);
  const cached = providerSecretCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const secret = await openSecret(
      env,
      "providerGatewayToken",
      identity,
      secretBlob,
    );
    providerSecretCache.set(key, secret);
    return secret;
  } catch (error) {
    const stale = staleSecret(key, error);
    if (stale) {
      log("warn", "provider_secret_stale", {
        organizationId,
        providerGatewayId,
        ageMs: stale.ageMs,
        error: error instanceof Error ? error.message : String(error),
      });
      return stale.secret;
    }
    log("error", "provider_gateway_secret_unavailable", {
      organizationId,
      providerGatewayId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new GatewayError(502, "provider_unavailable", "Provider gateway credential could not be read");
  }
}

export async function resolveProvider(
  env: Env,
  organizationId: string,
  slug: string,
): Promise<ResolvedProvider | null> {
  // One row per slug, so this is the row the slug means whatever its status.
  // A paused slug is not a missing one — that is an error of its own, so
  // re-enabling under Providers is what the operator gets told.
  const row = (await organizationRows(env, organizationId)).find((entry) => entry.slug === slug);
  if (!row) return null;
  if (row.status === "disabled") {
    throw new GatewayError(
      502,
      "provider_disabled",
      `Provider instance ${slug} is disabled; enable it under Providers in the console`,
    );
  }
  // A gateway type the column admits but no adapter implements is unroutable
  // here, exactly like a revoked one: the database is permissive, the adapter
  // registry decides. This is the only place a stored gateway type is joined to
  // its adapter.
  const gateway = row.providerGatewayId === null
    ? null
    : row.gatewayStatus === "active"
        && row.gatewayType
        && row.gatewayConfig
        && isGatewayType(row.gatewayType)
      ? { id: row.providerGatewayId, type: row.gatewayType, config: row.gatewayConfig }
      : null;
  if (row.providerGatewayId !== null && gateway === null) {
    throw new GatewayError(502, "provider_unavailable", "Provider gateway is missing or revoked");
  }
  return {
    id: row.id,
    slug: row.slug,
    type: row.type,
    secret: await plaintextSecret(env, organizationId, row),
    route: gateway === null ? DIRECT_ROUTE : routeThroughGateway(gateway, row.gatewayRoute),
    // Read only on a direct row. The admin routes refuse the pairing, but a row
    // that predates a gateway being attached, or one written by another tool,
    // must not quietly redirect gateway traffic somewhere else.
    baseUrl: gateway === null ? row.baseUrl : null,
    pricing: row.pricing,
  };
}

export async function requireProvider(
  env: Env,
  organizationId: string,
  slug: string,
): Promise<ResolvedProvider> {
  const resolved = await resolveProvider(env, organizationId, slug);
  if (!resolved) {
    throw new GatewayError(
      502,
      "provider_not_configured",
      `No provider instance with slug ${slug} is configured for this organization; add one under Providers in the console`,
    );
  }
  return resolved;
}

export async function organizationProviders(
  env: Env,
  organizationId: string,
): Promise<OrganizationProviders> {
  return providerIndex(await organizationRows(env, organizationId));
}

/**
 * Current provider capabilities and prices for management decisions.
 *
 * This deliberately bypasses the data-plane row cache: a save or validation
 * must be judged against the authoritative rows that exist now, while runtime
 * traffic keeps its bounded cache and its request-path warming.
 */
export async function authoritativeOrganizationProviders(
  env: Env,
  organizationId: string,
): Promise<OrganizationProviders> {
  return providerIndex(await queryOrganizationRows(database(env.DB), organizationId));
}

function providerIndex(rows: ProviderRow[]): OrganizationProviders {
  // Prototype-less: a slug like "constructor" is legal, and a plain object
  // would answer for it whether or not the organization configured one.
  return recordFromEntries(rows.map((row) => [
    row.slug,
    {
      id: row.id,
      slug: row.slug,
      type: row.type,
      status: row.status,
      // The stored type, not the resolvable one: a revoked gateway still
      // narrows what this row will be able to do when it comes back, and
      // judging it as direct in the meantime approves configuration its next
      // working request would refuse.
      route: row.providerGatewayId === null
        ? "direct"
        : row.gatewayType && isGatewayType(row.gatewayType)
          ? row.gatewayType
          : null,
      pricing: row.pricing,
    },
  ] as const));
}
