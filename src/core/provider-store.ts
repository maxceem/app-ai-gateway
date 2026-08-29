import { and, eq } from "drizzle-orm";
import { database } from "../db";
import {
  provider as providerTable,
  providerGateway as providerGatewayTable,
  type GatewayRouteConfig,
  type ProviderGatewayConfig,
  type ProviderGatewayTypeName,
  type ProviderPricing,
} from "../db/schema";
import { secretVault } from "../vault";
import type { ProviderRoute } from "./capabilities";
import { GatewayError } from "./errors";
import { isGatewayType, resolveGateway, type ResolvedGateway } from "./gateways";
import { log } from "./log";
import { recordFromEntries } from "./records";
import type { ProviderType } from "./types";

export interface ResolvedProvider {
  id: string;
  slug: string;
  type: ProviderType;
  /** Provider key for direct rows; gateway token for routed rows. */
  secret: string;
  /**
   * Null for a direct row; otherwise the gateway that owns the transport, with
   * the id of the row it came from so usage events can attribute to it.
   */
  gateway: (ResolvedGateway & { id: string }) | null;
  /** The gateway-type-specific routing config, validated when it was stored. */
  gatewayRoute: GatewayRouteConfig | null;
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
  secretBlob: string | null;
  providerGatewayId: string | null;
  gatewayType: ProviderGatewayTypeName | null;
  gatewayConfig: ProviderGatewayConfig | null;
  gatewaySecretBlob: string | null;
  gatewayRoute: GatewayRouteConfig | null;
  baseUrl: string | null;
  pricing: ProviderPricing | null;
}

interface RowsEntry {
  expiresAt: number;
  rows: ProviderRow[];
}

interface SecretEntry {
  expiresAt: number;
  secret: string;
}

export interface OrganizationProvider {
  id: string;
  slug: string;
  type: ProviderType;
  /**
   * How this instance reaches its provider, so configuration can be validated
   * against the same capability matrix requests are. A row whose gateway is
   * revoked or has no adapter reads as `direct` here: it cannot serve traffic
   * at all, and refusing to *save* an app that mentions it would be a worse
   * failure than the `provider_unavailable` its next request already gets.
   */
  route: ProviderRoute;
  pricing: ProviderPricing | null;
}

/** Active provider instances indexed by their caller-visible slug. */
export type OrganizationProviders = Record<string, OrganizationProvider>;

const CACHE_TTL_MS = 60_000;
const rowsCache = new Map<string, RowsEntry>();
/** The id/blob pair makes rotation-safe entries and shares gateway decrypts. */
const secretCache = new Map<string, SecretEntry>();

export function encryptionContext(
  organizationId: string,
  providerId: string,
): Record<string, string> {
  return { service: "app-ai-gateway", organizationId, providerId };
}

export function gatewayEncryptionContext(
  organizationId: string,
  providerGatewayId: string,
): Record<string, string> {
  return { service: "app-ai-gateway", organizationId, providerGatewayId };
}

export function invalidateOrganizationProviders(organizationId: string): void {
  rowsCache.delete(organizationId);
}

export function clearProviderCaches(): void {
  rowsCache.clear();
  secretCache.clear();
}

async function organizationRows(env: Env, organizationId: string): Promise<ProviderRow[]> {
  const cached = rowsCache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;
  const rows = await database(env.DB)
    .select({
      id: providerTable.id,
      slug: providerTable.slug,
      type: providerTable.type,
      secretBlob: providerTable.secretBlob,
      providerGatewayId: providerTable.providerGatewayId,
      gatewayType: providerGatewayTable.type,
      gatewayConfig: providerGatewayTable.config,
      gatewaySecretBlob: providerGatewayTable.secretBlob,
      gatewayRoute: providerTable.gatewayRoute,
      baseUrl: providerTable.baseUrl,
      pricing: providerTable.pricing,
    })
    .from(providerTable)
    .leftJoin(
      providerGatewayTable,
      and(
        eq(providerTable.providerGatewayId, providerGatewayTable.id),
        eq(providerGatewayTable.status, "active"),
      ),
    )
    .where(and(
      eq(providerTable.organizationId, organizationId),
      eq(providerTable.status, "active"),
    ));
  rowsCache.set(organizationId, { expiresAt: Date.now() + CACHE_TTL_MS, rows });
  return rows;
}

async function plaintextSecret(
  env: Env,
  organizationId: string,
  row: ProviderRow,
): Promise<string> {
  const gatewayRouted = row.providerGatewayId !== null;
  const blob = gatewayRouted ? row.gatewaySecretBlob : row.secretBlob;
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
  const ownerId = row.id;
  const key = `${ownerId}\0${blob}`;
  const cached = secretCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.secret;
  try {
    const secret = await secretVault(env).decryptSecret(
      blob,
      encryptionContext(organizationId, ownerId),
    );
    secretCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, secret });
    return secret;
  } catch (error) {
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

/** Decrypts a reusable gateway token once per id/blob pair. */
export async function decryptProviderGatewaySecret(
  env: Env,
  organizationId: string,
  providerGatewayId: string,
  secretBlob: string,
): Promise<string> {
  const key = `${providerGatewayId}\0${secretBlob}`;
  const cached = secretCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.secret;
  try {
    const secret = await secretVault(env).decryptSecret(
      secretBlob,
      gatewayEncryptionContext(organizationId, providerGatewayId),
    );
    secretCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, secret });
    return secret;
  } catch (error) {
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
  const row = (await organizationRows(env, organizationId)).find((entry) => entry.slug === slug);
  if (!row) return null;
  // A gateway type the CHECK constraint admits but no adapter implements is
  // unroutable here, exactly like a revoked one: the database is permissive so
  // the constraint never needs another rebuild, the adapter registry decides.
  const gateway = row.providerGatewayId === null
    ? null
    : row.gatewayType && row.gatewayConfig && isGatewayType(row.gatewayType)
      ? { id: row.providerGatewayId, ...resolveGateway(row.gatewayType, row.gatewayConfig) }
      : null;
  if (row.providerGatewayId !== null && gateway === null) {
    throw new GatewayError(502, "provider_unavailable", "Provider gateway is missing or revoked");
  }
  return {
    id: row.id,
    slug: row.slug,
    type: row.type,
    secret: await plaintextSecret(env, organizationId, row),
    gateway,
    gatewayRoute: row.gatewayRoute,
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
  // Prototype-less: a slug like "constructor" is legal, and a plain object
  // would answer for it whether or not the organization configured one.
  return recordFromEntries((await organizationRows(env, organizationId)).map((row) => [
    row.slug,
    {
      id: row.id,
      slug: row.slug,
      type: row.type,
      route: row.gatewayType && isGatewayType(row.gatewayType) ? row.gatewayType : "direct",
      pricing: row.pricing,
    },
  ] as const));
}
