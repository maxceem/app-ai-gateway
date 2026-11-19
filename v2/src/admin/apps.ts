/**
 * Apps and their keys, through the management API.
 *
 * Saving is strict (`AGENTS.md`): every provider connection, operation and
 * model an app names is checked now, and a model with no price, ours or the
 * customer's, is refused. A mistake caught on save costs nothing.
 */
import type { Context } from "hono";
import { invalidateApp } from "../apps/app-records.ts";
import { generateApiKey } from "../client-auth/api-keys.ts";
import { AppCreateRequestSchema, AppKeyCreateRequestSchema, AppUpdateRequestSchema } from "../contracts/admin.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { AppConfigSchema, type AppConfig } from "../contracts/app-config.ts";
import { GatewayError } from "../core/errors.ts";
import { hasTokenPrice, type CustomerRates } from "../pricing/prices.ts";
import { builtInProvider } from "../providers/index.ts";
import { requireManage, type AdminVariables } from "./actor.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

interface AppRow {
  id: string;
  account_id: string;
  name: string;
  config_json: string;
  revision: number;
  status: "active" | "disabled";
  created_at: number;
  updated_at: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

function appView(row: AppRow) {
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    config: AppConfigSchema.parse(JSON.parse(row.config_json)),
    status: row.status,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function invalid(message: string, data?: Record<string, string>): GatewayError {
  return new GatewayError(400, "invalid_request", message, undefined, data === undefined ? {} : { data });
}

/** Parses a JSON body with a schema, refusing with the first problem. */
export async function parseBody<T>(c: Context, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } } }): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw invalid("The request body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.map(String).join(".")}: `;
  throw invalid(`${where}${issue?.message ?? "The request body is invalid"}`);
}

/**
 * Checks a whole configuration against the account: the shape, then each
 * provider connection it names, each operation, and each listed model's price.
 */
export async function checkAppConfig(db: D1Database, accountId: string, raw: unknown): Promise<AppConfig> {
  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "config" : ["config", ...issue.path.map(String)].join(".");
    throw invalid(`${where}: ${issue?.message ?? "is invalid"}`);
  }
  const config = parsed.data;
  for (const [slug, routing] of Object.entries(config.routing.providers)) {
    const connection = await db
      .prepare("SELECT type, rates_json FROM provider_connection WHERE account_id = ? AND slug = ?")
      .bind(accountId, slug)
      .first<{ type: string; rates_json: string | null }>();
    if (connection === null) {
      throw invalid(`config.routing.providers.${slug}: no provider connection with this slug exists`, { slug });
    }
    const description = builtInProvider(connection.type);
    if (description === null) {
      throw invalid(`config.routing.providers.${slug}: provider type ${connection.type} is not supported`, { slug });
    }
    for (const operation of routing.operations) {
      if (!description.operations.some((declared) => declared.name === operation)) {
        throw invalid(`config.routing.providers.${slug}.operations: ${operation} is not an operation of ${connection.type}`, {
          slug,
          operation,
        });
      }
    }
    const rates = connection.rates_json === null ? null : (JSON.parse(connection.rates_json) as CustomerRates);
    for (const model of routing.models ?? []) {
      if (!hasTokenPrice(connection.type, model, rates)) {
        throw new GatewayError(
          400,
          "pricing_not_configured",
          `config.routing.providers.${slug}.models: ${model} has no price; add one to the provider connection first`,
          undefined,
          { data: { slug, model } },
        );
      }
    }
  }
  return config;
}

/** The app's id: its name made URL-safe, plus a random suffix, as v1. */
function newAppId(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40) || "app";
  const random = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join("");
  return `${base}-${random}`;
}

/** App keys belong to app-key apps only, as v1. */
function requireApiKeyApp(row: AppRow): void {
  const config = JSON.parse(row.config_json) as { authentication?: { type?: unknown } };
  if (config.authentication?.type !== "api_key") {
    throw new GatewayError(400, "invalid_request", "App keys can only be managed for api_key apps");
  }
}

async function appRow(db: D1Database, accountId: string, appId: string): Promise<AppRow> {
  const row = await db.prepare("SELECT * FROM app WHERE id = ? AND account_id = ?").bind(appId, accountId).first<AppRow>();
  if (row === null) throw new GatewayError(404, "app_not_found", "App is not registered");
  return row;
}

export async function listApps(c: AdminContext): Promise<Response> {
  const { results } = await c.env.DB.prepare("SELECT * FROM app WHERE account_id = ? ORDER BY created_at, id")
    .bind(c.get("actor").accountId)
    .all<AppRow>();
  return c.json({ apps: results.map(appView) } satisfies OperationResponse<"listApps">);
}

export async function getApp(c: AdminContext): Promise<Response> {
  const row = await appRow(c.env.DB, c.get("actor").accountId, c.req.param("app")!);
  return c.json({ app: appView(row) } satisfies OperationResponse<"getApp">);
}

async function createKey(db: D1Database, appId: string, name: string, now: number) {
  const generated = await generateApiKey();
  const statement = db
    .prepare("INSERT INTO app_key (id, app_id, name, key_hash, key_prefix, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)")
    .bind(generated.id, appId, name, generated.keyHash, generated.keyPrefix, now);
  return {
    statement,
    created: { id: generated.id, name, key: generated.key, key_prefix: generated.keyPrefix, created_at: iso(now) },
  };
}

export async function createApp(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const body = await parseBody(c, AppCreateRequestSchema);
  const config = await checkAppConfig(c.env.DB, actor.accountId, body.config);
  const now = Date.now();
  const id = newAppId(body.name);
  const insert = c.env.DB.prepare(
    "INSERT INTO app (id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
  ).bind(id, actor.accountId, body.name, JSON.stringify(config), body.status ?? "active", now, now);
  // An app-key app gets its first key, shown once, as v1.
  const key = config.authentication.type === "api_key" ? await createKey(c.env.DB, id, "Initial key", now) : null;
  await c.env.DB.batch(key === null ? [insert] : [insert, key.statement]);
  const row = await appRow(c.env.DB, actor.accountId, id);
  return c.json({ app: appView(row), api_key: key?.created ?? null } satisfies OperationResponse<"createApp">, 201);
}

export async function updateApp(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const appId = c.req.param("app")!;
  const body = await parseBody(c, AppUpdateRequestSchema);
  if (body.revision === undefined) {
    throw new GatewayError(400, "app_revision_required", "Send the revision the app was read at");
  }
  await appRow(c.env.DB, actor.accountId, appId);
  const config = await checkAppConfig(c.env.DB, actor.accountId, body.config);
  const result = await c.env.DB.prepare(
    `UPDATE app SET name = ?, config_json = ?, status = COALESCE(?, status), revision = revision + 1, updated_at = ?
     WHERE id = ? AND account_id = ? AND revision = ?`,
  )
    .bind(body.name, JSON.stringify(config), body.status ?? null, Date.now(), appId, actor.accountId, body.revision)
    .run();
  if (result.meta.changes === 0) {
    throw new GatewayError(409, "app_revision_conflict", "The app changed since it was read; read it again and retry");
  }
  invalidateApp(appId);
  const row = await appRow(c.env.DB, actor.accountId, appId);
  return c.json({ app: appView(row) } satisfies OperationResponse<"updateApp">);
}

export async function deleteApp(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const appId = c.req.param("app")!;
  if (c.req.query("confirm") !== appId) {
    throw invalid("Pass ?confirm=<app-id> to delete an app");
  }
  await appRow(c.env.DB, actor.accountId, appId);
  // The ledger keeps its history; everything that lets the app sign in goes.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM app_key WHERE app_id = ?").bind(appId),
    c.env.DB.prepare("DELETE FROM app_attest_key WHERE app_id = ?").bind(appId),
    c.env.DB.prepare("DELETE FROM app_auth_challenge WHERE app_id = ?").bind(appId),
    c.env.DB.prepare("DELETE FROM app_end_user WHERE app_id = ?").bind(appId),
    c.env.DB.prepare("DELETE FROM app WHERE id = ? AND account_id = ?").bind(appId, actor.accountId),
  ]);
  invalidateApp(appId);
  return c.json({ deleted: true, app_id: appId } satisfies OperationResponse<"deleteApp">);
}

interface KeyRow {
  id: string;
  name: string;
  key_prefix: string;
  status: "active" | "revoked";
  created_at: number;
  last_used_at: number | null;
}

const keyView = (row: KeyRow) => ({
  id: row.id,
  name: row.name,
  key_prefix: row.key_prefix,
  status: row.status,
  created_at: iso(row.created_at),
  last_used_at: row.last_used_at === null ? null : iso(row.last_used_at),
});

export async function listAppKeys(c: AdminContext): Promise<Response> {
  const appId = c.req.param("app")!;
  requireApiKeyApp(await appRow(c.env.DB, c.get("actor").accountId, appId));
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, key_prefix, status, created_at, last_used_at FROM app_key WHERE app_id = ? ORDER BY created_at, id",
  )
    .bind(appId)
    .all<KeyRow>();
  return c.json({ app_id: appId, keys: results.map(keyView) } satisfies OperationResponse<"listAppKeys">);
}

export async function createAppKey(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const appId = c.req.param("app")!;
  const body = await parseBody(c, AppKeyCreateRequestSchema);
  requireApiKeyApp(await appRow(c.env.DB, actor.accountId, appId));
  const key = await createKey(c.env.DB, appId, body.name, Date.now());
  await key.statement.run();
  return c.json(key.created satisfies OperationResponse<"createAppKey">, 201);
}

export async function revokeAppKey(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const appId = c.req.param("app")!;
  const keyId = c.req.param("key")!;
  requireApiKeyApp(await appRow(c.env.DB, actor.accountId, appId));
  await c.env.DB.prepare("UPDATE app_key SET status = 'revoked' WHERE id = ? AND app_id = ?").bind(keyId, appId).run();
  const row = await c.env.DB.prepare(
    "SELECT id, name, key_prefix, status, created_at, last_used_at FROM app_key WHERE id = ? AND app_id = ?",
  )
    .bind(keyId, appId)
    .first<KeyRow>();
  if (row === null) throw new GatewayError(404, "key_not_found", "App key not found");
  return c.json({ app_id: appId, key: keyView(row) } satisfies OperationResponse<"revokeAppKey">);
}
