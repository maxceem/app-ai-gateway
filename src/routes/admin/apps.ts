import { Hono } from "hono";
import { and, eq, gte, lte } from "drizzle-orm";
import {
  invalidateAppConfig,
  loadAppConfig,
  PROVIDERS,
  validateAppConfigJson,
} from "../../core/config";
import { generateApiKey } from "../../core/apikeys";
import { GatewayError } from "../../core/errors";
import { database } from "../../db";
import {
  apiKeys,
  apps,
  authChallenges,
  developmentCredentials,
  usageEvents,
  users,
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
  if (error instanceof GatewayError) throw new GatewayError(400, "invalid_request", error.message);
  throw error;
}

function validatedConfig(
  next: Record<string, unknown>,
): ReturnType<typeof validateAppConfigJson> {
  try {
    return validateAppConfigJson(next);
  } catch (error) {
    asBadRequest(error);
  }
}

function summary(config: ReturnType<typeof validateAppConfigJson>) {
  const providers = config.routing.providers.mode === "all"
    ? [...PROVIDERS]
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
    providers,
    allowed_model_count: models.size,
    dev_access_enabled:
      config.authentication.type === "apple_app_attest"
      && config.authentication.development_access,
  };
}

function serializeRow(row: typeof apps.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    config: row.config,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export const appRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

appRoutes.get("/apps", async (c) => {
  const month = c.req.query("month") ?? currentMonth();
  const bounds = monthBounds(month);
  const db = database(c.env.DB);
  const rows = await db.select().from(apps).orderBy(apps.id);
  const usage = await db
    .select({ appId: usageEvents.appId, ...usageTotals })
    .from(usageEvents)
    .where(and(gte(eventDay, bounds.from), lte(eventDay, bounds.to)))
    .groupBy(usageEvents.appId);
  const usageByApp = new Map(usage.map((row) => [row.appId, row]));
  const counts = await c.env.DB.prepare(
    `WITH identities AS (
       SELECT app_id, id, status FROM users
       UNION ALL
       SELECT events.app_id, events.user_id AS id, 'active' AS status
         FROM usage_events AS events
        WHERE NOT EXISTS (
          SELECT 1 FROM users WHERE users.app_id = events.app_id AND users.id = events.user_id
        )
        GROUP BY events.app_id, events.user_id
     )
     SELECT app_id, COUNT(*) AS total,
            SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
       FROM identities GROUP BY app_id`,
  ).all<{ app_id: string; total: number; blocked: number }>();
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
        dev_access_enabled: false;
      };
      try {
        configSummary = summary(validateAppConfigJson(row.config));
      } catch {
        configSummary = {
          authentication_type: "invalid",
          apple_bundle_id: null,
          monthly_user_budget_usd: null,
          monthly_app_budget_usd: null,
          providers: [],
          allowed_model_count: 0,
          dev_access_enabled: false,
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
  const config = validatedConfig(body.config);
  if (config.authentication.type === "apple_app_attest" && config.authentication.development_access) {
    throw new GatewayError(
      400,
      "invalid_request",
      "Create the app with development_access false, then generate its development credential",
    );
  }

  const db = database(c.env.DB);
  let appId = requestedId;
  let created = false;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const rows = await db.insert(apps).values({
      id: appId,
      name,
      config,
      status: body.status ?? "active",
    }).onConflictDoNothing({ target: apps.id }).returning({ id: apps.id });
    if (rows.length > 0) {
      created = true;
      break;
    }
    appId = suffixedAppId(requestedId);
  }
  if (!created) throw new GatewayError(409, "invalid_request", "Could not allocate a unique app id");

  let createdKey: { id: string; name: string; key: string; key_prefix: string; created_at: string } | null = null;
  try {
    if (config.authentication.type === "api_key") {
      const generated = await generateApiKey();
      const [row] = await db.insert(apiKeys).values({
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
    await db.delete(apps).where(eq(apps.id, appId));
    throw error;
  }
  invalidateAppConfig(appId);
  return c.json({ app_id: appId, api_key: createdKey }, 201);
});

appRoutes.get("/apps/:app", async (c) => {
  const appId = c.req.param("app");
  const row = await database(c.env.DB).query.apps.findFirst({ where: eq(apps.id, appId) });
  if (!row) throw new GatewayError(404, "app_not_found", "App is not registered");
  let resolved: unknown = null;
  let configError: string | null = null;
  try {
    validateAppConfigJson(row.config);
    resolved = await loadAppConfig(c.env, appId);
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  return c.json({ app: serializeRow(row), resolved, config_error: configError });
});

appRoutes.post("/apps/:app/validate", async (c) => {
  const appId = assertAppId(c.req.param("app"));
  const body = appBody(await c.req.json());
  const existing = await database(c.env.DB).query.apps.findFirst({ where: eq(apps.id, appId) });
  const config = validatedConfig(body.config);
  if (config.authentication.type === "apple_app_attest" && config.authentication.development_access) {
    const credential = await database(c.env.DB).query.developmentCredentials.findFirst({
      columns: { appId: true },
      where: eq(developmentCredentials.appId, appId),
    });
    if (!credential) {
      throw new GatewayError(400, "invalid_request", "Generate a development credential before enabling development access");
    }
  }
  return c.json({ valid: true, app_id: appId, exists: existing !== undefined });
});

appRoutes.on(["PUT", "POST"], "/apps/:app", async (c) => {
  const appId = assertAppId(c.req.param("app"));
  const body = appBody(await c.req.json());
  const db = database(c.env.DB);
  const config = validatedConfig(body.config);
  if (config.authentication.type === "apple_app_attest" && config.authentication.development_access) {
    const credential = await db.query.developmentCredentials.findFirst({
      columns: { appId: true },
      where: eq(developmentCredentials.appId, appId),
    });
    if (!credential) {
      throw new GatewayError(400, "invalid_request", "Generate a development credential before enabling development access");
    }
  }
  const values: typeof apps.$inferInsert = {
    id: appId,
    name: body.name,
    config,
    status: body.status ?? "active",
    updatedAt: new Date().toISOString(),
  };
  await db.insert(apps).values(values).onConflictDoUpdate({
    target: apps.id,
    set: { name: values.name, config: values.config, status: values.status, updatedAt: values.updatedAt },
  });
  if (config.authentication.type !== "apple_app_attest" || !config.authentication.development_access) {
    await db.delete(developmentCredentials).where(eq(developmentCredentials.appId, appId));
  }
  invalidateAppConfig(appId);
  const loaded = await loadAppConfig(c.env, appId);
  return c.json({ app: loaded }, 200);
});

appRoutes.delete("/apps/:app", async (c) => {
  const appId = c.req.param("app");
  if (c.req.query("confirm") !== appId) throw new GatewayError(400, "invalid_request", "Pass ?confirm=<app-id> to delete an app");
  const db = database(c.env.DB);
  const existing = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
  if (!existing) throw new GatewayError(404, "app_not_found", "App is not registered");
  const removedUsers = await db.delete(users).where(eq(users.appId, appId)).returning({ id: users.id });
  await db.delete(authChallenges).where(eq(authChallenges.appId, appId));
  await db.delete(apiKeys).where(eq(apiKeys.appId, appId));
  await db.delete(developmentCredentials).where(eq(developmentCredentials.appId, appId));
  await db.delete(apps).where(eq(apps.id, appId));
  invalidateAppConfig(appId);
  return c.json({ deleted: appId, removed_users: removedUsers.length, usage_events_retained: true });
});
