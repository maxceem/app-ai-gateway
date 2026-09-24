import { and, eq, sql } from "drizzle-orm";
import type {
  ProviderGatewayCreateRequest,
  ProviderGatewayRotateRequest,
  ProviderGatewayTestRequest,
  ProviderGatewayUpdateRequest,
} from "../contracts/schemas";
import type {
  ProviderGatewayDeleteResponse,
  ProviderGatewayListResponse,
  ProviderGatewayResponse,
  ProviderGatewaySummary,
  ProviderGatewayTestResponse,
} from "../contracts/responses";
import { GatewayError } from "../core/errors";
import { requireGatewayAdapter } from "../providers/route-adapters";
import { readStoredGateway, storedGatewayConnection } from "../providers/gateway-adapters";
import { planCap } from "./plan-caps";
import type { ManagementScope } from "./scope";
import { probeGatewayPreset, type ProbeResult } from "../providers/provider-probe";
import { invalidateOrganizationProviders } from "../providers/provider-store";
import { database } from "../db";
import {
  provider,
  providerGateway,
} from "../db/schema";
import { sealSecret } from "../vault/secrets";
import { databaseErrorMatches, secretHint } from "./validation";
import type { Actor } from "./actor";
import {
  commitResourceWrite,
  type ResourceWriteBoundary,
} from "./write-boundary";
import type { StoredGateway } from "../shared/gateways";
import { log } from "../core/log";

type ProviderGatewayRow = typeof providerGateway.$inferSelect;
interface GatewayCounts { active: number; total: number }
const NO_REFERENCES: GatewayCounts = { active: 0, total: 0 };

/**
 * One gateway as the API publishes it. `gateway` is the row's own type and
 * connection, already read by `storedGatewayConnection` or `readStoredGateway`
 * — every caller has one, and none reads the row's columns a second time.
 */
function serialize(
  row: ProviderGatewayRow,
  gateway: StoredGateway,
  counts: GatewayCounts,
): ProviderGatewaySummary {
  const common = {
    id: row.id,
    name: row.name,
    secretHint: row.secretHint,
    providerCount: counts.active,
    referencedCount: counts.total,
    revision: row.revision,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
  };
  return { ...common, ...gateway };
}

function probeReport(probe: ProbeResult): ProviderGatewayTestResponse {
  return {
    validated: probe.validated,
    ...(probe.reason === undefined ? {} : { reason: probe.reason }),
    ...(probe.status === undefined ? {} : { status: probe.status }),
  };
}

/**
 * The connection a test body names: its type and exactly its connection fields
 * — the token is not configuration, and never stored as it — paired by the
 * same reader a stored row goes through.
 */
function requestedGateway({ type, token: _token, ...connection }: ProviderGatewayTestRequest): StoredGateway {
  return storedGatewayConnection(type, connection);
}

export async function testProviderGateway(
  _scope: ManagementScope,
  _actor: Actor,
  body: ProviderGatewayTestRequest,
): Promise<ProviderGatewayTestResponse> {
  return probeReport(await probeGatewayPreset(requestedGateway(body), body.token));
}

export async function listProviderGateways(scope: ManagementScope, actor: Actor): Promise<ProviderGatewayListResponse> {
  const db = database(scope.env.DB);
  const [gateways, counts] = await Promise.all([
    db.select().from(providerGateway).where(eq(providerGateway.organizationId, actor.organizationId)),
    db.select({
      providerGatewayId: provider.providerGatewayId,
      active: sql<number>`SUM(CASE WHEN ${provider.status} = 'active' THEN 1 ELSE 0 END)`,
      total: sql<number>`COUNT(*)`,
    }).from(provider).where(eq(provider.organizationId, actor.organizationId)).groupBy(provider.providerGatewayId),
  ]);
  const countById = new Map(counts.flatMap((row) => row.providerGatewayId === null ? [] : [[row.providerGatewayId, { active: row.active, total: row.total }] as const]));
  // A row this deployment cannot read — a type with no adapter, or a stored
  // configuration that does not parse — is left out and logged rather than
  // taking every healthy gateway in the list down with it, as the providers
  // list does with an instance whose gateway it cannot route.
  return {
    gateways: gateways.flatMap((row) => {
      const gateway = readStoredGateway(row.type, row.config);
      if (gateway === null) {
        log("error", "Unreadable provider gateway left out of the list", { providerGatewayId: row.id, type: row.type });
        return [];
      }
      return [serialize(row, gateway, countById.get(row.id) ?? NO_REFERENCES)];
    }),
  };
}

export async function createProviderGateway(
  scope: ManagementScope,
  actor: Actor,
  body: ProviderGatewayCreateRequest,
  boundary?: ResourceWriteBoundary,
): Promise<ProviderGatewayResponse> {
  const { env } = scope;
  const { name: _name, ...connection } = body;
  const gateway = requestedGateway(connection);
  const id = crypto.randomUUID();
  const secretBlob = await sealSecret(env, "providerGatewayToken", [actor.organizationId, id], body.token);
  const now = new Date().toISOString();
  const row: ProviderGatewayRow = {
    id, organizationId: actor.organizationId, type: gateway.type, name: body.name,
    config: gateway.config, secretBlob, secretHint: secretHint(body.token),
    revision: 1, createdBy: actor.userId, status: "active", createdAt: now, updatedAt: now,
  };
  const cap = await planCap(scope, "providerGateway", actor.organizationId);
  await commitResourceWrite(
    scope,
    (guard) => sql`INSERT INTO provider_gateway(id,organization_id,type,name,config_json,secret_blob,secret_hint,revision,created_by,status,created_at,updated_at)
     SELECT ${row.id},${row.organizationId},${row.type},${row.name},${JSON.stringify(row.config)},${row.secretBlob},
       ${row.secretHint},${row.revision},${row.createdBy},${row.status},${row.createdAt},${row.updatedAt}
     WHERE ${guard}`,
    { gateway: serialize(row, gateway, NO_REFERENCES) },
    { boundary, cap },
  );
  invalidateOrganizationProviders(actor.organizationId);
  return { gateway: serialize(row, gateway, NO_REFERENCES) };
}

export async function updateProviderGateway(
  scope: ManagementScope,
  actor: Actor,
  id: string,
  body: ProviderGatewayUpdateRequest,
  boundary?: ResourceWriteBoundary,
): Promise<ProviderGatewayResponse> {
  const { env } = scope;
  const existing = await database(env.DB).query.providerGateway.findFirst({
    where: and(eq(providerGateway.id, id), eq(providerGateway.organizationId, actor.organizationId), eq(providerGateway.status, "active")),
  });
  if (!existing) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  if (body.revision !== existing.revision) throw new GatewayError(409, "conflict", "The provider gateway changed; reload it before saving your changes");
  const gateway = storedGatewayConnection(requireGatewayAdapter(existing.type), existing.config);
  const row: ProviderGatewayRow = {
    ...existing,
    name: body.name,
    revision: existing.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  const counts = await gatewayCounts(env.DB, actor.organizationId, id);
  await commitResourceWrite(
    scope,
    (guard) => sql`UPDATE provider_gateway SET name=${row.name},revision=${row.revision},updated_at=${row.updatedAt}
     WHERE id=${id} AND organization_id=${actor.organizationId} AND revision=${body.revision}
       AND status='active' AND ${guard}`,
    { gateway: serialize(row, gateway, counts) },
    { boundary },
  );
  invalidateOrganizationProviders(actor.organizationId);
  return { gateway: serialize(row, gateway, counts) };
}

export async function rotateProviderGateway(
  scope: ManagementScope,
  actor: Actor,
  id: string,
  body: ProviderGatewayRotateRequest,
  boundary?: ResourceWriteBoundary,
): Promise<ProviderGatewayResponse> {
  const { env } = scope;
  const existing = await database(env.DB).query.providerGateway.findFirst({
    where: and(eq(providerGateway.id, id), eq(providerGateway.organizationId, actor.organizationId), eq(providerGateway.status, "active")),
  });
  if (!existing) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  if (body.revision !== existing.revision) throw new GatewayError(409, "conflict", "The provider gateway changed; reload it before saving your changes");
  const gateway = storedGatewayConnection(requireGatewayAdapter(existing.type), existing.config);
  const secretBlob = await sealSecret(env, "providerGatewayToken", [actor.organizationId, id], body.token);
  const row: ProviderGatewayRow = {
    ...existing,
    secretBlob,
    secretHint: secretHint(body.token),
    revision: existing.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  const counts = await gatewayCounts(env.DB, actor.organizationId, id);
  await commitResourceWrite(
    scope,
    (guard) => sql`UPDATE provider_gateway SET secret_blob=${row.secretBlob},secret_hint=${row.secretHint},
       revision=${row.revision},updated_at=${row.updatedAt}
     WHERE id=${row.id} AND organization_id=${row.organizationId} AND revision=${body.revision}
       AND status='active' AND ${guard}`,
    { gateway: serialize(row, gateway, counts) },
    { boundary },
  );
  invalidateOrganizationProviders(actor.organizationId);
  return { gateway: serialize(row, gateway, counts) };
}

export async function deleteProviderGateway(scope: ManagementScope, actor: Actor, id: string): Promise<ProviderGatewayDeleteResponse> {
  const { env } = scope;
  const existing = await database(env.DB).query.providerGateway.findFirst({
    columns: { id: true },
    where: and(eq(providerGateway.id, id), eq(providerGateway.organizationId, actor.organizationId)),
  });
  if (!existing) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  const counts = await gatewayCounts(env.DB, actor.organizationId, id);
  if (counts.total > 0) throw gatewayInUse(counts);
  try {
    await database(env.DB).delete(providerGateway).where(and(eq(providerGateway.id, id), eq(providerGateway.organizationId, actor.organizationId)));
  } catch (error) {
    if (databaseErrorMatches(error, /FOREIGN KEY constraint failed/u)) throw gatewayInUse();
    throw error;
  }
  invalidateOrganizationProviders(actor.organizationId);
  return { deleted: true, provider_gateway_id: id };
}

async function gatewayCounts(d1: D1Database, organizationId: string, providerGatewayId: string): Promise<GatewayCounts> {
  const row = await database(d1).select({
    active: sql<number>`SUM(CASE WHEN ${provider.status} = 'active' THEN 1 ELSE 0 END)`,
    total: sql<number>`COUNT(*)`,
  }).from(provider).where(and(eq(provider.organizationId, organizationId), eq(provider.providerGatewayId, providerGatewayId))).get();
  return { active: row?.active ?? 0, total: row?.total ?? 0 };
}

function gatewayInUse(counts: GatewayCounts = { active: 1, total: 1 }): GatewayError {
  const disabled = counts.total - counts.active;
  const message = counts.active > 0
    ? disabled > 0
      ? "Delete the active and disabled provider instances routed through this gateway first"
      : "Delete every active provider instance routed through this gateway first"
    : "Disabled provider instances still reference this gateway; delete them to release it";
  return new GatewayError(409, "gateway_in_use", message);
}
