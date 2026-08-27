import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import {
  ProviderCfAigPresetRequestSchema,
  ProviderCreateRequestSchema,
  ProviderUpdateRequestSchema,
} from "../../contracts/schemas";
import { GatewayError } from "../../core/errors";
import {
  probeCfAigPreset,
  probeProviderKey,
  type ProbeResult,
} from "../../core/provider-probe";
import {
  encryptionContext,
  invalidateOrganizationProviders,
} from "../../core/provider-store";
import type { ProviderType } from "../../core/types";
import { database } from "../../db";
import { provider, type CfAigGatewayConfig, type ProviderPricing } from "../../db/schema";
import type { AdminVariables } from "../../middleware/admin";
import { secretVault } from "../../vault";

type ProviderEnv = { Bindings: Env; Variables: AdminVariables };
type ProviderRow = typeof provider.$inferSelect;

/**
 * The response shape for every provider operation. Deliberately write-only: the
 * secret is never echoed, and the last four characters are the only fragment
 * that is ever readable again.
 */
function serialize(row: ProviderRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    secretHint: row.secretHint,
    gateway: row.gateway,
    gatewayConfig: row.gatewayConfig,
    pricing: row.pricing,
    status: row.status,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

async function requestBody(c: Context<ProviderEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
}

function schemaBody<T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new GatewayError(
    400,
    "invalid_request",
    issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request body",
  );
}

/** Drizzle wraps the driver error, so the constraint text lives on the cause. */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (/UNIQUE constraint failed/u.test(current.message)) return true;
  }
  return false;
}

function conflict(type: ProviderType): GatewayError {
  return new GatewayError(
    409,
    "provider_exists",
    `An active ${type} provider already exists; rotate or delete it first`,
  );
}

/** Display-only tail. Short secrets reveal less rather than more. */
function secretHint(secret: string): string {
  return secret.length <= 4 ? secret.slice(-2) : secret.slice(-4);
}

async function insertProvider(
  env: Env,
  input: {
    organizationId: string;
    createdBy: string;
    type: ProviderType;
    name: string;
    secret: string;
    gateway: "cf_aig" | null;
    gatewayConfig: CfAigGatewayConfig | null;
    pricing: ProviderPricing | null;
  },
): Promise<ProviderRow> {
  // The id exists before the ciphertext does, because it is part of the
  // encryption context that pins the blob to this row.
  const id = crypto.randomUUID();
  const secretBlob = await secretVault(env).encryptSecret(
    input.secret,
    encryptionContext(input.organizationId, id),
  );
  const [row] = await database(env.DB).insert(provider).values({
    id,
    organizationId: input.organizationId,
    type: input.type,
    name: input.name,
    secretBlob,
    secretHint: secretHint(input.secret),
    gateway: input.gateway,
    gatewayConfig: input.gatewayConfig,
    pricing: input.pricing,
    createdBy: input.createdBy,
  }).returning();
  return row!;
}

/**
 * Re-probes a credential on rotation, through whatever intermediary the row
 * already describes. A cf_aig row with no stored configuration is corrupt data,
 * not something to paper over with empty URL segments — the same judgement
 * `providerUpstream` makes on the hot path.
 */
async function probeRotation(row: ProviderRow, secret: string): Promise<ProbeResult> {
  if (row.gateway !== "cf_aig") return probeProviderKey(row.type, secret);
  const config = row.gatewayConfig;
  if (!config) {
    throw new GatewayError(
      502,
      "provider_unavailable",
      "Provider is routed through a Cloudflare AI Gateway with no stored configuration",
    );
  }
  return probeCfAigPreset({
    accountId: config.accountId,
    gatewayId: config.gatewayId,
    token: secret,
  });
}

export const providerRoutes = new Hono<ProviderEnv>();

providerRoutes.get("/providers", async (c) => {
  const rows = await database(c.env.DB)
    .select()
    .from(provider)
    .where(eq(provider.organizationId, c.get("admin").organizationId));
  return c.json({ providers: rows.map(serialize) });
});

providerRoutes.post("/providers", async (c) => {
  const admin = c.get("admin");
  const body = schemaBody(ProviderCreateRequestSchema, await requestBody(c));

  const existing = await database(c.env.DB).query.provider.findFirst({
    columns: { id: true },
    where: and(
      eq(provider.organizationId, admin.organizationId),
      eq(provider.type, body.type),
      eq(provider.status, "active"),
    ),
  });
  if (existing) throw conflict(body.type);

  const probe = await probeProviderKey(body.type, body.secret);
  let row: ProviderRow;
  try {
    row = await insertProvider(c.env, {
      organizationId: admin.organizationId,
      createdBy: admin.userId,
      type: body.type,
      name: body.name,
      secret: body.secret,
      gateway: null,
      gatewayConfig: null,
      pricing: body.pricing ?? null,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(body.type);
    throw error;
  }
  invalidateOrganizationProviders(admin.organizationId);
  return c.json({ provider: serialize(row), validated: probe.validated }, 201);
});

providerRoutes.post("/providers/cf-aig-preset", async (c) => {
  const admin = c.get("admin");
  const body = schemaBody(ProviderCfAigPresetRequestSchema, await requestBody(c));
  const probe = await probeCfAigPreset(body);
  const gatewayConfig: CfAigGatewayConfig = {
    accountId: body.accountId,
    gatewayId: body.gatewayId,
  };

  const created: Record<string, unknown>[] = [];
  const conflicts: ProviderType[] = [];
  // The token is encrypted once per row. That is a little redundant, and it is
  // what keeps the data model flat: every row still owns its own credential.
  for (const type of new Set(body.types)) {
    try {
      created.push(serialize(await insertProvider(c.env, {
        organizationId: admin.organizationId,
        createdBy: admin.userId,
        type,
        name: body.name,
        secret: body.token,
        gateway: "cf_aig",
        gatewayConfig,
        pricing: null,
      })));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      conflicts.push(type);
    }
  }
  invalidateOrganizationProviders(admin.organizationId);
  if (created.length === 0) {
    throw new GatewayError(
      409,
      "provider_exists",
      `Active providers already exist for ${conflicts.join(", ")}; rotate or delete them first`,
    );
  }
  return c.json({ providers: created, conflicts, validated: probe.validated }, 201);
});

providerRoutes.put("/providers/:id", async (c) => {
  const admin = c.get("admin");
  const id = c.req.param("id");
  const body = schemaBody(ProviderUpdateRequestSchema, await requestBody(c));
  const row = await database(c.env.DB).query.provider.findFirst({
    where: and(eq(provider.id, id), eq(provider.organizationId, admin.organizationId)),
  });
  if (!row) throw new GatewayError(404, "not_found", "Provider was not found");

  const updates: Partial<typeof provider.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (body.name !== undefined) updates.name = body.name;
  if (body.pricing !== undefined) updates.pricing = body.pricing;

  let validated: boolean | null = null;
  if (body.secret !== undefined) {
    // Rotation keeps the id, so the encryption context — and everything bound
    // to it — is unchanged.
    validated = (await probeRotation(row, body.secret)).validated;
    updates.secretBlob = await secretVault(c.env).encryptSecret(
      body.secret,
      encryptionContext(admin.organizationId, row.id),
    );
    updates.secretHint = secretHint(body.secret);
  }

  const [updated] = await database(c.env.DB)
    .update(provider)
    .set(updates)
    .where(and(eq(provider.id, id), eq(provider.organizationId, admin.organizationId)))
    .returning();
  // The row can be deleted between the lookup and the write. Nothing was
  // updated, so the honest answer is the same 404 the lookup would have given.
  if (!updated) throw new GatewayError(404, "not_found", "Provider was not found");
  invalidateOrganizationProviders(admin.organizationId);
  return c.json({ provider: serialize(updated), validated });
});

providerRoutes.delete("/providers/:id", async (c) => {
  const admin = c.get("admin");
  const id = c.req.param("id");
  const [deleted] = await database(c.env.DB)
    .delete(provider)
    .where(and(eq(provider.id, id), eq(provider.organizationId, admin.organizationId)))
    .returning({ id: provider.id });
  if (!deleted) throw new GatewayError(404, "not_found", "Provider was not found");
  invalidateOrganizationProviders(admin.organizationId);
  return c.json({ deleted: true, provider_id: deleted.id });
});
