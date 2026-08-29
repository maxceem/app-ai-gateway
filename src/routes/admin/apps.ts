import { Hono, type Context } from "hono";
import { and, eq, gte, lte } from "drizzle-orm";
import {
  billingPlanLimits,
  getBillingAccess,
  requireActiveBilling,
  type BillingPlanLimits,
} from "../../billing/gateway";
import {
  invalidateAppConfig,
  loadAppConfig,
  parseStoredAppConfig,
  referencedProviderSlugs,
  validateAppConfigJson,
} from "../../core/config";
import { generateApiKey } from "../../core/apikeys";
import { GatewayError } from "../../core/errors";
import {
  organizationProviders,
  type OrganizationProviders,
} from "../../core/provider-store";
import {
  insertAppWithinCapacity,
  upsertAppWithinCapacity,
} from "../../core/app-writes";
import { database } from "../../db";
import {
  appApiKey,
  app,
  appAuthChallenge,
  appUsageEvent,
  appUser,
} from "../../db/schema";
import type { AdminVariables } from "../../middleware/admin";
import { AppWriteSchema } from "../../contracts/schemas";
import { currentMonth, eventDay, monthBounds, usageTotals } from "./shared";

const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const APP_ID_MAX_LENGTH = 63;
const APP_ID_SUFFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

interface AppUpsertBody {
  name: string;
  config: Record<string, unknown>;
  status?: "active" | "disabled";
}

function appBody(value: unknown): AppUpsertBody {
  const parsed = AppWriteSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new GatewayError(
      400,
      "invalid_request",
      issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid application body",
    );
  }
  const body = parsed.data;
  return {
    name: body.name,
    config: body.config,
    ...(body.status === "active" || body.status === "disabled" ? { status: body.status } : {}),
  };
}

function assertAppId(appId: string): string {
  if (!APP_ID.test(appId)) throw new GatewayError(400, "invalid_request", "App id must be a lowercase slug");
  return appId;
}

function slugifyAppName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, APP_ID_MAX_LENGTH)
    .replace(/-+$/u, "");
  return slug || "app";
}

function randomAppIdSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => APP_ID_SUFFIX_ALPHABET[byte % APP_ID_SUFFIX_ALPHABET.length]).join("");
}

function suffixedAppId(base: string): string {
  const suffix = randomAppIdSuffix();
  const stem = base.slice(0, APP_ID_MAX_LENGTH - suffix.length - 1).replace(/-+$/u, "");
  return `${stem}-${suffix}`;
}

function asBadRequest(error: unknown): never {
  if (
    error instanceof GatewayError
    && (error.code === "plan_limit_exceeded" || error.code === "billing_unavailable")
  ) {
    throw error;
  }
  if (error instanceof GatewayError) throw new GatewayError(400, "invalid_request", error.message);
  throw error;
}

/**
 * Writes are validated against the global price catalog merged with this
 * organization's own overrides, so a model the operator has priced under
 * Providers is configurable here too. `grandfathered` carries the slugs the
 * app's stored configuration already names, which an update may keep even if
 * the instance behind one has since been deleted; creates pass nothing.
 */
function validatedConfig(
  next: Record<string, unknown>,
  ceilings: BillingPlanLimits,
  providers: OrganizationProviders,
  grandfathered?: ReadonlySet<string>,
): ReturnType<typeof validateAppConfigJson> {
  try {
    return validateAppConfigJson(next, ceilings, providers, grandfathered);
  } catch (error) {
    asBadRequest(error);
  }
}

function summary(
  config: ReturnType<typeof validateAppConfigJson>,
  providerIndex: OrganizationProviders,
) {
  const providerSlugs = config.routing.providers.mode === "all"
    ? Object.keys(providerIndex)
    : Object.keys(config.routing.providers.selected ?? {});
  const models = new Set<string>();
  for (const provider of Object.values(config.routing.providers.selected ?? {})) {
    for (const model of provider?.allowed_models ?? []) models.add(model);
  }
  return {
    authentication_type: config.authentication.type,
    apple_bundle_id: config.authentication.type === "apple_app_attest"
      ? config.authentication.app_attest.bundle_id
      : null,
    monthly_user_budget_usd: config.limits.per_user.spending.monthly_usd,
    monthly_app_budget_usd: config.limits.per_app.spending.monthly_usd,
    providers: providerSlugs,
    allowed_model_count: models.size,
  };
}

function serializeRow(row: typeof app.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    config: row.config,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

type AppRouteEnv = { Bindings: Env; Variables: AdminVariables };

export const appRoutes = new Hono<AppRouteEnv>();

async function activePlanLimits(c: Context<AppRouteEnv>): Promise<BillingPlanLimits> {
  const access = requireActiveBilling(await getBillingAccess(
    c.env,
    c.get("admin").organizationId,
    c.get("billingRequestCache"),
  ));
  return billingPlanLimits(access);
}

function appCapacityError(maxApps: number): GatewayError {
  return new GatewayError(
    403,
    "plan_limit_exceeded",
    `The plan allows at most ${maxApps} application${maxApps === 1 ? "" : "s"}`,
  );
}

async function organizationAtCapacity(
  d1: D1Database,
  organizationId: string,
  maxApps: number | undefined,
): Promise<boolean> {
  if (maxApps === undefined) return false;
  const row = await d1.prepare(
    "SELECT COUNT(*) AS count FROM app WHERE organization_id = ?",
  ).bind(organizationId).first<{ count: number }>();
  return (row?.count ?? 0) >= maxApps;
}

appRoutes.get("/apps", async (c) => {
  const month = c.req.query("month") ?? currentMonth();
  const bounds = monthBounds(month);
  const db = database(c.env.DB);
  const organizationId = c.get("admin").organizationId;
  const providerIndex = await organizationProviders(c.env, organizationId);
  const rows = await db
    .select()
    .from(app)
    .where(eq(app.organizationId, organizationId))
    .orderBy(app.id);
  const usage = await db
    .select({ appId: appUsageEvent.appId, ...usageTotals })
    .from(appUsageEvent)
    .innerJoin(app, eq(appUsageEvent.appId, app.id))
    .where(and(
      eq(app.organizationId, organizationId),
      gte(eventDay, bounds.from),
      lte(eventDay, bounds.to),
    ))
    .groupBy(appUsageEvent.appId);
  const usageByApp = new Map(usage.map((row) => [row.appId, row]));
  const counts = await c.env.DB.prepare(
    `WITH identities AS (
       SELECT app_user.app_id, app_user.id, app_user.status
         FROM app_user
         JOIN app AS owned_app ON owned_app.id = app_user.app_id
        WHERE owned_app.organization_id = ?
       UNION ALL
       SELECT events.app_id, events.user_id AS id, 'active' AS status
         FROM app_usage_event AS events
         JOIN app AS owned_app ON owned_app.id = events.app_id
        WHERE owned_app.organization_id = ?
          AND
          NOT EXISTS (
          SELECT 1 FROM app_user WHERE app_user.app_id = events.app_id AND app_user.id = events.user_id
        )
        GROUP BY events.app_id, events.user_id
     )
     SELECT app_id, COUNT(*) AS total,
            SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
       FROM identities GROUP BY app_id`,
  ).bind(organizationId, organizationId).all<{
    app_id: string;
    total: number;
    blocked: number;
  }>();
  const countsByApp = new Map(counts.results.map((row) => [row.app_id, row]));

  return c.json({
    month,
    apps: rows.map((row) => {
      const totals = usageByApp.get(row.id);
      const userCounts = countsByApp.get(row.id);
      let configSummary: ReturnType<typeof summary> | {
        authentication_type: "invalid";
        apple_bundle_id: null;
        monthly_user_budget_usd: null;
        monthly_app_budget_usd: null;
        providers: string[];
        allowed_model_count: number;
      };
      try {
        configSummary = summary(parseStoredAppConfig(row.config, null).stored, providerIndex);
      } catch {
        configSummary = {
          authentication_type: "invalid",
          apple_bundle_id: null,
          monthly_user_budget_usd: null,
          monthly_app_budget_usd: null,
          providers: [],
          allowed_model_count: 0,
        };
      }
      return {
        id: row.id,
        name: row.name,
        status: row.status,
        created_at: row.createdAt,
        ...configSummary,
        users: { total: userCounts?.total ?? 0, blocked: userCounts?.blocked ?? 0 },
        usage: {
          requests: totals?.requests ?? 0,
          input_tokens: totals?.input_tokens ?? 0,
          cached_input_tokens: totals?.cached_input_tokens ?? 0,
          cache_write_tokens: totals?.cache_write_tokens ?? 0,
          output_tokens: totals?.output_tokens ?? 0,
          cost_usd: totals?.cost_usd ?? 0,
          errors: totals?.errors ?? 0,
          blocked: totals?.blocked ?? 0,
        },
      };
    }),
  });
});

appRoutes.post("/apps", async (c) => {
  const planLimits = await activePlanLimits(c);
  const value = await c.req.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
  const raw = value as Record<string, unknown>;
  const body = appBody(raw);
  const name = body.name.trim();
  if (name.length === 0 || name.length > 100) throw new GatewayError(400, "invalid_request", "name must be 1-100 characters");
  if (raw.id !== undefined && typeof raw.id !== "string") throw new GatewayError(400, "invalid_request", "id must be a lowercase slug");
  const requestedId = raw.id === undefined ? slugifyAppName(name) : assertAppId(raw.id);
  const organizationId = c.get("admin").organizationId;
  const config = validatedConfig(
    body.config,
    planLimits,
    await organizationProviders(c.env, organizationId),
  );
  const db = database(c.env.DB);
  let appId = requestedId;
  let created = false;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    created = await insertAppWithinCapacity(c.env.DB, {
      id: appId,
      organizationId,
      name,
      config,
      status: body.status ?? "active",
    }, planLimits.maxApps);
    if (created) break;
    if (await organizationAtCapacity(c.env.DB, organizationId, planLimits.maxApps)) {
      throw appCapacityError(planLimits.maxApps!);
    }
    appId = suffixedAppId(requestedId);
  }
  if (!created) throw new GatewayError(409, "invalid_request", "Could not allocate a unique app id");

  let createdKey: { id: string; name: string; key: string; key_prefix: string; created_at: string } | null = null;
  try {
    if (config.authentication.type === "api_key") {
      const generated = await generateApiKey();
      const [row] = await db.insert(appApiKey).values({
        id: generated.id,
        appId,
        name: "Default key",
        keyHash: generated.keyHash,
        keyPrefix: generated.keyPrefix,
      }).returning();
      createdKey = {
        id: row!.id,
        name: row!.name,
        key: generated.key,
        key_prefix: row!.keyPrefix,
        created_at: row!.createdAt,
      };
    }
  } catch (error) {
    await db.delete(app).where(eq(app.id, appId));
    throw error;
  }
  invalidateAppConfig(appId);
  return c.json({ app_id: appId, api_key: createdKey }, 201);
});

appRoutes.get("/apps/:app", async (c) => {
  const appId = c.req.param("app");
  const row = await database(c.env.DB).query.app.findFirst({
    where: and(
      eq(app.id, appId),
      eq(app.organizationId, c.get("admin").organizationId),
    ),
  });
  if (!row) throw new GatewayError(404, "app_not_found", "App is not registered");
  let resolved: unknown = null;
  let configError: string | null = null;
  try {
    parseStoredAppConfig(row.config, null);
    resolved = await loadAppConfig(c.env, appId);
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  return c.json({ app: serializeRow(row), resolved, config_error: configError });
});

appRoutes.post("/apps/:app/validate", async (c) => {
  const planLimits = await activePlanLimits(c);
  const appId = assertAppId(c.req.param("app"));
  const body = appBody(await c.req.json());
  const existing = await database(c.env.DB).query.app.findFirst({
    where: and(
      eq(app.id, appId),
      eq(app.organizationId, c.get("admin").organizationId),
    ),
  });
  validatedConfig(
    body.config,
    planLimits,
    await organizationProviders(c.env, c.get("admin").organizationId),
    existing ? referencedProviderSlugs(existing.config) : undefined,
  );
  return c.json({ valid: true, app_id: appId, exists: existing !== undefined });
});

appRoutes.on(["PUT", "POST"], "/apps/:app", async (c) => {
  const planLimits = await activePlanLimits(c);
  const appId = assertAppId(c.req.param("app"));
  const body = appBody(await c.req.json());
  const db = database(c.env.DB);
  const organizationId = c.get("admin").organizationId;
  // An upsert of an existing app is an update: the slugs it already names stay
  // writable even if their provider rows were deleted in the meantime.
  const existing = await db.query.app.findFirst({
    columns: { config: true },
    where: and(eq(app.id, appId), eq(app.organizationId, organizationId)),
  });
  const config = validatedConfig(
    body.config,
    planLimits,
    await organizationProviders(c.env, organizationId),
    existing ? referencedProviderSlugs(existing.config) : undefined,
  );
  const values = {
    id: appId,
    organizationId,
    name: body.name,
    config,
    status: body.status ?? "active",
    updatedAt: new Date().toISOString(),
  };
  const written = await upsertAppWithinCapacity(c.env.DB, values, planLimits.maxApps);
  if (!written) {
    const occupied = await db.query.app.findFirst({
      columns: { organizationId: true },
      where: eq(app.id, appId),
    });
    if (occupied && occupied.organizationId !== organizationId) {
      throw new GatewayError(404, "app_not_found", "App is not registered");
    }
    if (await organizationAtCapacity(c.env.DB, organizationId, planLimits.maxApps)) {
      throw appCapacityError(planLimits.maxApps!);
    }
    throw new GatewayError(409, "invalid_request", "The application changed concurrently; retry the request");
  }
  invalidateAppConfig(appId);
  const loaded = await loadAppConfig(c.env, appId);
  return c.json({ app: loaded }, 200);
});

appRoutes.delete("/apps/:app", async (c) => {
  const appId = c.req.param("app");
  if (c.req.query("confirm") !== appId) throw new GatewayError(400, "invalid_request", "Pass ?confirm=<app-id> to delete an app");
  const db = database(c.env.DB);
  const existing = await db.query.app.findFirst({
    where: and(
      eq(app.id, appId),
      eq(app.organizationId, c.get("admin").organizationId),
    ),
  });
  if (!existing) throw new GatewayError(404, "app_not_found", "App is not registered");
  const removedUsers = await db.delete(appUser).where(eq(appUser.appId, appId)).returning({ id: appUser.id });
  await db.delete(appAuthChallenge).where(eq(appAuthChallenge.appId, appId));
  await db.delete(appApiKey).where(eq(appApiKey.appId, appId));
  await db.delete(app).where(and(
    eq(app.id, appId),
    eq(app.organizationId, c.get("admin").organizationId),
  ));
  invalidateAppConfig(appId);
  return c.json({ deleted: appId, removed_users: removedUsers.length, usage_events_retained: true });
});
