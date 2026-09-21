import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { getBillingAccess, requireActiveBilling } from "../../billing/gateway";
import { invalidateAppConfig, referencedProviderSlugs } from "../../core/config";
import { validateConfigurationReferences } from "../../core/config-references";
import {
  ConfigError,
  configErrorFor,
  parseAppConfig,
  selectedProviderPolicies,
  type AppConfig,
} from "../../shared/app-config";
import { generateApiKey } from "../../core/apikeys";
import { GatewayError } from "../../core/errors";
import {
  authoritativeOrganizationProviders,
  type OrganizationProviders,
} from "../../core/provider-store";
import { appInsertStatement, updateApp } from "../../core/app-writes";
import { andCondition, planCap } from "../../core/plan-caps";
import { databaseErrorMatches } from "../../management/validation";
import { prepareResourceReceipt } from "./resource-receipt";
import { database } from "../../db";
import {
  appApiKey,
  app,
  appAuthChallenge,
  appAuthEvent,
  appUser,
} from "../../db/schema";
import type { AdminVariables } from "../../middleware/admin";
import { AppUpdateSchema, AppWriteSchema } from "../../contracts/schemas";
import type {
  AppDeleteResponse,
  AppListResponse,
  AppResponse,
  AppValidateResponse,
} from "../../contracts/responses";
import { assertMonth, currentMonth, organizationMonthUsage } from "./shared";

const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const APP_ID_MAX_LENGTH = 63;
/**
 * Crockford's base32: the digits and letters that survive being read aloud or
 * copied by hand, without `i`, `l`, `o` or `u`. Thirty-two divides 256, so
 * {@link randomAppIdSuffix} can fold a random byte into a character without the
 * modulo bias a 36-character alphabet would give its first four letters.
 */
const APP_ID_SUFFIX_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/**
 * Every id carries one, so the readable stem is never the whole identifier.
 *
 * Twelve characters is 32^12, about 10^18. The size is deliberate rather than
 * merely sufficient: an app id outlives the app. Usage and authentication
 * history are keyed by it and survive deletion on purpose, so an id that came
 * round a second time would show one organization the history of another's
 * deleted app. At this width that cannot happen — reproducing a specific
 * retired id is a one-in-10^18 event, and ids are assigned here and never
 * chosen by a caller, so there is nothing to aim at either.
 *
 * It also keeps every assigned id clear of the segments the console and the
 * gateway use themselves (`admin`, `new`, `v1`, …): none of them ends in
 * `-<twelve characters>`. And it leaves the unauthenticated
 * `/v1/apps/{app}/auth/challenge` route unreachable by guessing an app's name.
 */
const APP_ID_SUFFIX_LENGTH = 12;

interface AppWriteBody {
  name: string;
  config: AppConfig;
  status?: "active" | "disabled";
}

/**
 * An update body, whose `revision` is the one the caller read.
 *
 * Required rather than optional: a client that cannot name the revision it is
 * editing has not read the application, and letting it through would make a
 * blind overwrite the easiest thing to write.
 */
/**
 * An update body: a write, plus the revision it is made against.
 *
 * The revision is only shape-checked here. Whether one is *present* is settled
 * by the route after it has looked the application up, so that an id nobody
 * holds still answers `404` rather than being told what a well-formed body
 * would have looked like.
 */
function appUpdateBody(value: unknown): AppWriteBody & { revision: number | undefined } {
  const { revision, ...write } = (value ?? {}) as { revision?: unknown } & Record<string, unknown>;
  if (revision !== undefined && AppUpdateSchema.shape.revision.safeParse(revision).error) {
    throw new GatewayError(400, "app_revision_required", APP_REVISION_REQUIRED);
  }
  // The rest is reported exactly as it is on create, by the one parser that
  // knows how to name the field at fault — `revision` is lifted out first
  // because the write body admits no key it does not define.
  return { ...appBody(write), revision: revision as number | undefined };
}

const APP_REVISION_REQUIRED =
  "Send the revision the application was read at as revision";

function appBody(value: unknown): AppWriteBody {
  const parsed = AppWriteSchema.safeParse(value);
  // One formatter, shared with the console and the CLI, so a body rejected here
  // reads the same wherever it was composed.
  if (!parsed.success) throw new GatewayError(400, "invalid_request", configErrorFor(parsed.error).message);
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

/**
 * Writes are validated against the global price catalog merged with this
 * organization's own overrides, so a model the operator has priced under
 * Providers is configurable here too. `grandfathered` carries the slugs the
 * app's stored configuration already names, which an update may keep even if
 * the instance behind one has since been deleted; creates pass nothing.
 */
const NO_GRANDFATHERED_SLUGS: ReadonlySet<string> = new Set();

function validatedConfig(
  next: AppConfig,
  providers: OrganizationProviders,
  grandfathered: ReadonlySet<string> = NO_GRANDFATHERED_SLUGS,
): AppConfig {
  try {
    validateConfigurationReferences(next, { instances: providers, grandfathered });
    return next;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new GatewayError(400, "invalid_request", error.message);
    }
    throw error;
  }
}

function summary(config: AppConfig, providerIndex: OrganizationProviders) {
  // Disabled instances are excluded from the all-mode expansion: the summary
  // says what the app can reach, and a paused slug is not reachable.
  const selected = selectedProviderPolicies(config.routing);
  const providerSlugs = config.routing.providers.mode === "all"
    ? Object.keys(providerIndex).filter((slug) => providerIndex[slug]?.status === "active")
    : Object.keys(selected);
  const models = new Set<string>();
  for (const provider of Object.values(selected)) {
    for (const model of provider.allowed_models) models.add(model);
  }
  // The slugs this configuration names outright — selected policies and
  // endpoint targets — as opposed to `providers`, which an all-mode app expands
  // to everything. This is what "which apps use this provider?" means when a
  // delete or disable is about to be confirmed.
  const referenced = new Set<string>(Object.keys(selected));
  for (const endpoint of Object.values(config.endpoints)) {
    referenced.add(endpoint.provider);
    for (const fallback of endpoint.fallback ?? []) referenced.add(fallback.provider);
  }
  return {
    apple_bundle_id: config.authentication.type === "apple_app_attest"
      ? config.authentication.app_attest.bundle_id
      : null,
    providers: providerSlugs,
    referenced_providers: [...referenced],
    allowed_model_count: models.size,
    // What the whole app may spend this month, so the list can show the
    // month's cost against it. `null` is unlimited, as everywhere in limits.
    monthly_budget_usd: config.limits.per_app.spending.monthly_usd,
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
    revision: row.revision,
  };
}

type AppRouteEnv = { Bindings: Env; Variables: AdminVariables };

export const appRoutes = new Hono<AppRouteEnv>();

/**
 * Refuses the write unless the organization may currently use the product.
 *
 * Entitlement only — whether the plan grants access at all. A ceiling on how
 * much configuration the plan allows is a separate question, asked by the
 * statement that would store the row; see `src/core/plan-caps.ts`.
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
  const providerIndex = await authoritativeOrganizationProviders(c.env, organizationId);
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

  const listed = {
    month,
    has_proxied_requests: proxied !== null,
    apps: rows.map((row) => {
      const totals = usageByApp.get(row.id);
      const userCounts = countsByApp.get(row.id);
      let configSummary: ReturnType<typeof summary> | {
        apple_bundle_id: null;
        providers: string[];
        referenced_providers: string[];
        allowed_model_count: number;
        monthly_budget_usd: null;
      };
      try {
        configSummary = summary(parseAppConfig(row.config), providerIndex);
      } catch {
        configSummary = {
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
        // Off the column, so a row whose configuration no longer parses still
        // says what kind of application it is rather than "invalid".
        authentication_type: row.authType === "apple_app_attest" || row.authType === "api_key"
          ? row.authType
          : "invalid" as const,
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
  } satisfies AppListResponse;
  return c.json(listed);
});

appRoutes.post("/apps", async (c) => {
  await requireEntitlement(c);
  const value = await c.req.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
  const body = appBody(value);
  const receipt = await prepareResourceReceipt(c, "app.add", body);
  if (receipt?.result) return c.json(receipt.result, 201);
  const name = body.name.trim();
  if (name.length === 0 || name.length > 100) throw new GatewayError(400, "invalid_request", "name must be 1-100 characters");
  const organizationId = c.get("admin").organizationId;
  const config = validatedConfig(
    body.config,
    await authoritativeOrganizationProviders(c.env, organizationId),
  );
  const cap = await planCap(c.env, "app", organizationId, c.get("billingRequestCache"));
  for (let attempt = 0; attempt < 16; attempt += 1) {
  const appId = generatedAppId(name);
  const now = new Date().toISOString();
  const status = body.status ?? "active";
  const generated = config.authentication.type === "api_key" ? await generateApiKey() : null;
  const createdKey = generated ? {
    id: generated.id, name: "Default key", key: generated.key,
    key_prefix: generated.keyPrefix, created_at: now,
  } : null;
  const outcome = {
    app: { id: appId, name, config, status, revision: 1, created_at: now, updated_at: now },
    config_error: null,
    api_key: createdKey,
  };
  const condition = receipt?.condition ?? { sql: "1", params: [] };
  // The app cap guards the app row alone. The default key rides along with the
  // app it belongs to, and by the time its statement runs the app is already
  // counted, so sharing the guard would refuse the key of the very app that
  // just filled the plan's last slot. Keys added later are capped in keys.ts.
  const statements = [appInsertStatement(c.env.DB, { id: appId, organizationId, name, config,
    status, createdAt: now, updatedAt: now }, andCondition(condition, cap.condition))];
  if (generated) {
    statements.push(c.env.DB.prepare(
      `INSERT INTO app_api_key(id,app_id,name,key_hash,key_prefix,status,created_at)
       SELECT ?,?,'Default key',?,?,'active',? WHERE ${condition.sql}
       AND EXISTS (SELECT 1 FROM app WHERE id = ? AND organization_id = ?)`,
    ).bind(generated.id, appId, generated.keyHash, generated.keyPrefix, now,
      ...condition.params, appId, organizationId));
  }
  // The application, default key and retry receipt are all committed together.
  // A response lost after this batch can redeliver the original ID and key.
  try {
    if (receipt) await receipt.commit(statements, outcome);
    else {
      const written = await c.env.DB.batch<unknown>(statements);
      // The insert returns the row it stored, so an empty result is the guard
      // refusing rather than a write that happened.
      if (written[0]!.results.length === 0) {
        throw new GatewayError(409, "conflict", "The application could not be created; retry the same request");
      }
    }
  } catch (error) {
    if (receipt && await receipt.read()) return c.json(receipt.result!, 201);
    if (databaseErrorMatches(error, /UNIQUE constraint failed: app\.id/u)) continue;
    // Both guards refuse by matching no rows, so the failure above says nothing
    // about which one did. Counting again, on this path alone, separates a
    // reached plan ceiling from the concurrent write it otherwise looks like.
    await cap.assertNotReached();
    throw error;
  }
  invalidateAppConfig(appId);
  return c.json(receipt?.result ?? outcome, 201);
  }
  throw new GatewayError(409, "conflict", "Could not allocate a unique app ID; retry the same request");
});

appRoutes.get("/apps/:app", async (c) => {
  const row = c.get("adminApp");
  if (!row) throw new GatewayError(404, "app_not_found", "App is not registered");
  // A row is answered exactly as it is stored, parseable or not: `config_error`
  // is what tells the console to open the repair editor over the raw JSON.
  let configError: string | null = null;
  try {
    parseAppConfig(row.config);
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  return c.json({ app: serializeRow(row), config_error: configError } satisfies AppResponse);
});

appRoutes.post("/apps/:app/validate", async (c) => {
  await requireEntitlement(c);
  const appId = assertAppId(c.req.param("app"));
  const body = appBody(await c.req.json());
  const existing = c.get("adminApp");
  validatedConfig(
    body.config,
    await authoritativeOrganizationProviders(c.env, c.get("admin").organizationId),
    existing ? referencedProviderSlugs(existing.config) : undefined,
  );
  return c.json({ valid: true, app_id: appId, exists: existing !== undefined } satisfies AppValidateResponse);
});

appRoutes.put("/apps/:app", async (c) => {
  await requireEntitlement(c);
  const appId = assertAppId(c.req.param("app"));
  const body = appUpdateBody(await c.req.json());
  const organizationId = c.get("admin").organizationId;
  // Update only. Applications are created through `POST /v1/admin/apps`, which
  // is the sole place an id is minted; a path id nobody has ever been given is
  // simply an app that does not exist, whoever asked for it.
  const existing = c.get("adminApp");
  if (!existing) throw new GatewayError(404, "app_not_found", "App is not registered");
  if (body.revision === undefined) {
    throw new GatewayError(400, "app_revision_required", APP_REVISION_REQUIRED);
  }
  if (body.revision !== existing.revision) {
    throw new GatewayError(409, "app_revision_conflict", "The application changed; reload it before saving your changes");
  }
  // The slugs the stored row already names stay writable even if their provider
  // rows were deleted in the meantime.
  const config = validatedConfig(
    body.config,
    await authoritativeOrganizationProviders(c.env, organizationId),
    referencedProviderSlugs(existing.config),
  );
  const values = {
    id: appId,
    organizationId,
    name: body.name,
    config,
    status: body.status ?? "active",
    updatedAt: new Date().toISOString(),
    expectedRevision: existing.revision,
  };
  // Conditional on the row still being this organization's, so an app deleted
  // or handed over between the read above and this write is not resurrected
  // under the caller's name.
  const written = await updateApp(c.env.DB, values);
  if (!written) throw new GatewayError(409, "app_revision_conflict", "The application changed or was removed; reload it before saving your changes");
  invalidateAppConfig(appId);
  return c.json(
    { app: serializeRow(written), config_error: null } satisfies AppResponse,
    200,
  );
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
  // Authentication history is diagnostic and reachable only under `/apps/:app`,
  // so it dies with the app it describes. Usage below is the exception: it is
  // billing history, and it is deliberately kept.
  await db.delete(appAuthEvent).where(eq(appAuthEvent.appId, appId));
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
  } satisfies AppDeleteResponse);
});
