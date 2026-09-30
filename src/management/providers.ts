import { and, eq } from "drizzle-orm";
import type {
  ProviderCreateRequest,
  ProviderTestRequest,
  ProviderUpdateRequest,
} from "../contracts/schemas";
import type {
  ProviderDeleteResponse,
  ProviderListResponse,
  ProviderResponse,
  ProviderSummary,
  ProviderTestResponse,
} from "../contracts/responses";
import { assertRouteServesProvider, instanceCapability } from "../providers/capability-matrix";
import { GatewayError } from "../core/errors";
import { requireGatewayAdapter, routeAdapter } from "../providers/route-adapters";
import { storedGatewayConnection } from "../providers/gateway-adapters";
import { checkOperatorBaseUrl } from "../core/origin-guard";
import { planCap } from "./plan-caps";
import type { ManagementScope } from "./scope";
import { assertNotRejected, probeProviderGateway, probeProviderKey } from "../providers/provider-probe";
import { decryptProviderGatewaySecret, invalidateOrganizationProviders } from "../providers/provider-store";
import { isProviderType, type ProviderType } from "../shared/providers";
import { database } from "../db";
import { guardedInsert } from "../db/sql";
import {
  provider,
  providerGateway,
  type GatewayRouteConfig,
  type ProviderStatus,
} from "../db/schema";
import { openSecret, sealSecret } from "../vault/secrets";
import { databaseErrorMatches, secretHint } from "./validation";
import type { Actor } from "./actor";
import {
  commitResourceWrite,
  type ResourceWriteBoundary,
} from "./write-boundary";
import type { ProviderRoute } from "../shared/capabilities";
import { isGatewayType, type GatewayType } from "../shared/gateways";

type ProviderRow = typeof provider.$inferSelect;

/**
 * One row as the API publishes it. `route` is the row's gateway type, or
 * `direct`, and the capability is read off it here so no client has to join
 * provider rows to gateway rows and the route tables to work it out.
 */
function serialize(row: ProviderRow, route: ProviderRoute | null): ProviderSummary {
  return {
    id: row.id,
    type: row.type,
    slug: row.slug,
    name: row.name,
    secretHint: row.secretHint,
    providerGatewayId: row.providerGatewayId,
    gatewayRoute: row.gatewayRoute,
    baseUrl: row.baseUrl,
    pricing: row.pricing,
    route,
    capability: instanceCapability(route, row.type, row.gatewayRoute),
    revision: row.revision,
    status: row.status,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

/**
 * The route a stored gateway type names, or `null` for a type this deployment
 * has no adapter for. The column is deliberately permissive, and such a row
 * stays listable and editable — it simply serves nothing — rather than taking
 * every healthy instance in the list down with it.
 */
function storedRoute(gatewayType: string | null): ProviderRoute | null {
  if (gatewayType === null) return "direct";
  return isGatewayType(gatewayType) ? gatewayType : null;
}

/** The route of one existing row, reading its gateway's type where it has one. */
async function rowRoute(env: Env, row: ProviderRow): Promise<ProviderRoute | null> {
  if (row.providerGatewayId === null) return "direct";
  const gateway = await database(env.DB).query.providerGateway.findFirst({
    columns: { type: true },
    where: eq(providerGateway.id, row.providerGatewayId),
  });
  return storedRoute(gateway?.type ?? null);
}

function guardedBaseUrl(raw: string): string {
  const checked = checkOperatorBaseUrl(raw);
  if (!checked.ok) throw new GatewayError(400, "invalid_request", checked.message);
  return checked.baseUrl;
}

function slugConflict(slug: string, holder: ProviderStatus = "active"): GatewayError {
  return new GatewayError(
    409,
    "slug_taken",
    holder === "disabled"
      ? `A disabled provider instance holds slug ${slug}; enable it, delete it, or choose a different slug`
      : `An active provider instance already uses slug ${slug}; choose a different slug`,
  );
}

function assertReservedSlug(type: ProviderType, slug: string): void {
  if (isProviderType(slug) && slug !== type) {
    throw new GatewayError(400, "invalid_request", `Reserved slug ${slug} may only be used by a ${slug} provider`);
  }
}

/** One of this organization's gateway rows, whatever its status. */
async function findGateway(env: Env, organizationId: string, gatewayId: string) {
  return database(env.DB).query.providerGateway.findFirst({
    where: and(eq(providerGateway.id, gatewayId), eq(providerGateway.organizationId, organizationId)),
  });
}

/** One of this organization's gateways that can carry traffic now, or a 404. */
async function activeGateway(env: Env, organizationId: string, gatewayId: string) {
  const row = await findGateway(env, organizationId, gatewayId);
  if (!row || row.status !== "active") throw new GatewayError(404, "not_found", "Provider gateway was not found");
  return row;
}

/**
 * The adapter a routing configuration update is judged by. With no routing
 * configuration there is nothing to judge, so a missing gateway or one with no
 * adapter is simply no adapter; a configuration needs one that exists.
 */
async function gatewayRouteAdapter(
  env: Env,
  organizationId: string,
  gatewayId: string,
  route: GatewayRouteConfig | null,
): Promise<GatewayType | null> {
  const row = await findGateway(env, organizationId, gatewayId);
  if (route === null) return row && isGatewayType(row.type) ? row.type : null;
  if (!row) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  return requireGatewayAdapter(row.type);
}

export async function listProviders(scope: ManagementScope, actor: Actor): Promise<ProviderListResponse> {
  const { env } = scope;
  const rows = await database(env.DB)
    .select({ row: provider, gatewayType: providerGateway.type })
    .from(provider)
    .leftJoin(providerGateway, eq(providerGateway.id, provider.providerGatewayId))
    .where(eq(provider.organizationId, actor.organizationId));
  return { providers: rows.map(({ row, gatewayType }) => serialize(row, storedRoute(gatewayType))) };
}

export async function testProvider(scope: ManagementScope, actor: Actor, body: ProviderTestRequest): Promise<ProviderTestResponse> {
  const { env } = scope;
  if (body.secret !== undefined) {
    const baseUrl = body.baseUrl === undefined ? null : guardedBaseUrl(body.baseUrl);
    return assertNotRejected(await probeProviderKey(body.type, body.secret, baseUrl));
  }
  const gateway = await activeGateway(env, actor.organizationId, body.providerGatewayId!);
  const stored = storedGatewayConnection(requireGatewayAdapter(gateway.type), gateway.config);
  const token = await decryptProviderGatewaySecret(env, actor.organizationId, gateway.id, gateway.secretBlob);
  assertRouteServesProvider(stored.type, body.type);
  return assertNotRejected(await probeProviderGateway({ type: body.type, gateway: stored, token }));
}

export async function createProvider(
  scope: ManagementScope,
  actor: Actor,
  body: ProviderCreateRequest,
  boundary?: ResourceWriteBoundary,
): Promise<ProviderResponse> {
  const { env } = scope;
  const slug = body.slug ?? body.type;
  assertReservedSlug(body.type, slug);
  const existing = await database(env.DB).query.provider.findFirst({
    columns: { id: true, status: true },
    where: and(eq(provider.organizationId, actor.organizationId), eq(provider.slug, slug)),
  });
  if (existing) throw slugConflict(slug, existing.status);

  const gatewayRoute = body.gatewayRoute ?? null;
  const baseUrl = body.baseUrl === undefined ? null : guardedBaseUrl(body.baseUrl);
  let secret: string | undefined;
  let providerGatewayId: string | undefined;
  let route: ProviderRoute = "direct";
  if (body.secret !== undefined) {
    routeAdapter("direct").validateRouteConfig(gatewayRoute);
    secret = body.secret;
  } else {
    // The schema admits exactly one of `secret` and `providerGatewayId`.
    const gatewayId = body.providerGatewayId!;
    providerGatewayId = gatewayId;
    const gatewayType = requireGatewayAdapter((await activeGateway(env, actor.organizationId, gatewayId)).type);
    assertRouteServesProvider(gatewayType, body.type);
    routeAdapter(gatewayType).validateRouteConfig(gatewayRoute);
    route = gatewayType;
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const row: ProviderRow = {
    id,
    organizationId: actor.organizationId,
    type: body.type,
    slug,
    name: body.name,
    secretBlob: secret === undefined ? null : await sealSecret(env, "providerKey", [actor.organizationId, id, body.type, baseUrl ?? ""], secret),
    secretHint: secret === undefined ? null : secretHint(secret),
    providerGatewayId: providerGatewayId ?? null,
    gatewayRoute,
    baseUrl,
    pricing: body.pricing ?? null,
    revision: 1,
    status: "active",
    createdAt: now,
    updatedAt: now,
    createdBy: actor.userId,
  };
  const cap = await planCap(scope, "provider", actor.organizationId);
  try {
    await commitResourceWrite(
      scope,
      (guard) => guardedInsert(database(scope.env.DB), provider, row, guard),
      { provider: serialize(row, route) },
      { boundary, cap },
    );
  } catch (error) {
    if (databaseErrorMatches(error, /UNIQUE constraint failed/u)) throw slugConflict(slug);
    if (databaseErrorMatches(error, /FOREIGN KEY constraint failed/u)) throw new GatewayError(404, "not_found", "Provider gateway was not found");
    throw error;
  }
  invalidateOrganizationProviders(actor.organizationId);
  return { provider: serialize(row, route) };
}

export async function updateProvider(
  scope: ManagementScope,
  actor: Actor,
  id: string,
  body: ProviderUpdateRequest,
  boundary?: ResourceWriteBoundary,
): Promise<ProviderResponse> {
  const { env } = scope;
  const row = await database(env.DB).query.provider.findFirst({
    where: and(eq(provider.id, id), eq(provider.organizationId, actor.organizationId)),
  });
  if (!row) throw new GatewayError(404, "not_found", "Provider was not found");
  if (body.revision !== row.revision) throw new GatewayError(409, "conflict", "The provider changed; reload it before saving your changes");

  const updates: Partial<typeof provider.$inferInsert> = {
    revision: row.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  if (body.name !== undefined) updates.name = body.name;
  if (body.pricing !== undefined) updates.pricing = body.pricing;
  if (body.status !== undefined) updates.status = body.status;
  if (body.gatewayRoute !== undefined) {
    const gatewayType = row.providerGatewayId === null ? null : await gatewayRouteAdapter(env, actor.organizationId, row.providerGatewayId, body.gatewayRoute);
    routeAdapter(gatewayType ?? "direct").validateRouteConfig(body.gatewayRoute);
    updates.gatewayRoute = body.gatewayRoute;
  }

  let baseUrl = row.baseUrl;
  if (body.baseUrl !== undefined) {
    if (body.baseUrl !== null && row.providerGatewayId !== null) {
      throw new GatewayError(400, "invalid_request", "A gateway-routed instance cannot carry a base URL: the gateway owns the upstream origin");
    }
    baseUrl = body.baseUrl === null ? null : guardedBaseUrl(body.baseUrl);
    updates.baseUrl = baseUrl;
    if (body.baseUrl === null && body.secret === undefined && row.secretBlob !== null) {
      const secret = await openSecret(env, "providerKey", [actor.organizationId, row.id, row.type, row.baseUrl ?? ""], row.secretBlob);
      updates.secretBlob = await sealSecret(env, "providerKey", [actor.organizationId, row.id, row.type, ""], secret);
    }
  }
  if (body.secret !== undefined) {
    if (row.providerGatewayId !== null) {
      throw new GatewayError(409, "provider_gateway_managed", `This provider uses a shared gateway token; rotate it at /v1/admin/provider-gateways/${row.providerGatewayId}/rotate`);
    }
    updates.secretBlob = await sealSecret(env, "providerKey", [actor.organizationId, row.id, row.type, baseUrl ?? ""], body.secret);
    updates.secretHint = secretHint(body.secret);
  }

  const updated = { ...row, ...updates } as ProviderRow;
  const route = await rowRoute(env, updated);
  await commitResourceWrite(
    scope,
    (guard) => database(scope.env.DB)
      .update(provider)
      .set({
        name: updated.name,
        pricing: updated.pricing,
        status: updated.status,
        gatewayRoute: updated.gatewayRoute,
        baseUrl: updated.baseUrl,
        secretBlob: updated.secretBlob,
        secretHint: updated.secretHint,
        revision: updated.revision,
        updatedAt: updated.updatedAt,
      })
      .where(and(
        eq(provider.id, id),
        eq(provider.organizationId, actor.organizationId),
        eq(provider.revision, body.revision),
        guard,
      )),
    { provider: serialize(updated, route) },
    { boundary },
  );
  invalidateOrganizationProviders(actor.organizationId);
  return { provider: serialize(updated, route) };
}

export async function deleteProvider(scope: ManagementScope, actor: Actor, id: string): Promise<ProviderDeleteResponse> {
  const { env } = scope;
  const [deleted] = await database(env.DB).delete(provider)
    .where(and(eq(provider.id, id), eq(provider.organizationId, actor.organizationId)))
    .returning({ id: provider.id });
  if (!deleted) throw new GatewayError(404, "not_found", "Provider was not found");
  invalidateOrganizationProviders(actor.organizationId);
  return { deleted: true, provider_id: deleted.id };
}
