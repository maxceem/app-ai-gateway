import { Hono, type Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { getBillingAccess, requireActiveBilling } from "../../billing/gateway";
import {
  hasAppLevelLimits,
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
import { insertApp, updateApp, type StoredAppRow } from "../../core/app-writes";
import { database } from "../../db";
import {
  appApiKey,
  app,
  appAuthChallenge,
  appUsageEvent,
  appUser,
} from "../../db/schema";
import type { AdminVariables } from "../../middleware/admin";
import { APP_ID_IS_SERVER_ASSIGNED, AppWriteSchema } from "../../contracts/schemas";
import { assertMonth, currentMonth, organizationMonthUsage } from "./shared";

const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const APP_ID_MAX_LENGTH = 63;
const APP_ID_SUFFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
/**
 * Every id carries one, so the readable stem is never the whole identifier.
 * Six characters is 36^6 — enough that a deployment can hold every app any
 * organization will ever create without a retry, and enough that the
 * unauthenticated `/v1/apps/{app}/auth/challenge` route cannot be found by
 * guessing an app's name. It also keeps every assigned id clear of the segments
 * the console and the gateway use themselves (`admin`, `new`, `v1`, …): none of
 * them ends in `-<six characters>`.
 */
const APP_ID_SUFFIX_LENGTH = 6;

interface AppWriteBody {
  name: string;
  config: Record<string, unknown>;
  status?: "active" | "disabled";
}

function appBody(value: unknown): AppWriteBody {
  const parsed = AppWriteSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // The one rejection a client is likely to hit while catching up with the
    // contract, and "unrecognized key" would not tell it what to do instead.
    if (issue?.code === "unrecognized_keys" && issue.keys.includes("id")) {
      throw new GatewayError(400, "invalid_request", APP_ID_IS_SERVER_ASSIGNED);
    }
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
  const bytes = crypto.getRandomValues(new Uint8Array(APP_ID_SUFFIX_LENGTH));
  return Array.from(bytes, (byte) => APP_ID_SUFFIX_ALPHABET[byte % APP_ID_SUFFIX_ALPHABET.length]).join("");
}

/**
 * The id of a new app, derived here and nowhere else: a client sends a name and
 * is answered with the id, which it can neither choose nor change afterwards.
 *
 * Suffixed unconditionally, for the first app of the first organization as much
 * as for the thousandth: an id is claimed against the whole deployment, and a
 * bare stem would mean whoever arrived first owns `chat` and everyone after is
 * quietly given something else. One rule for everybody is the fair form of
 * that, and it leaves nothing for a caller to negotiate over.
 */
function generatedAppId(name: string): string {
  const suffix = randomAppIdSuffix();
  const stem = slugifyAppName(name)
    .slice(0, APP_ID_MAX_LENGTH - suffix.length - 1)
    .replace(/-+$/u, "");
  return `${stem}-${suffix}`;
}

function asBadRequest(error: unknown): never {
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
  providers: OrganizationProviders,
  grandfathered?: ReadonlySet<string>,
): ReturnType<typeof validateAppConfigJson> {
  try {
    return validateAppConfigJson(next, providers, grandfathered);
  } catch (error) {
    asBadRequest(error);
  }
}

function summary(
  config: ReturnType<typeof validateAppConfigJson>,
  providerIndex: OrganizationProviders,
) {
  // Disabled instances are excluded from the all-mode expansion: the summary
  // says what the app can reach, and a paused slug is not reachable.
  const providerSlugs = config.routing.providers.mode === "all"
    ? Object.keys(providerIndex).filter((slug) => providerIndex[slug]?.status === "active")
    : Object.keys(config.routing.providers.selected ?? {});
  const models = new Set<string>();
  for (const provider of Object.values(config.routing.providers.selected ?? {})) {
    for (const model of provider?.allowed_models ?? []) models.add(model);
  }
  // The slugs this configuration names outright — selected policies and
  // endpoint targets — as opposed to `providers`, which an all-mode app expands
  // to everything. This is what "which apps use this provider?" means when a
  // delete or disable is about to be confirmed.
  const referenced = new Set<string>(Object.keys(config.routing.providers.selected ?? {}));
  for (const endpoint of Object.values(config.endpoints ?? {})) {
    referenced.add(endpoint.provider);
    for (const fallback of endpoint.fallback ?? []) referenced.add(fallback.provider);
  }
  return {
    authentication_type: config.authentication.type,
    apple_bundle_id: config.authentication.type === "apple_app_attest"
      ? config.authentication.app_attest.bundle_id
      : null,
    providers: providerSlugs,
    referenced_providers: [...referenced],
    allowed_model_count: models.size,
    // What the whole app may spend this month, so the list can show the
    // month's cost against it. `null` is unlimited, as everywhere in limits.
    monthly_budget_usd: config.limits?.per_app.spending.monthly_usd ?? null,
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

/**
 * Refuses the write unless the organization may currently use the product. The
 * plan carries no configuration ceilings: its only limit is the gateway-wide
 * monthly request allowance, which is spent on the data plane, never here.
 */
async function requireEntitlement(c: Context<AppRouteEnv>): Promise<void> {
  requireActiveBilling(await getBillingAccess(
    c.env,
    c.get("admin").organizationId,
    c.get("billingRequestCache"),
  ));
}

appRoutes.get("/apps", async (c) => {
  const month = c.req.query("month") ?? currentMonth();
  assertMonth(month);
  const db = database(c.env.DB);
  const organizationId = c.get("admin").organizationId;
  const providerIndex = await organizationProviders(c.env, organizationId);
  const rows = await db
    .select()
    .from(app)
    .where(eq(app.organizationId, organizationId))
    .orderBy(app.id);
  const { results: usage } = await organizationMonthUsage(c.env.DB, organizationId, month);
  const usageByApp = new Map(usage.map((row) => [row.app_id, row]));
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
          -- Userless traffic belongs to no user, so it synthesizes none. Every
          -- such row carries a NULL that would otherwise group into one
          -- phantom identity and be counted here.
          AND events.user_id IS NOT NULL
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

  /*
   * Whether this organization has ever had a request recorded, at any time.
   *
   * Deliberately not derived from the usage totals above: those are scoped to
   * the selected month, so an organization that proxied in March and nothing in
   * April would read as having never sent one. Callers use this to decide
   * whether an organization is still being set up, and that answer must not
   * come back on the first of the month.
   *
   * Retention moves old events into rollups. Check both in one statement so
   * compaction cannot make an established organization look new again.
   */
  const proxied = rows.length === 0 ? null : await c.env.DB.prepare(`
    SELECT 1 AS found FROM app_usage_event
    INNER JOIN app ON app.id = app_usage_event.app_id
    WHERE app.organization_id = ?
    UNION ALL
    SELECT 1 AS found FROM app_usage_rollup
    INNER JOIN app ON app.id = app_usage_rollup.app_id
    WHERE app.organization_id = ?
    LIMIT 1
  `).bind(organizationId, organizationId).first();

  return c.json({
    month,
    has_proxied_requests: proxied !== null,
    apps: rows.map((row) => {
      const totals = usageByApp.get(row.id);
      const userCounts = countsByApp.get(row.id);
      let configSummary: ReturnType<typeof summary> | {
        authentication_type: "invalid";
        apple_bundle_id: null;
        providers: string[];
        referenced_providers: string[];
        allowed_model_count: number;
        monthly_budget_usd: null;
      };
      try {
        configSummary = summary(parseStoredAppConfig(row.config, null).stored, providerIndex);
      } catch {
        configSummary = {
          authentication_type: "invalid",
          apple_bundle_id: null,
          providers: [],
          referenced_providers: [],
          allowed_model_count: 0,
          monthly_budget_usd: null,
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
  await requireEntitlement(c);
  const value = await c.req.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
  const body = appBody(value);
  const name = body.name.trim();
  if (name.length === 0 || name.length > 100) throw new GatewayError(400, "invalid_request", "name must be 1-100 characters");
  const organizationId = c.get("admin").organizationId;
  const config = validatedConfig(
    body.config,
    await organizationProviders(c.env, organizationId),
  );
  const db = database(c.env.DB);
  // The id is the gateway's to assign, so a collision is nobody's problem but
  // its own: re-roll the suffix and insert again.
  let created: StoredAppRow | null = null;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    created = await insertApp(c.env.DB, {
      id: generatedAppId(name),
      organizationId,
      name,
      config,
      status: body.status ?? "active",
    });
    if (created) break;
  }
  if (!created) throw new GatewayError(409, "invalid_request", "Could not allocate a unique app id");
  const appId = created.id;

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
  // The same body every other application route answers with, so a client reads
  // one shape whether it just created the app or fetched it. `config_error` is
  // null by construction here: the configuration was validated a moment ago.
  return c.json({
    app: serializeRow(created),
    resolved: await loadAppConfig(c.env, appId),
    config_error: null,
    api_key: createdKey,
  }, 201);
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
  await requireEntitlement(c);
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
    await organizationProviders(c.env, c.get("admin").organizationId),
    existing ? referencedProviderSlugs(existing.config) : undefined,
  );
  return c.json({ valid: true, app_id: appId, exists: existing !== undefined });
});

/**
 * Seeds the app-wide spend ledger the first time an app grows app-wide limits.
 *
 * Every request settles its cost against the per-user ledger, but against the
 * app-wide one only while the app has app-level limits — that is what keeps an
 * app without them from paying for a second Durable Object round trip on every
 * request. The cost is that the app-wide ledger is empty until the day someone
 * turns those limits on, so a budget set mid-month would start from zero while
 * a per-user budget set the same day already counts the whole month.
 *
 * Two identical-looking fields meaning different months is the kind of thing
 * nobody discovers until a budget fails to bite, so the transition backfills
 * from the usage rows, which are the source of truth either way.
 */
async function backfillAppLedger(
  env: Env,
  appId: string,
  previousConfig: unknown,
  next: Awaited<ReturnType<typeof loadAppConfig>>,
): Promise<void> {
  if (!hasAppLevelLimits(next)) return;
  // Only the transition. An app that already had them has been settling all
  // along, and re-summing would be a needless read on every unrelated edit.
  const before = parseStoredAppConfig(previousConfig, null).resolved.limits;
  if (hasAppLevelLimits({ ...next, limits: before })) return;
  const month = new Date().toISOString().slice(0, 7);
  const [total] = await database(env.DB)
    .select({
      microusd: sql<number>`CAST(COALESCE(SUM(ROUND(${appUsageEvent.costUsd} * 1000000)), 0) AS INTEGER)`,
    })
    .from(appUsageEvent)
    .where(and(
      eq(appUsageEvent.appId, appId),
      eq(sql`substr(${appUsageEvent.createdAt}, 1, 7)`, month),
    ));
  await env.USER_LIMITER.getByName(appId).reconcileMonth(month, total?.microusd ?? 0);
}

appRoutes.on(["PUT", "POST"], "/apps/:app", async (c) => {
  await requireEntitlement(c);
  const appId = assertAppId(c.req.param("app"));
  const body = appBody(await c.req.json());
  const db = database(c.env.DB);
  const organizationId = c.get("admin").organizationId;
  // Update only. Applications are created through `POST /v1/admin/apps`, which
  // is the sole place an id is minted; a path id nobody has ever been given is
  // simply an app that does not exist, whoever asked for it.
  const existing = await db.query.app.findFirst({
    columns: { config: true },
    where: and(eq(app.id, appId), eq(app.organizationId, organizationId)),
  });
  if (!existing) throw new GatewayError(404, "app_not_found", "App is not registered");
  // The slugs the stored row already names stay writable even if their provider
  // rows were deleted in the meantime.
  const config = validatedConfig(
    body.config,
    await organizationProviders(c.env, organizationId),
    referencedProviderSlugs(existing.config),
  );
  const values = {
    id: appId,
    organizationId,
    name: body.name,
    config,
    status: body.status ?? "active",
    updatedAt: new Date().toISOString(),
  };
  // Conditional on the row still being this organization's, so an app deleted
  // or handed over between the read above and this write is not resurrected
  // under the caller's name.
  const written = await updateApp(c.env.DB, values);
  if (!written) throw new GatewayError(404, "app_not_found", "App is not registered");
  invalidateAppConfig(appId);
  const resolved = await loadAppConfig(c.env, appId);
  await backfillAppLedger(c.env, appId, existing.config, resolved);
  return c.json({ app: serializeRow(written), resolved, config_error: null }, 200);
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
  return c.json({
    deleted: true,
    app_id: appId,
    removed_users: removedUsers.length,
    usage_events_retained: true,
  });
});
