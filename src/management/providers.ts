import { and, eq } from "drizzle-orm";
import {
  BASE_URL_REQUIRES_SECRET,
  ProviderCreateRequestSchema,
  ProviderTestRequestSchema,
  ProviderUpdateRequestSchema,
} from "../contracts/schemas";
import type {
  ProviderDeleteResponse,
  ProviderListResponse,
  ProviderResponse,
  ProviderSummary,
  ProviderTestResponse,
} from "../contracts/responses";
import { assertRouteServesProvider } from "../core/capabilities";
import { GatewayError } from "../core/errors";
import { isGatewayType, requireGatewayAdapter, routeAdapter } from "../core/routes";
import { checkOperatorBaseUrl } from "../core/origin-guard";
import { planCap } from "./plan-caps";
import type { ManagementScope } from "./scope";
import { assertNotRejected, probeProviderGateway, probeProviderKey } from "../core/provider-probe";
import { decryptProviderGatewaySecret, invalidateOrganizationProviders } from "../core/provider-store";
import { PROVIDER_TYPES } from "../core/providers";
import type { ProviderType } from "../core/types";
import { database } from "../db";
import {
  provider,
  providerGateway,
  type GatewayRouteConfig,
  type GatewayType,
  type ProviderGatewayConfig,
  type ProviderStatus,
} from "../db/schema";
import { openSecret, sealSecret } from "../vault/secrets";
import { databaseErrorMatches, schemaBody, secretHint } from "./validation";
import type { Actor } from "./actor";
import {
  commitResourceWrite,
  type ResourceWriteBoundary,
} from "./write-boundary";

type ProviderRow = typeof provider.$inferSelect;

function serialize(row: ProviderRow): ProviderSummary {
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
    revision: row.revision,
    status: row.status,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
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
  if (PROVIDER_TYPES.includes(slug as ProviderType) && slug !== type) {
    throw new GatewayError(400, "invalid_request", `Reserved slug ${slug} may only be used by a ${slug} provider`);
  }
}

async function gatewayToken(env: Env, organizationId: string, gatewayId: string): Promise<{ type: GatewayType; config: ProviderGatewayConfig; token: string }> {
  const row = await database(env.DB).query.providerGateway.findFirst({
    where: and(
      eq(providerGateway.id, gatewayId),
      eq(providerGateway.organizationId, organizationId),
      eq(providerGateway.status, "active"),
    ),
  });
  if (!row) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  return {
    type: requireGatewayAdapter(row.type),
    config: row.config,
    token: await decryptProviderGatewaySecret(env, organizationId, row.id, row.secretBlob),
  };
}

async function gatewayAdapterType(env: Env, organizationId: string, gatewayId: string): Promise<GatewayType> {
  const row = await database(env.DB).query.providerGateway.findFirst({
    columns: { type: true },
    where: and(
      eq(providerGateway.id, gatewayId),
      eq(providerGateway.organizationId, organizationId),
      eq(providerGateway.status, "active"),
    ),
  });
  if (!row) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  return requireGatewayAdapter(row.type);
}

async function gatewayRouteAdapter(
  env: Env,
  organizationId: string,
  gatewayId: string,
  route: GatewayRouteConfig | null,
): Promise<GatewayType | null> {
  const row = await database(env.DB).query.providerGateway.findFirst({
    columns: { type: true },
    where: and(eq(providerGateway.id, gatewayId), eq(providerGateway.organizationId, organizationId)),
  });
  if (route === null) return row && isGatewayType(row.type) ? row.type : null;
  if (!row) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  return requireGatewayAdapter(row.type);
}

export async function listProviders(scope: ManagementScope, actor: Actor): Promise<ProviderListResponse> {
  const { env } = scope;
  const rows = await database(env.DB).select().from(provider).where(eq(provider.organizationId, actor.organizationId));
  return { providers: rows.map(serialize) };
}

export async function testProvider(scope: ManagementScope, actor: Actor, input: unknown): Promise<ProviderTestResponse> {
  const { env } = scope;
  const body = schemaBody(ProviderTestRequestSchema, input);
  if (body.secret !== undefined) {
    const baseUrl = body.baseUrl === undefined ? null : guardedBaseUrl(body.baseUrl);
    return assertNotRejected(await probeProviderKey(body.type, body.secret, baseUrl));
  }
  const gateway = await gatewayToken(env, actor.organizationId, body.providerGatewayId!);
  assertRouteServesProvider(gateway.type, body.type);
  return assertNotRejected(await probeProviderGateway({
    type: body.type,
    gatewayType: gateway.type,
    gatewayConfig: gateway.config,
    token: gateway.token,
  }));
}

export async function createProvider(
  scope: ManagementScope,
  actor: Actor,
  input: unknown,
  boundary?: ResourceWriteBoundary,
): Promise<ProviderResponse> {
  const { env } = scope;
  const body = schemaBody(ProviderCreateRequestSchema, input);
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
  if (body.secret !== undefined) {
    routeAdapter("direct").validateRouteConfig(gatewayRoute);
    secret = body.secret;
  } else {
    const gatewayId = body.providerGatewayId;
    if (!gatewayId) throw new GatewayError(400, "invalid_request", "providerGatewayId is required");
    providerGatewayId = gatewayId;
    const gatewayType = await gatewayAdapterType(env, actor.organizationId, gatewayId);
    assertRouteServesProvider(gatewayType, body.type);
    routeAdapter(gatewayType).validateRouteConfig(gatewayRoute);
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
      `INSERT INTO provider(id,organization_id,type,slug,name,secret_blob,secret_hint,provider_gateway_id,gateway_route_json,base_url,pricing_json,revision,status,created_at,updated_at,created_by)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE /* authorization */`,
      [row.id, row.organizationId, row.type, row.slug, row.name, row.secretBlob, row.secretHint,
        row.providerGatewayId, row.gatewayRoute === null ? null : JSON.stringify(row.gatewayRoute), row.baseUrl,
        row.pricing === null ? null : JSON.stringify(row.pricing), row.revision, row.status, row.createdAt, row.updatedAt, row.createdBy],
      { provider: serialize(row) }, boundary, cap,
    );
  } catch (error) {
    if (databaseErrorMatches(error, /UNIQUE constraint failed/u)) throw slugConflict(slug);
    if (databaseErrorMatches(error, /FOREIGN KEY constraint failed/u)) throw new GatewayError(404, "not_found", "Provider gateway was not found");
    throw error;
  }
  invalidateOrganizationProviders(actor.organizationId);
  return { provider: serialize(row) };
}

export async function updateProvider(
  scope: ManagementScope,
  actor: Actor,
  id: string,
  input: unknown,
  boundary?: ResourceWriteBoundary,
): Promise<ProviderResponse> {
  const { env } = scope;
  const body = schemaBody(ProviderUpdateRequestSchema, input);
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
    if (body.baseUrl !== null && body.secret === undefined && row.secretBlob !== null) {
      throw new GatewayError(400, "invalid_request", BASE_URL_REQUIRES_SECRET);
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
  await commitResourceWrite(
    scope,
    `UPDATE provider SET name=?,pricing_json=?,status=?,gateway_route_json=?,base_url=?,secret_blob=?,secret_hint=?,revision=?,updated_at=?
     WHERE id=? AND organization_id=? AND revision=? AND /* authorization */`,
    [updated.name, updated.pricing === null ? null : JSON.stringify(updated.pricing), updated.status,
      updated.gatewayRoute === null ? null : JSON.stringify(updated.gatewayRoute), updated.baseUrl,
      updated.secretBlob, updated.secretHint, updated.revision, updated.updatedAt, id, actor.organizationId, body.revision],
    { provider: serialize(updated) }, boundary,
  );
  invalidateOrganizationProviders(actor.organizationId);
  return { provider: serialize(updated) };
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
