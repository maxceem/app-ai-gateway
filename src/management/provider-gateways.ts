import { and, eq, sql } from "drizzle-orm";
import {
  ProviderGatewayCreateRequestSchema,
  ProviderGatewayRotateRequestSchema,
  ProviderGatewayTestRequestSchema,
  ProviderGatewayUpdateRequestSchema,
} from "../contracts/schemas";
import type {
  ProviderGatewayDeleteResponse,
  ProviderGatewayListResponse,
  ProviderGatewayResponse,
  ProviderGatewaySummary,
  ProviderGatewayTestResponse,
} from "../contracts/responses";
import { GatewayError } from "../core/errors";
import { requireGatewayAdapter } from "../core/routes";
import { planCap } from "./plan-caps";
import type { ManagementScope } from "./scope";
import { probeGatewayPreset, type ProbeResult } from "../core/provider-probe";
import { invalidateOrganizationProviders } from "../core/provider-store";
import { database } from "../db";
import {
  provider,
  providerGateway,
  type CfAigConfig,
  type GatewayType,
  type ProviderGatewayConfig,
} from "../db/schema";
import { sealSecret } from "../vault/secrets";
import { databaseErrorMatches, schemaBody, secretHint } from "./validation";
import type { Actor } from "./actor";
import {
  commitResourceWrite,
  type ResourceWriteBoundary,
} from "./write-boundary";

type ProviderGatewayRow = typeof providerGateway.$inferSelect;
interface GatewayCounts { active: number; total: number }
const NO_REFERENCES: GatewayCounts = { active: 0, total: 0 };

function serialize(row: ProviderGatewayRow, counts: GatewayCounts): ProviderGatewaySummary {
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
  return row.type === "cf_aig"
    ? { ...common, type: "cf_aig", config: row.config as CfAigConfig }
    : { ...common, type: "vercel", config: {} };
}

function probeReport(probe: ProbeResult): ProviderGatewayTestResponse {
  return {
    validated: probe.validated,
    ...(probe.reason === undefined ? {} : { reason: probe.reason }),
    ...(probe.status === undefined ? {} : { status: probe.status }),
  };
}

function requestedGateway(
  body: { type: "cf_aig"; accountId: string; gatewayId: string } | { type: "vercel" },
): { type: GatewayType; config: ProviderGatewayConfig } {
  return body.type === "cf_aig"
    ? { type: "cf_aig", config: { accountId: body.accountId, gatewayId: body.gatewayId } }
    : { type: "vercel", config: {} };
}

export async function testProviderGateway(input: unknown): Promise<ProviderGatewayTestResponse> {
  const body = schemaBody(ProviderGatewayTestRequestSchema, input);
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
  return { gateways: gateways.map((row) => serialize(row, countById.get(row.id) ?? NO_REFERENCES)) };
}

export async function createProviderGateway(
  scope: ManagementScope,
  actor: Actor,
  input: unknown,
  boundary?: ResourceWriteBoundary,
): Promise<ProviderGatewayResponse> {
  const { env } = scope;
  const body = schemaBody(ProviderGatewayCreateRequestSchema, input);
  const gateway = requestedGateway(body);
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
    `INSERT INTO provider_gateway(id,organization_id,type,name,config_json,secret_blob,secret_hint,revision,created_by,status,created_at,updated_at)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE /* authorization */`,
    [row.id, row.organizationId, row.type, row.name, JSON.stringify(row.config), row.secretBlob,
      row.secretHint, row.revision, row.createdBy, row.status, row.createdAt, row.updatedAt],
    { gateway: serialize(row, NO_REFERENCES) }, boundary, cap,
  );
  invalidateOrganizationProviders(actor.organizationId);
  return { gateway: serialize(row, NO_REFERENCES) };
}

export async function updateProviderGateway(
  scope: ManagementScope,
  actor: Actor,
  id: string,
  input: unknown,
  boundary?: ResourceWriteBoundary,
): Promise<ProviderGatewayResponse> {
  const { env } = scope;
  const body = schemaBody(ProviderGatewayUpdateRequestSchema, input);
  const existing = await database(env.DB).query.providerGateway.findFirst({
    where: and(eq(providerGateway.id, id), eq(providerGateway.organizationId, actor.organizationId), eq(providerGateway.status, "active")),
  });
  if (!existing) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  if (body.revision !== existing.revision) throw new GatewayError(409, "conflict", "The provider gateway changed; reload it before saving your changes");
  const row: ProviderGatewayRow = {
    ...existing,
    name: body.name,
    revision: existing.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  const counts = await gatewayCounts(env.DB, actor.organizationId, id);
  await commitResourceWrite(
    scope,
    `UPDATE provider_gateway SET name=?,revision=?,updated_at=?
     WHERE id=? AND organization_id=? AND revision=? AND status='active' AND /* authorization */`,
    [row.name, row.revision, row.updatedAt, id, actor.organizationId, body.revision],
    { gateway: serialize(row, counts) }, boundary,
  );
  invalidateOrganizationProviders(actor.organizationId);
  return { gateway: serialize(row, counts) };
}

export async function rotateProviderGateway(
  scope: ManagementScope,
  actor: Actor,
  id: string,
  input: unknown,
  boundary?: ResourceWriteBoundary,
): Promise<ProviderGatewayResponse> {
  const { env } = scope;
  const body = schemaBody(ProviderGatewayRotateRequestSchema, input);
  const existing = await database(env.DB).query.providerGateway.findFirst({
    where: and(eq(providerGateway.id, id), eq(providerGateway.organizationId, actor.organizationId), eq(providerGateway.status, "active")),
  });
  if (!existing) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  if (body.revision !== existing.revision) throw new GatewayError(409, "conflict", "The provider gateway changed; reload it before saving your changes");
  requireGatewayAdapter(existing.type);
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
    `UPDATE provider_gateway SET secret_blob=?,secret_hint=?,revision=?,updated_at=?
     WHERE id=? AND organization_id=? AND revision=? AND status='active' AND /* authorization */`,
    [row.secretBlob, row.secretHint, row.revision, row.updatedAt, row.id, row.organizationId, body.revision],
    { gateway: serialize(row, counts) }, boundary,
  );
  invalidateOrganizationProviders(actor.organizationId);
  return { gateway: serialize(row, counts) };
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
