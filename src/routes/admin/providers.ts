import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  ProviderCreateRequestSchema,
  ProviderUpdateRequestSchema,
} from "../../contracts/schemas";
import { GatewayError } from "../../core/errors";
import { probeProviderGateway, probeProviderKey } from "../../core/provider-probe";
import {
  decryptProviderGatewaySecret,
  encryptionContext,
  invalidateOrganizationProviders,
} from "../../core/provider-store";
import { PROVIDER_TYPES } from "../../core/providers";
import type { ProviderType } from "../../core/types";
import { database } from "../../db";
import {
  provider,
  providerGateway,
  type ProviderPricing,
} from "../../db/schema";
import type { AdminVariables } from "../../middleware/admin";
import { secretVault } from "../../vault";
import {
  databaseErrorMatches,
  providerRequestBody,
  providerSchemaBody,
  secretHint,
} from "./provider-shared";

type ProviderEnv = { Bindings: Env; Variables: AdminVariables };
type ProviderRow = typeof provider.$inferSelect;

/** Provider secrets remain write-only; gateway rows expose only their id. */
function serialize(row: ProviderRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    slug: row.slug,
    name: row.name,
    secretHint: row.secretHint,
    providerGatewayId: row.providerGatewayId,
    pricing: row.pricing,
    status: row.status,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

function slugConflict(slug: string): GatewayError {
  return new GatewayError(
    409,
    "slug_taken",
    `An active provider instance already uses slug ${slug}; choose a different slug`,
  );
}

function assertReservedSlug(type: ProviderType, slug: string): void {
  if (PROVIDER_TYPES.includes(slug as ProviderType) && slug !== type) {
    throw new GatewayError(
      400,
      "invalid_request",
      `Reserved slug ${slug} may only be used by a ${slug} provider`,
    );
  }
}

async function insertProvider(
  env: Env,
  input: {
    organizationId: string;
    createdBy: string;
    type: ProviderType;
    slug: string;
    name: string;
    secret?: string;
    providerGatewayId?: string;
    pricing: ProviderPricing | null;
  },
): Promise<ProviderRow> {
  const id = crypto.randomUUID();
  const direct = input.secret !== undefined;
  const secretBlob = direct
    ? await secretVault(env).encryptSecret(
        input.secret!,
        encryptionContext(input.organizationId, id),
      )
    : null;
  const [row] = await database(env.DB).insert(provider).values({
    id,
    organizationId: input.organizationId,
    type: input.type,
    slug: input.slug,
    name: input.name,
    secretBlob,
    secretHint: direct ? secretHint(input.secret!) : null,
    providerGatewayId: input.providerGatewayId ?? null,
    pricing: input.pricing,
    createdBy: input.createdBy,
  }).returning();
  return row!;
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
  const body = providerSchemaBody(ProviderCreateRequestSchema, await providerRequestBody(c));
  const slug = body.slug ?? body.type;
  assertReservedSlug(body.type, slug);

  const existing = await database(c.env.DB).query.provider.findFirst({
    columns: { id: true },
    where: and(
      eq(provider.organizationId, admin.organizationId),
      eq(provider.slug, slug),
      eq(provider.status, "active"),
    ),
  });
  if (existing) throw slugConflict(slug);

  let validated: boolean;
  let secret: string | undefined;
  let providerGatewayId: string | undefined;
  if (body.secret !== undefined) {
    secret = body.secret;
    validated = (await probeProviderKey(body.type, body.secret)).validated;
  } else {
    const gatewayId = body.providerGatewayId;
    if (!gatewayId) {
      throw new GatewayError(400, "invalid_request", "providerGatewayId is required");
    }
    providerGatewayId = gatewayId;
    const gateway = await database(c.env.DB).query.providerGateway.findFirst({
      where: and(
        eq(providerGateway.id, gatewayId),
        eq(providerGateway.organizationId, admin.organizationId),
        eq(providerGateway.status, "active"),
      ),
    });
    if (!gateway) {
      throw new GatewayError(404, "not_found", "Provider gateway was not found");
    }
    const token = await decryptProviderGatewaySecret(
      c.env,
      admin.organizationId,
      gateway.id,
      gateway.secretBlob,
    );
    validated = (await probeProviderGateway({
      type: body.type,
      accountId: gateway.config.accountId,
      gatewayId: gateway.config.gatewayId,
      token,
    })).validated;
  }

  let row: ProviderRow;
  try {
    row = await insertProvider(c.env, {
      organizationId: admin.organizationId,
      createdBy: admin.userId,
      type: body.type,
      slug,
      name: body.name,
      ...(secret === undefined ? {} : { secret }),
      ...(providerGatewayId === undefined ? {} : { providerGatewayId }),
      pricing: body.pricing ?? null,
    });
  } catch (error) {
    if (databaseErrorMatches(error, /UNIQUE constraint failed/u)) throw slugConflict(slug);
    if (databaseErrorMatches(error, /FOREIGN KEY constraint failed/u)) {
      throw new GatewayError(404, "not_found", "Provider gateway was not found");
    }
    throw error;
  }
  invalidateOrganizationProviders(admin.organizationId);
  return c.json({ provider: serialize(row), validated }, 201);
});

providerRoutes.put("/providers/:id", async (c) => {
  const admin = c.get("admin");
  const id = c.req.param("id");
  const body = providerSchemaBody(ProviderUpdateRequestSchema, await providerRequestBody(c));
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
    if (row.providerGatewayId !== null) {
      throw new GatewayError(
        409,
        "provider_gateway_managed",
        `This provider uses a shared gateway token; rotate it at /v1/admin/provider-gateways/${row.providerGatewayId}/rotate`,
      );
    }
    validated = (await probeProviderKey(row.type, body.secret)).validated;
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
