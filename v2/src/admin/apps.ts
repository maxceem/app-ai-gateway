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
import {
  AppCreateRequestSchema,
  AppKeyCreateRequestSchema,
  AppPatchRequestSchema,
  AppUpdateRequestSchema,
  AppValidateRequestSchema,
} from "../contracts/admin.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { AppConfigSchema, providerKeyHeaderProblem, type AppConfig } from "../contracts/app-config.ts";
import { GatewayError } from "../core/errors.ts";
import type { Preset } from "../contracts/app-config.ts";
import { billing, listedModelProblem, priceSources, rewriteTargetBillable } from "../pricing/billability.ts";
import { BUILT_IN_PROVIDERS, builtInProvider } from "../providers/index.ts";
import { attemptCopy, declaredOperation, presetOperation, presetOperationProblem } from "../providers/presets.ts";
import { requestedServiceMode } from "../proxy/meter.ts";
import { applyOutputCap, refuseBackground } from "../proxy/policy.ts";
import { serviceModeName } from "../usage/service-modes.ts";
import { requireManage, type AdminVariables } from "./actor.ts";
import { applyAppPatch } from "./app-patch.ts";
import { planCap, planCeiling } from "./plan-caps.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

export interface AppRow {
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

export function appView(row: AppRow) {
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
 * An app document's config as it is saved, read by its schema and the
 * save-only rules, without the account's current state.
 */
export function parseAppConfig(raw: unknown): AppConfig {
  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "config" : ["config", ...issue.path.map(String)].join(".");
    throw invalid(`${where}: ${issue?.message ?? "is invalid"}`);
  }
  const header = providerKeyHeaderProblem(parsed.data);
  if (header !== null) throw invalid(`config.${header}`);
  // A field is written only when it differs from its default (`AGENTS.md`).
  const config = parsed.data;
  if (config.routing.model_rewrites !== undefined && Object.keys(config.routing.model_rewrites).length === 0) {
    delete config.routing.model_rewrites;
  }
  if (config.presets !== undefined && Object.keys(config.presets).length === 0) delete config.presets;
  return config;
}

/** An app's stored routing entries and presets, by slug, read loosely: they were valid when saved. */
export interface StoredEntries {
  readonly providers: Readonly<Record<string, unknown>>;
  readonly presets: Readonly<Record<string, unknown>>;
  readonly rewrites: Readonly<Record<string, unknown>>;
}

const NOTHING_STORED: StoredEntries = { providers: {}, presets: {}, rewrites: {} };

interface ConnectionRow {
  type: string;
  rates_json: string | null;
  base_url: string | null;
}

/**
 * What a save changes against the stored app. Saving judges only what is new
 * or changed: what is stored was judged when it was saved, and something gone
 * since (a connection deleted, a price removed) must not stop the app being
 * saved, even to rename it. Its requests are judged when they are made.
 * Creating an app judges everything.
 */
export interface Changes {
  readonly routing: (slug: string) => boolean;
  readonly rewrite: (source: string) => boolean;
  readonly preset: (slug: string) => boolean;
}

export function changesAgainst(stored: StoredEntries, config: AppConfig): Changes {
  // Present on one side only is a change, decided before anything is compared.
  const differs = (before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>, key: string) => {
    const was = Object.hasOwn(before, key);
    const is = Object.hasOwn(after, key);
    return was !== is || (was && !sameJson(before[key], after[key]));
  };
  const rewrites = config.routing.model_rewrites ?? {};
  // Each answer is worked out once: a route with thousands of models is
  // compared once, not once per model.
  const once = (compare: (key: string) => boolean) => {
    const answers = new Map<string, boolean>();
    return (key: string) => {
      if (!answers.has(key)) answers.set(key, compare(key));
      return answers.get(key)!;
    };
  };
  return {
    routing: once((slug) => differs(stored.providers, config.routing.providers, slug)),
    rewrite: once((source) => differs(stored.rewrites, rewrites, source)),
    preset: once((slug) => differs(stored.presets, config.presets ?? {}, slug)),
  };
}

/**
 * Checks a configuration against the account: the shape, then each provider
 * connection it names, each operation, and whether each listed model can be
 * billed (`../pricing/billability.ts` decides). Only what is new or changed
 * against `stored` is judged (`changesAgainst`).
 */
export async function checkAppConfig(
  db: D1Database,
  accountId: string,
  raw: unknown,
  stored: StoredEntries = NOTHING_STORED,
): Promise<AppConfig> {
  const config = parseAppConfig(raw);
  const changed = changesAgainst(stored, config);
  const rows = new Map<string, ConnectionRow | null>();
  const connectionRow = async (slug: string): Promise<ConnectionRow | null> => {
    if (!rows.has(slug)) {
      rows.set(
        slug,
        await db
          .prepare("SELECT type, rates_json, base_url FROM provider_connection WHERE account_id = ? AND slug = ?")
          .bind(accountId, slug)
          .first<ConnectionRow>(),
      );
    }
    return rows.get(slug) ?? null;
  };
  const rewrites = config.routing.model_rewrites ?? {};
  await checkRewrites(
    db,
    accountId,
    Object.entries(rewrites).filter(([source]) => changed.rewrite(source)),
  );
  for (const [slug, routing] of Object.entries(config.routing.providers)) {
    const connection = await connectionRow(slug);
    if (connection === null) {
      // Unchanged, an entry may keep a connection deleted since, as v1. Its
      // requests are refused with `provider_not_configured` until it is back.
      if (!changed.routing(slug)) continue;
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
    // Rates are read only if a listed model is judged, so an unchanged route
    // whose connection has unreadable rates does not stop a rename.
    const sources = priceSources(connection);
    const enabled = description.operations.filter((declared) => routing.operations.includes(declared.name));
    const routeChanged = changed.routing(slug);
    for (const listed of routing.models ?? []) {
      // A listed model is judged when its route or its rewrite is new or changed.
      if (!routeChanged && !changed.rewrite(listed)) continue;
      // A listed model is sent, and priced, as the model it is rewritten to.
      const model = Object.hasOwn(rewrites, listed) ? rewrites[listed]! : listed;
      const problem = listedModelProblem(enabled, sources, model);
      if (problem !== null) {
        throw new GatewayError(
          400,
          "pricing_not_configured",
          `config.routing.providers.${slug}.models: ${listed}${model === listed ? "" : ` (rewritten to ${model})`} has no price that ${
            problem.operation ?? `any of ${enabled.map((operation) => operation.name).join(", ")}`
          } can bill; add one to the provider connection first`,
          undefined,
          { data: { slug, model, ...(problem.operation !== undefined ? { operation: problem.operation } : {}) } },
        );
      }
    }
  }
  for (const [slug, preset] of Object.entries(config.presets ?? {})) {
    // Unchanged, it may keep a connection deleted since, as routing does.
    if (!changed.preset(slug)) continue;
    await checkPreset(slug, preset, connectionRow);
  }
  return config;
}

/** Each new or changed rewrite's target needs a price this account could bill it at (`rewriteTargetBillable`). */
async function checkRewrites(db: D1Database, accountId: string, targets: readonly (readonly [string, string])[]): Promise<void> {
  if (targets.length === 0) return;
  const { results } = await db
    .prepare("SELECT type, rates_json FROM provider_connection WHERE account_id = ?")
    .bind(accountId)
    .all<{ type: string; rates_json: string | null }>();
  // Each connection's rates are read only if the search reaches it, so one
  // with unreadable rates cannot block a target the catalog alone allows.
  const connections = results.map(priceSources);
  const operationsOf = (type: string) => builtInProvider(type)?.operations ?? [];
  for (const [source, target] of targets) {
    if (!rewriteTargetBillable(target, connections, Object.keys(BUILT_IN_PROVIDERS), operationsOf)) {
      throw new GatewayError(
        400,
        "pricing_not_configured",
        `config.routing.model_rewrites.${source}: ${target} has no price; add one to a provider connection first`,
        undefined,
        { data: { model: target } },
      );
    }
  }
}

/**
 * A preset and each fallback: the connection exists, its type has an
 * operation of the preset's API style a preset can use, and the model has a
 * price that operation can bill, in any service mode the preset's parameters
 * name.
 */
async function checkPreset(
  slug: string,
  preset: Preset,
  connectionRow: (slug: string) => Promise<ConnectionRow | null>,
): Promise<void> {
  const where = `config.presets.${slug}`;
  const declared = declaredOperation(preset.operation);
  const style = declared?.style;
  if (declared === null || style === undefined) {
    throw invalid(`${where}.operation: ${preset.operation} is not an operation a preset can use`, { slug });
  }
  if (preset.params !== undefined && declared.model.in === "form") {
    throw invalid(`${where}.params: a ${style} preset takes an upload; params apply only to JSON requests`, { slug });
  }
  const targets: { label: string; provider: string; operation?: string | undefined; model: string }[] = [
    { label: where, provider: preset.provider, operation: preset.operation, model: preset.model },
    ...(preset.fallback ?? []).map((fallback, index) => ({ label: `${where}.fallback.${index}`, ...fallback })),
  ];
  for (const [index, target] of targets.entries()) {
    const connection = await connectionRow(target.provider);
    if (connection === null) {
      throw invalid(`${target.label}.provider: no provider connection ${target.provider} exists`, { slug });
    }
    const description = builtInProvider(connection.type);
    if (description === null) {
      throw invalid(`${target.label}.provider: provider type ${connection.type} is not supported`, { slug });
    }
    const operation = presetOperation(description, style, target.operation);
    if (operation === null) {
      const named = target.operation === undefined ? undefined : description.operations.find((candidate) => candidate.name === target.operation);
      throw invalid(
        target.operation === undefined
          ? `${target.label}.provider: ${connection.type} has no ${style} operation a preset can use`
          : named === undefined
            ? `${target.label}.operation: ${target.operation} is not an operation of ${connection.type}`
            : named.style !== style
              ? `${target.label}.operation: ${target.operation} is not a ${style} operation; a fallback must speak the preset's API style`
              : `${target.label}.operation: ${presetOperationProblem(description, named) ?? `${target.operation} cannot be a preset`}`,
        { slug },
      );
    }
    if (index === 0 && preset.max_output_tokens !== undefined && operation.policy?.outputCap === undefined) {
      throw invalid(`${where}.max_output_tokens: ${operation.name} has no output to cap`, { slug });
    }
    const sources = priceSources(connection);
    if (billing(operation, sources, target.model).problem !== null) {
      throw new GatewayError(
        400,
        "pricing_not_configured",
        `${target.label}.model: ${target.model} has no price that ${operation.name} can bill; add one to the provider connection first`,
        undefined,
        { data: { slug, model: target.model, operation: operation.name } },
      );
    }
    // The parameters are sent to every target, so each judges them as a
    // request would be judged: a background option, or an output field over
    // the preset's own cap, is refused now rather than on every call.
    if (preset.params !== undefined && declared.model.in !== "form") {
      const judged = attemptCopy(preset.params);
      try {
        refuseBackground(operation, judged);
        applyOutputCap(operation, judged, preset.max_output_tokens);
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        throw invalid(`${where}.params: ${error.message}${index === 0 ? "" : ` (for ${target.label})`}`, { slug });
      }
    }
    // Naming a service mode in the parameters chooses it for every target, so
    // each must know it and be able to bill it.
    if (preset.params !== undefined) {
      const mode = requestedServiceMode(description, connection.base_url, preset.params, target.model);
      if (mode.unknown !== undefined) {
        throw invalid(`${where}.params.${mode.unknown.field}: ${connection.type} has no service mode ${String(mode.unknown.value)}`, { slug });
      }
      if (billing(operation, sources, target.model, mode.mode).problem === "no_mode_price") {
        throw new GatewayError(
          400,
          "pricing_not_configured",
          `${target.label}.model: ${target.model} has no price in the ${serviceModeName(mode.mode)} service mode the preset's params name`,
          undefined,
          { data: { slug, model: target.model } },
        );
      }
    }
  }
}

/** The app's id: its name made URL-safe, plus a random suffix, as v1. */
export function newAppId(name: string): string {
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
export function requireApiKeyApp(row: AppRow): void {
  const config = JSON.parse(row.config_json) as { authentication?: { type?: unknown } };
  if (config.authentication?.type !== "api_key") {
    throw new GatewayError(400, "invalid_request", "App keys can only be managed for api_key apps");
  }
}

export async function appRow(db: D1Database, accountId: string, appId: string): Promise<AppRow> {
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

/**
 * A new key's insert. It writes only when `guard` holds (a plan ceiling), and
 * with `afterApp`, only when the app exists, so the first key of a new app is
 * never written without its app.
 */
async function createKey(
  db: D1Database,
  appId: string,
  name: string,
  now: number,
  afterApp = false,
  guard: { condition: string; binds: readonly unknown[] } = { condition: "1", binds: [] },
) {
  const generated = await generateApiKey();
  const exists = afterApp ? " AND EXISTS (SELECT 1 FROM app WHERE id = ?)" : "";
  const statement = db
    .prepare(
      `INSERT INTO app_key (id, app_id, name, key_hash, key_prefix, status, created_at)
       SELECT ?, ?, ?, ?, ?, 'active', ? WHERE ${guard.condition}${exists}`,
    )
    .bind(generated.id, appId, name, generated.keyHash, generated.keyPrefix, now, ...guard.binds, ...(afterApp ? [appId] : []));
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
  const cap = await planCap(c.env, c.env.DB, actor.accountId, "app");
  // The first key is not counted against the key ceiling, as v1, except when
  // the plan allows no keys at all: such a plan allows only App Attest apps.
  if (config.authentication.type === "api_key" && (await planCeiling(c.env, actor.accountId, "appKey")) === 0) {
    throw new GatewayError(409, "billing_plan_limit_reached", "This plan allows at most 0 active keys per app", undefined, {
      data: { limit: 0, used: 0 },
    });
  }
  const now = Date.now();
  const id = newAppId(body.name);
  const insert = c.env.DB.prepare(
    `INSERT INTO app (id, account_id, name, config_json, revision, status, created_at, updated_at)
     SELECT ?, ?, ?, ?, 1, ?, ?, ? WHERE ${cap.condition}`,
  ).bind(id, actor.accountId, body.name, JSON.stringify(config), body.status ?? "active", now, now, ...cap.binds);
  // An app-key app gets its first key, shown once, as v1. Written only if the app was.
  const key = config.authentication.type === "api_key" ? await createKey(c.env.DB, id, "Initial key", now, true) : null;
  const [written] = await c.env.DB.batch(key === null ? [insert] : [insert, key.statement]);
  if (written?.meta.changes !== 1) {
    await cap.assertNotReached();
    throw new GatewayError(409, "conflict", "The app could not be created; retry");
  }
  const row = await appRow(c.env.DB, actor.accountId, id);
  return c.json({ app: appView(row), api_key: key?.created ?? null } satisfies OperationResponse<"createApp">, 201);
}

/** The routing a stored configuration has, by slug, read loosely: it was valid when saved. */
function storedRouting(row: AppRow): StoredEntries {
  const config = JSON.parse(row.config_json) as {
    routing?: { providers?: Record<string, unknown>; model_rewrites?: Record<string, unknown> };
    presets?: Record<string, unknown>;
  };
  return { providers: config.routing?.providers ?? {}, presets: config.presets ?? {}, rewrites: config.routing?.model_rewrites ?? {} };
}

/** JSON with every object's keys sorted, so equal values compare equal whatever their key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Saves a whole app over a stored one, as `PUT` and `PATCH` both do: the
 * config is checked as an update, and the write needs the revision it was
 * read at.
 */
async function saveApp(
  c: AdminContext,
  current: AppRow,
  revision: number | undefined,
  body: { name: string; config: unknown; status?: "active" | "disabled" | undefined },
): Promise<Response> {
  const actor = c.get("actor");
  if (revision === undefined) {
    throw new GatewayError(400, "app_revision_required", "Send the revision the app was read at");
  }
  const config = await checkAppConfig(c.env.DB, actor.accountId, body.config, storedRouting(current));
  const result = await c.env.DB.prepare(
    `UPDATE app SET name = ?, config_json = ?, status = COALESCE(?, status), revision = revision + 1, updated_at = ?
     WHERE id = ? AND account_id = ? AND revision = ?`,
  )
    .bind(body.name, JSON.stringify(config), body.status ?? null, Date.now(), current.id, actor.accountId, revision)
    .run();
  if (result.meta.changes === 0) {
    throw new GatewayError(409, "app_revision_conflict", "The app changed since it was read; read it again and retry");
  }
  invalidateApp(current.id);
  const row = await appRow(c.env.DB, actor.accountId, current.id);
  return c.json({ app: appView(row) } satisfies OperationResponse<"updateApp">);
}

export async function updateApp(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const body = await parseBody(c, AppUpdateRequestSchema);
  const current = await appRow(c.env.DB, actor.accountId, c.req.param("app")!);
  return saveApp(c, current, body.revision, body);
}

/**
 * Applies the operations to the app as `getApp` answers it, then saves the
 * result exactly as `PUT` would. Nothing is written unless every operation
 * applies and the result is accepted.
 */
export async function patchApp(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const body = await parseBody(c, AppPatchRequestSchema);
  const current = await appRow(c.env.DB, actor.accountId, c.req.param("app")!);
  // A stale patch is a conflict, even when the edit it missed removed the path it names.
  if (body.revision === undefined) {
    throw new GatewayError(400, "app_revision_required", "Send the revision the app was read at");
  }
  if (body.revision !== current.revision) {
    throw new GatewayError(409, "app_revision_conflict", "The app changed since it was read; read it again and retry");
  }
  const view = appView(current);
  const patched = applyAppPatch({ name: view.name, status: view.status, config: view.config }, body.operations);
  const parsed = AppValidateRequestSchema.safeParse(patched);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.map(String).join(".")}: `;
    throw invalid(`${where}${issue?.message ?? "The patched app is invalid"}`);
  }
  return saveApp(c, current, body.revision, parsed.data);
}

/** Judges an edit of an app as an update would, without saving it. Needs only the read grant. */
export async function validateApp(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const body = await parseBody(c, AppValidateRequestSchema);
  const current = await appRow(c.env.DB, actor.accountId, c.req.param("app")!);
  await checkAppConfig(c.env.DB, actor.accountId, body.config, storedRouting(current));
  return c.json({ valid: true, app_id: current.id } satisfies OperationResponse<"validateApp">);
}

/** Judges a new app's config as a create would, without saving it. Needs only the read grant. */
export async function validateAppDraft(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const body = await parseBody(c, AppValidateRequestSchema);
  await checkAppConfig(c.env.DB, actor.accountId, body.config);
  return c.json({ valid: true } satisfies OperationResponse<"validateAppDraft">);
}

/** What a check cannot establish, said in every answer, as v1. */
export const APP_CHECK_LIMITATIONS = [
  "No provider request was sent.",
  "App Attest on a real device, issuer sign-in, subscription checks and the provider keys themselves were not tried.",
] as const;

/**
 * Whether a stored app could serve a request, as far as its settings say.
 * The stored config is judged as an update would be, so one that would now be
 * refused answers 400 with the reason.
 */
export async function checkApp(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const row = await appRow(c.env.DB, actor.accountId, c.req.param("app")!);
  let stored: unknown;
  try {
    stored = JSON.parse(row.config_json);
  } catch {
    throw invalid("The stored config is not JSON");
  }
  const config = await checkAppConfig(c.env.DB, actor.accountId, stored, storedRouting(row));
  const slugs = Object.keys(config.routing.providers);
  const providers: { id: string | null; slug: string; status: "active" | "disabled" | "missing" }[] = [];
  for (const slug of slugs) {
    const connection = await c.env.DB.prepare("SELECT id, status FROM provider_connection WHERE account_id = ? AND slug = ?")
      .bind(actor.accountId, slug)
      .first<{ id: string; status: "active" | "disabled" }>();
    providers.push(connection === null ? { id: null, slug, status: "missing" } : { id: connection.id, slug, status: connection.status });
  }
  return c.json({
    app_id: row.id,
    status: row.status,
    providers,
    ready: row.status === "active" && providers.some((provider) => provider.status === "active"),
    limitations: [...APP_CHECK_LIMITATIONS],
  } satisfies OperationResponse<"checkApp">);
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
  const cap = await planCap(c.env, c.env.DB, actor.accountId, "appKey", appId);
  const key = await createKey(c.env.DB, appId, body.name, Date.now(), true, cap);
  const result = await key.statement.run();
  if (result.meta.changes !== 1) {
    await cap.assertNotReached();
    throw new GatewayError(404, "app_not_found", "App is not registered");
  }
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
