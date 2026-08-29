import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import {
  ProviderCreateRequestSchema,
  ProviderTestRequestSchema,
  ProviderUpdateRequestSchema,
} from "../../contracts/schemas";
import { assertRouteServesProvider } from "../../core/capabilities";
import { GatewayError } from "../../core/errors";
import { checkOperatorBaseUrl } from "../../core/origin-guard";
import {
  assertGatewayRoute,
  isGatewayType,
  resolveGateway,
  type ResolvedGateway,
} from "../../core/gateways";
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
  type GatewayRouteConfig,
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
    gatewayRoute: row.gatewayRoute,
    baseUrl: row.baseUrl,
    pricing: row.pricing,
    status: row.status,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

/**
 * The only door a base URL comes through. The guard's refusal message names the
 * rule that was broken, so it is passed through verbatim rather than replaced
 * with "invalid URL" — the operator is looking at the field they just typed.
 * What is stored is the guard's canonical form, never the raw input.
 */
function guardedBaseUrl(raw: string): string {
  const checked = checkOperatorBaseUrl(raw);
  if (!checked.ok) throw new GatewayError(400, "invalid_request", checked.message);
  return checked.baseUrl;
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
    gatewayRoute: GatewayRouteConfig | null;
    baseUrl: string | null;
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
    gatewayRoute: input.gatewayRoute,
    baseUrl: input.baseUrl,
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

/**
 * Reads the gateway token an instance would authenticate with. Kept separate
 * from the create path so a probe never needs a stored row to exist.
 */
async function gatewayToken(
  c: Context<ProviderEnv>,
  organizationId: string,
  gatewayId: string,
): Promise<{ gateway: ResolvedGateway; token: string }> {
  const row = await database(c.env.DB).query.providerGateway.findFirst({
    where: and(
      eq(providerGateway.id, gatewayId),
      eq(providerGateway.organizationId, organizationId),
      eq(providerGateway.status, "active"),
    ),
  });
  if (!row) throw new GatewayError(404, "not_found", "Provider gateway was not found");
  // The stored type comes from a CHECK wider than the adapter registry, so a
  // row this deployment cannot serve is refused here rather than mis-read as
  // another gateway's configuration.
  if (!isGatewayType(row.type)) {
    throw new GatewayError(
      400,
      "invalid_request",
      `This deployment has no adapter for ${row.type} provider gateways`,
    );
  }
  return {
    gateway: resolveGateway(row.type, row.config),
    token: await decryptProviderGatewaySecret(c.env, organizationId, row.id, row.secretBlob),
  };
}

/**
 * Probes a credential without storing anything, so an operator can check a key
 * before committing to it. Nothing is written and nothing is echoed back: the
 * answer is the probe's own, including why it proved nothing, and a credential
 * the provider refuses fails with provider_key_invalid as it would on create.
 */
providerRoutes.post("/providers/test", async (c) => {
  const admin = c.get("admin");
  const body = providerSchemaBody(ProviderTestRequestSchema, await providerRequestBody(c));
  if (body.secret !== undefined) {
    // Guarded here too: a dry run must not be a way to make this Worker fetch
    // an origin the create path would have refused.
    const baseUrl = body.baseUrl === undefined ? null : guardedBaseUrl(body.baseUrl);
    return c.json(await probeProviderKey(body.type, body.secret, baseUrl));
  }
  // The schema admits exactly one of the two, so this is the gateway case.
  const resolved = await gatewayToken(c, admin.organizationId, body.providerGatewayId!);
  // Said here rather than reported as an inconclusive probe: "this gateway does
  // not serve DeepSeek" and "nothing could be proven" are different answers.
  assertRouteServesProvider(resolved.gateway.type, body.type);
  return c.json(await probeProviderGateway({ type: body.type, ...resolved }));
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

  const gatewayRoute = body.gatewayRoute ?? null;
  // The contract already refuses baseUrl alongside providerGatewayId, so a
  // stored override always belongs to a direct row.
  const baseUrl = body.baseUrl === undefined ? null : guardedBaseUrl(body.baseUrl);
  let validated: boolean;
  let secret: string | undefined;
  let providerGatewayId: string | undefined;
  if (body.secret !== undefined) {
    assertGatewayRoute(null, gatewayRoute);
    secret = body.secret;
    // Probed at the origin this row will really call, so a wrong URL fails now
    // rather than on the first request an app makes.
    validated = (await probeProviderKey(body.type, body.secret, baseUrl)).validated;
  } else {
    const gatewayId = body.providerGatewayId;
    if (!gatewayId) {
      throw new GatewayError(400, "invalid_request", "providerGatewayId is required");
    }
    providerGatewayId = gatewayId;
    const resolved = await gatewayToken(c, admin.organizationId, gatewayId);
    // A gateway with no mapping for this provider type could never carry one of
    // its requests, so the row is refused instead of being stored dead.
    assertRouteServesProvider(resolved.gateway.type, body.type);
    // The adapter that will carry the traffic is the only judge of its own
    // routing configuration, so a route is never stored unvalidated.
    assertGatewayRoute(resolved.gateway.type, gatewayRoute);
    validated = (await probeProviderGateway({ type: body.type, ...resolved })).validated;
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
      gatewayRoute,
      baseUrl,
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
  if (body.gatewayRoute !== undefined) {
    const gatewayType = row.providerGatewayId === null
      ? null
      : (await gatewayToken(c, admin.organizationId, row.providerGatewayId)).gateway.type;
    assertGatewayRoute(gatewayType, body.gatewayRoute);
    updates.gatewayRoute = body.gatewayRoute;
  }

  // The effective origin after this write, which is also what any probe below
  // must use: a new value, an explicit clear back to the provider's own base
  // URL, or the one already stored.
  let baseUrl = row.baseUrl;
  if (body.baseUrl !== undefined) {
    // Clearing is always allowed, including on a routed row: `null` is how an
    // operator gets rid of a value, and refusing that would strand a row that
    // acquired one before it was attached to a gateway.
    if (body.baseUrl !== null && row.providerGatewayId !== null) {
      throw new GatewayError(
        400,
        "invalid_request",
        "A gateway-routed instance cannot carry a base URL: the gateway owns the upstream origin",
      );
    }
    baseUrl = body.baseUrl === null ? null : guardedBaseUrl(body.baseUrl);
    updates.baseUrl = baseUrl;
  }

  let validated: boolean | null = null;
  if (body.secret !== undefined) {
    if (row.providerGatewayId !== null) {
      throw new GatewayError(
        409,
        "provider_gateway_managed",
        `This provider uses a shared gateway token; rotate it at /v1/admin/provider-gateways/${row.providerGatewayId}/rotate`,
      );
    }
    validated = (await probeProviderKey(row.type, body.secret, baseUrl)).validated;
    updates.secretBlob = await secretVault(c.env).encryptSecret(
      body.secret,
      encryptionContext(admin.organizationId, row.id),
    );
    updates.secretHint = secretHint(body.secret);
  } else if (body.baseUrl !== undefined && row.secretBlob !== null) {
    // Moving an instance to a new origin is as much a configuration change as
    // rotating its key, so it is proven the same way, against the credential
    // already stored. A vault this deployment can no longer read is not a
    // reason to refuse the edit — it fails loudly on the next request instead.
    try {
      const secret = await secretVault(c.env).decryptSecret(
        row.secretBlob,
        encryptionContext(admin.organizationId, row.id),
      );
      validated = (await probeProviderKey(row.type, secret, baseUrl)).validated;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      validated = false;
    }
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
