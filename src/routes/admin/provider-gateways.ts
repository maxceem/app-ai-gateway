import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  ProviderGatewayCreateRequestSchema,
  ProviderGatewayRotateRequestSchema,
  ProviderGatewayTestRequestSchema,
  ProviderGatewayUpdateRequestSchema,
} from "../../contracts/schemas";
import { GatewayError } from "../../core/errors";
import {
  requireGatewayAdapter,
  resolveGateway,
  type ResolvedGateway,
} from "../../core/gateways";
import { probeGatewayPreset, type ProbeResult } from "../../core/provider-probe";
import {
  gatewayEncryptionContext,
  invalidateOrganizationProviders,
} from "../../core/provider-store";
import { database } from "../../db";
import { provider, providerGateway } from "../../db/schema";
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

function serialize(row: ProviderGatewayRow, counts: GatewayCounts): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    config: row.config,
    secretHint: row.secretHint,
    providerCount: counts.active,
    referencedCount: counts.total,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
  };
}

const NO_REFERENCES: GatewayCounts = { active: 0, total: 0 };

/**
 * What the probe found, reported rather than enforced.
 *
 * A Cloudflare AI Gateway answers 401 both for a token that is wrong and for a
 * gateway whose authentication or upstream key is not set up yet, so a refusal
 * here is not proof of a bad token — and blocking on it would stop an operator
 * from saving a connection while the rest of it is still being built. The
 * verdict travels back so the console can say what happened, and `POST
 * /provider-gateways/test` re-runs it on demand.
 */
function probeReport(probe: ProbeResult): Record<string, unknown> {
  return {
    validated: probe.validated,
    ...(probe.reason === undefined ? {} : { reason: probe.reason }),
    ...(probe.status === undefined ? {} : { status: probe.status }),
  };
}

/**
 * The config union is built here and nowhere else, so a stored row's
 * `type`/`config_json` pair is always one the adapter registry can resolve —
 * and a dry run probes the same connection a create would have stored.
 */
function requestedGateway(
  body:
    | { type: "cf_aig"; accountId: string; gatewayId: string }
    | { type: "vercel" },
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
  const body = providerSchemaBody(
    ProviderGatewayTestRequestSchema,
    await providerRequestBody(c),
  );
  return c.json(probeReport(await probeGatewayPreset(requestedGateway(body), body.token)));
});

providerGatewayRoutes.get("/provider-gateways", async (c) => {
  const organizationId = c.get("admin").organizationId;
  const db = database(c.env.DB);
  const [gateways, counts] = await Promise.all([
    db.select().from(providerGateway)
      .where(eq(providerGateway.organizationId, organizationId)),
    db.select({
      providerGatewayId: provider.providerGatewayId,
      active: sql<number>`SUM(CASE WHEN ${provider.status} = 'active' THEN 1 ELSE 0 END)`,
      total: sql<number>`COUNT(*)`,
    }).from(provider).where(
      eq(provider.organizationId, organizationId),
    ).groupBy(provider.providerGatewayId),
  ]);
  const countById = new Map(counts.flatMap((row) =>
    row.providerGatewayId === null
      ? []
      : [[row.providerGatewayId, { active: row.active, total: row.total }] as const]
  ));
  return c.json({
    gateways: gateways.map((row) => serialize(row, countById.get(row.id) ?? NO_REFERENCES)),
  });
});

providerGatewayRoutes.post("/provider-gateways", async (c) => {
  const admin = c.get("admin");
  const body = providerSchemaBody(
    ProviderGatewayCreateRequestSchema,
    await providerRequestBody(c),
  );
  const gateway = requestedGateway(body);
  const probe = await probeGatewayPreset(gateway, body.token);
  const id = crypto.randomUUID();
  const secretBlob = await secretVault(c.env).encryptSecret(
    body.token,
    gatewayEncryptionContext(admin.organizationId, id),
  );
  const [row] = await database(c.env.DB).insert(providerGateway).values({
    id,
    organizationId: admin.organizationId,
    type: gateway.type,
    name: body.name,
    config: gateway.config,
    secretBlob,
    secretHint: secretHint(body.token),
    createdBy: admin.userId,
  }).returning();
  invalidateOrganizationProviders(admin.organizationId);
  return c.json({ gateway: serialize(row!, NO_REFERENCES), ...probeReport(probe) }, 201);
});

providerGatewayRoutes.patch("/provider-gateways/:id", async (c) => {
  const admin = c.get("admin");
  const id = c.req.param("id");
  const body = providerSchemaBody(
    ProviderGatewayUpdateRequestSchema,
    await providerRequestBody(c),
  );
  const [row] = await database(c.env.DB).update(providerGateway).set({
    name: body.name,
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(providerGateway.id, id),
    eq(providerGateway.organizationId, admin.organizationId),
    eq(providerGateway.status, "active"),
  )).returning();
  if (!row) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  invalidateOrganizationProviders(admin.organizationId);
  const counts = await gatewayCounts(c.env.DB, admin.organizationId, id);
  return c.json({ gateway: serialize(row, counts) });
});

providerGatewayRoutes.post("/provider-gateways/:id/rotate", async (c) => {
  const admin = c.get("admin");
  const id = c.req.param("id");
  const body = providerSchemaBody(
    ProviderGatewayRotateRequestSchema,
    await providerRequestBody(c),
  );
  const existing = await database(c.env.DB).query.providerGateway.findFirst({
    where: and(
      eq(providerGateway.id, id),
      eq(providerGateway.organizationId, admin.organizationId),
      eq(providerGateway.status, "active"),
    ),
  });
  if (!existing) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  // A stored type the CHECK admits but no adapter implements cannot be probed,
  // and rotating a token onto a route nothing can serve would be a silent no-op.
  const probe = await probeGatewayPreset(
    resolveGateway(requireGatewayAdapter(existing.type), existing.config),
    body.token,
  );
  const secretBlob = await secretVault(c.env).encryptSecret(
    body.token,
    gatewayEncryptionContext(admin.organizationId, id),
  );
  const [row] = await database(c.env.DB).update(providerGateway).set({
    secretBlob,
    secretHint: secretHint(body.token),
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(providerGateway.id, id),
    eq(providerGateway.organizationId, admin.organizationId),
  )).returning();
  if (!row) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  invalidateOrganizationProviders(admin.organizationId);
  const counts = await gatewayCounts(c.env.DB, admin.organizationId, id);
  return c.json({
    gateway: serialize(row, counts),
    ...probeReport(probe),
  });
});

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
    await database(c.env.DB).delete(providerGateway).where(and(
      eq(providerGateway.id, id),
      eq(providerGateway.organizationId, admin.organizationId),
    ));
  } catch (error) {
    if (databaseErrorMatches(error, /FOREIGN KEY constraint failed/u)) throw gatewayInUse();
    throw error;
  }
  invalidateOrganizationProviders(admin.organizationId);
  return c.json({ deleted: true, provider_gateway_id: id });
});

async function gatewayCounts(
  d1: D1Database,
  organizationId: string,
  providerGatewayId: string,
): Promise<GatewayCounts> {
  const row = await database(d1).select({
    active: sql<number>`SUM(CASE WHEN ${provider.status} = 'active' THEN 1 ELSE 0 END)`,
    total: sql<number>`COUNT(*)`,
  })
    .from(provider)
    .where(and(
      eq(provider.organizationId, organizationId),
      eq(provider.providerGatewayId, providerGatewayId),
    ))
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
  const message = counts.active > 0
    ? disabled > 0
      ? "Delete the active and disabled provider instances routed through this gateway first"
      : "Delete every active provider instance routed through this gateway first"
    : "Disabled provider instances still reference this gateway; delete them to release it";
  return new GatewayError(409, "gateway_in_use", message);
}
