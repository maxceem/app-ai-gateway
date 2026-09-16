import { prepareResourceReceipt } from "../../core/resource-receipt";
import {
  commitProviderWrite,
  nextUpdatedAt,
  type ProviderWriteActor,
  type ProviderWriteBoundary,
} from "../../core/provider-writes";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  ProviderGatewayCreateRequestSchema,
  ProviderGatewayRotateRequestSchema,
  ProviderGatewayTestRequestSchema,
  ProviderGatewayUpdateRequestSchema,
} from "../../contracts/schemas";
import type {
  ProviderGatewayDeleteResponse,
  ProviderGatewayListResponse,
  ProviderGatewayResponse,
  ProviderGatewaySummary,
  ProviderGatewayTestResponse,
} from "../../contracts/responses";
import { GatewayError } from "../../core/errors";
import { requireGatewayAdapter, type ResolvedGateway } from "../../core/gateways";
import { planCap } from "../../core/plan-caps";
import { probeGatewayPreset, type ProbeResult } from "../../core/provider-probe";
import {
  gatewayEncryptionContext,
  invalidateOrganizationProviders,
} from "../../core/provider-store";
import { database } from "../../db";
import { provider, providerGateway, type CfAigConfig } from "../../db/schema";
import type { AdminVariables } from "../../middleware/admin";
import { secretVault } from "../../vault";
import {
  databaseErrorMatches,
  providerRequestBody,
  providerSchemaBody,
  secretHint,
} from "./provider-shared";

type ProviderGatewayEnv = { Bindings: Env; Variables: AdminVariables };
type ProviderGatewayRow = typeof providerGateway.$inferSelect;

/**
 * `providerCount` is what the gateway currently serves; `referencedCount` also
 * counts disabled rows, which are retained for re-enabling and keep the foreign key
 * alive. Deletion is governed by the second number, so the console must disable
 * delete on `referencedCount`, not on `providerCount`.
 */
interface GatewayCounts {
  active: number;
  total: number;
}

/**
 * The documented return type, so a column added here that the contract has not
 * been told about fails `pnpm run check` rather than a client that reads it.
 */
function serialize(row: ProviderGatewayRow, counts: GatewayCounts): ProviderGatewaySummary {
  const common = {
    id: row.id,
    name: row.name,
    secretHint: row.secretHint,
    providerCount: counts.active,
    referencedCount: counts.total,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
  };
  // The published shape is discriminated by `type`, because each gateway's
  // `config` is its own. The stored columns are not correlated — `type` and
  // `config_json` are separate columns holding separate unions — so the pair is
  // joined here, exactly as `resolveGateway` joins it for the request path, and
  // the create path above is the only writer of either.
  return row.type === "cf_aig"
    ? { ...common, type: "cf_aig", config: row.config as CfAigConfig }
    : { ...common, type: "vercel", config: {} };
}

const NO_REFERENCES: GatewayCounts = { active: 0, total: 0 };

/**
 * What the dry run found.
 *
 * A Cloudflare AI Gateway answers 401 both for a token that is wrong and for a
 * gateway whose authentication or upstream key is not set up yet, so a refusal
 * is not proof of a bad token. That is why this is only ever an answer to a
 * question the operator asked: writes store what they are given without
 * probing anything, and this endpoint says what a live call would find.
 */
function probeReport(probe: ProbeResult): ProviderGatewayTestResponse {
  return {
    validated: probe.validated,
    ...(probe.reason === undefined ? {} : { reason: probe.reason }),
    ...(probe.status === undefined ? {} : { status: probe.status }),
  };
}

/**
 * The config union is built here and nowhere else, so a stored row's
 * `type`/`config_json` pair is always one the adapter registry can resolve —
 * and a dry run probes the same connection a create would store.
 */
function requestedGateway(
  body: { type: "cf_aig"; accountId: string; gatewayId: string } | { type: "vercel" },
): ResolvedGateway {
  return body.type === "cf_aig"
    ? { type: "cf_aig", config: { accountId: body.accountId, gatewayId: body.gatewayId } }
    : { type: "vercel", config: {} };
}

export const providerGatewayRoutes = new Hono<ProviderGatewayEnv>();

/**
 * Probes a gateway connection that need not exist yet, so an operator can check
 * one before committing to it. Nothing is stored, and the token never travels
 * back — only the verdict on it does.
 *
 * A refusal is reported like every other outcome rather than raised as an
 * error, which is where this parts company with `POST /providers/test`: the
 * same 401 means "wrong token" and "this gateway is not set up yet", and only
 * the operator can tell those apart.
 */
providerGatewayRoutes.post("/provider-gateways/test", async (c) => {
  const body = providerSchemaBody(ProviderGatewayTestRequestSchema, await providerRequestBody(c));
  return c.json(probeReport(await probeGatewayPreset(requestedGateway(body), body.token)));
});

providerGatewayRoutes.get("/provider-gateways", async (c) => {
  const organizationId = c.get("admin").organizationId;
  const db = database(c.env.DB);
  const [gateways, counts] = await Promise.all([
    db.select().from(providerGateway).where(eq(providerGateway.organizationId, organizationId)),
    db
      .select({
        providerGatewayId: provider.providerGatewayId,
        active: sql<number>`SUM(CASE WHEN ${provider.status} = 'active' THEN 1 ELSE 0 END)`,
        total: sql<number>`COUNT(*)`,
      })
      .from(provider)
      .where(eq(provider.organizationId, organizationId))
      .groupBy(provider.providerGatewayId),
  ]);
  const countById = new Map(
    counts.flatMap((row) =>
      row.providerGatewayId === null
        ? []
        : [[row.providerGatewayId, { active: row.active, total: row.total }] as const],
    ),
  );
  return c.json({
    gateways: gateways.map((row) => serialize(row, countById.get(row.id) ?? NO_REFERENCES)),
  } satisfies ProviderGatewayListResponse);
});

export async function createProviderGateway(
  env: Env,
  admin: ProviderWriteActor,
  input: unknown,
  boundary?: ProviderWriteBoundary,
): Promise<ProviderGatewayResponse> {
  const body = providerSchemaBody(ProviderGatewayCreateRequestSchema, input);
  const gateway = requestedGateway(body);
  const id = crypto.randomUUID();
  const secretBlob = await secretVault(env).encryptSecret(
    body.token,
    gatewayEncryptionContext(admin.organizationId, id),
  );
  const now = nextUpdatedAt();
  const row: ProviderGatewayRow = {
    id,
    organizationId: admin.organizationId,
    type: gateway.type,
    name: body.name,
    config: gateway.config,
    secretBlob,
    secretHint: secretHint(body.token),
    createdBy: admin.userId,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const cap = await planCap(env, "providerGateway", admin.organizationId);
  await commitProviderWrite(
    env,
    `INSERT INTO provider_gateway(id,organization_id,type,name,config_json,secret_blob,secret_hint,created_by,status,created_at,updated_at)
     SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE /* authorization */`,
    [
      row.id,
      row.organizationId,
      row.type,
      row.name,
      JSON.stringify(row.config),
      row.secretBlob,
      row.secretHint,
      row.createdBy,
      row.status,
      row.createdAt,
      row.updatedAt,
    ],
    { gateway: serialize(row, NO_REFERENCES) },
    boundary,
    cap,
  );
  invalidateOrganizationProviders(admin.organizationId);
  return { gateway: serialize(row, NO_REFERENCES) };
}

providerGatewayRoutes.post("/provider-gateways", async (c) => {
  const body = await providerRequestBody(c);
  const receipt = await prepareResourceReceipt(c, "provider-gateway.add", body);
  if (receipt?.result) return c.json(receipt.result, 201);
  try {
    const outcome = await createProviderGateway(c.env, c.get("admin"), body, receipt);
    return c.json(receipt?.result ?? outcome, 201);
  } catch (error) {
    if (receipt && (await receipt.read())) return c.json(receipt.result!, 201);
    throw error;
  }
});

providerGatewayRoutes.patch("/provider-gateways/:id", async (c) => {
  const admin = c.get("admin");
  const id = c.req.param("id");
  const body = providerSchemaBody(ProviderGatewayUpdateRequestSchema, await providerRequestBody(c));
  const existing = await database(c.env.DB).query.providerGateway.findFirst({
    where: and(
      eq(providerGateway.id, id),
      eq(providerGateway.organizationId, admin.organizationId),
      eq(providerGateway.status, "active"),
    ),
  });
  if (!existing) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  const [row] = await database(c.env.DB)
    .update(providerGateway)
    .set({
      name: body.name,
      updatedAt: nextUpdatedAt(existing.updatedAt),
    })
    .where(
      and(
        eq(providerGateway.id, id),
        eq(providerGateway.organizationId, admin.organizationId),
        eq(providerGateway.status, "active"),
        eq(providerGateway.updatedAt, existing.updatedAt),
      ),
    )
    .returning();
  if (!row) throw new GatewayError(409, "conflict", "Provider gateway changed during this request");
  invalidateOrganizationProviders(admin.organizationId);
  const counts = await gatewayCounts(c.env.DB, admin.organizationId, id);
  return c.json({ gateway: serialize(row, counts) } satisfies ProviderGatewayResponse);
});

export async function rotateProviderGateway(
  env: Env,
  admin: ProviderWriteActor,
  id: string,
  input: unknown,
  boundary?: ProviderWriteBoundary,
  expectedUpdatedAt?: string,
): Promise<ProviderGatewayResponse> {
  const body = providerSchemaBody(ProviderGatewayRotateRequestSchema, input);
  const existing = await database(env.DB).query.providerGateway.findFirst({
    where: and(
      eq(providerGateway.id, id),
      eq(providerGateway.organizationId, admin.organizationId),
      eq(providerGateway.status, "active"),
    ),
  });
  if (!existing) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  if (expectedUpdatedAt !== undefined && existing.updatedAt !== expectedUpdatedAt)
    throw new GatewayError(
      409,
      "conflict",
      "The provider gateway changed since this request was prepared",
    );
  // A stored type the CHECK admits but no adapter implements can carry no
  // traffic, so rotating a token onto it would be a silent no-op.
  requireGatewayAdapter(existing.type);
  const secretBlob = await secretVault(env).encryptSecret(
    body.token,
    gatewayEncryptionContext(admin.organizationId, id),
  );
  const row: ProviderGatewayRow = {
    ...existing,
    secretBlob,
    secretHint: secretHint(body.token),
    updatedAt: nextUpdatedAt(existing.updatedAt),
  };
  const counts = await gatewayCounts(env.DB, admin.organizationId, id);
  await commitProviderWrite(
    env,
    `UPDATE provider_gateway SET secret_blob=?,secret_hint=?,updated_at=? WHERE id=? AND organization_id=? AND updated_at=? AND status='active' AND /* authorization */`,
    [row.secretBlob, row.secretHint, row.updatedAt, row.id, row.organizationId, existing.updatedAt],
    { gateway: serialize(row, counts) },
    boundary,
  );
  invalidateOrganizationProviders(admin.organizationId);
  return { gateway: serialize(row, counts) };
}

providerGatewayRoutes.post("/provider-gateways/:id/rotate", async (c) =>
  c.json(
    await rotateProviderGateway(
      c.env,
      c.get("admin"),
      c.req.param("id"),
      await providerRequestBody(c),
    ),
  ),
);

providerGatewayRoutes.delete("/provider-gateways/:id", async (c) => {
  const admin = c.get("admin");
  const id = c.req.param("id");
  const existing = await database(c.env.DB).query.providerGateway.findFirst({
    columns: { id: true },
    where: and(
      eq(providerGateway.id, id),
      eq(providerGateway.organizationId, admin.organizationId),
    ),
  });
  if (!existing) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  // Revoked rows are kept for audit and still hold the foreign key, so they
  // block deletion exactly like active ones do.
  const counts = await gatewayCounts(c.env.DB, admin.organizationId, id);
  if (counts.total > 0) throw gatewayInUse(counts);
  try {
    await database(c.env.DB)
      .delete(providerGateway)
      .where(
        and(eq(providerGateway.id, id), eq(providerGateway.organizationId, admin.organizationId)),
      );
  } catch (error) {
    if (databaseErrorMatches(error, /FOREIGN KEY constraint failed/u)) throw gatewayInUse();
    throw error;
  }
  invalidateOrganizationProviders(admin.organizationId);
  return c.json({ deleted: true, provider_gateway_id: id } satisfies ProviderGatewayDeleteResponse);
});

async function gatewayCounts(
  d1: D1Database,
  organizationId: string,
  providerGatewayId: string,
): Promise<GatewayCounts> {
  const row = await database(d1)
    .select({
      active: sql<number>`SUM(CASE WHEN ${provider.status} = 'active' THEN 1 ELSE 0 END)`,
      total: sql<number>`COUNT(*)`,
    })
    .from(provider)
    .where(
      and(
        eq(provider.organizationId, organizationId),
        eq(provider.providerGatewayId, providerGatewayId),
      ),
    )
    .get();
  return { active: row?.active ?? 0, total: row?.total ?? 0 };
}

/**
 * The foreign key counts every referencing row, not just the ones still
 * serving traffic, so a gateway whose providers were all disabled is still
 * undeletable. Saying "active" there would be a lie the operator cannot act on.
 */
function gatewayInUse(counts: GatewayCounts = { active: 1, total: 1 }): GatewayError {
  const disabled = counts.total - counts.active;
  const message =
    counts.active > 0
      ? disabled > 0
        ? "Delete the active and disabled provider instances routed through this gateway first"
        : "Delete every active provider instance routed through this gateway first"
      : "Disabled provider instances still reference this gateway; delete them to release it";
  return new GatewayError(409, "gateway_in_use", message);
}
