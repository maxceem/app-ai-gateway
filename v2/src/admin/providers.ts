/**
 * Provider connections, through the management API.
 *
 * - The key is sealed by the vault and is write-only: a response carries only
 *   its hint, the last characters, as v1.
 * - A base URL passes the origin guard when saved (https, a public host name).
 *   Moving a key to a new origin needs the key in the same request, so a
 *   stored key is never sent to an origin it was not given for, as v1. Going
 *   back to the provider's own origin re-seals the stored key.
 * - Customer prices are taken in dollars per million units, as v1, and stored
 *   once as whole nano-dollars per million units.
 * - Cloudflare AI Gateway is a setting on a connection (D13): the Cloudflare
 *   account and gateway, and a Cloudflare token, sealed on its own and
 *   write-only as the key is. Through it, the provider key is optional:
 *   Cloudflare can use the keys in its own key store. The key's origin is the
 *   gateway, so turning it on or off moves the key, by the rule above.
 */
import type { Context } from "hono";
import {
  ProviderCreateRequestSchema,
  ProviderTestRequestSchema,
  ProviderUpdateRequestSchema,
  type ModelPricingSchema,
} from "../contracts/admin.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { GatewayError } from "../core/errors.ts";
import { checkOperatorBaseUrl } from "../core/origin-guard.ts";
import { MoneyError, NANO_PER_DOLLAR, rateFromDollarsPerMillion } from "../money.ts";
import { MAX_PRICE_KEY_COMBINATIONS, savedPriceProblem } from "../pricing/billability.ts";
import type { CustomerRates } from "../pricing/prices.ts";
import {
  keyOrigin,
  readCloudflareGateway,
  invalidateConnection,
  type CloudflareGatewaySetting,
} from "../providers/connections.ts";
import { builtInProvider } from "../providers/index.ts";
import type { ProviderDescription } from "../providers/operation.ts";
import { upstreamRequest } from "../providers/route.ts";
import { openSecret, sealSecret } from "../vault/secrets.ts";
import { requireManage, type AdminVariables } from "./actor.ts";
import { checkConnectionRates, checkNewConnection, parseBody } from "./apps.ts";
import { planCap } from "./plan-caps.ts";
import { probeProviderKey } from "./provider-test.ts";
import type { z } from "zod";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;
type DollarPricing = Record<string, z.output<typeof ModelPricingSchema>>;

export interface ConnectionRow {
  id: string;
  account_id: string;
  type: string;
  slug: string;
  name: string;
  status: "active" | "disabled";
  secret_blob: string | null;
  secret_hint: string | null;
  base_url: string | null;
  cloudflare_gateway_json: string | null;
  serving_providers_json: string | null;
  rates_json: string | null;
  revision: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The last four characters, so a person can tell keys apart. A key shorter
 * than 12 characters gets no hint: four of them would give away too much of it,
 * and a response must never contain a submitted secret.
 */
export function secretHint(secret: string): string {
  return secret.length < 12 ? "" : secret.slice(-4);
}

/** One set of dollar rates as stored nano-dollar rates. `where` names it in an error. */
function storedRates(rates: Readonly<Record<string, unknown>>, where: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [field, value] of Object.entries(rates)) {
    if (typeof value !== "number") continue;
    if (field === "factor" || field === "long_context_threshold") {
      out[field] = value;
      continue;
    }
    try {
      out[field] = rateFromDollarsPerMillion(value);
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
      throw new GatewayError(400, "invalid_request", `${where}.${field}: the price is too large`);
    }
  }
  return out;
}

/** Each nested table of rates, converted with `convert`. */
function mapTables(
  tables: Readonly<Record<string, unknown>> | undefined,
  convert: (rates: Readonly<Record<string, unknown>>, where: string) => Record<string, number>,
  where: string,
): Record<string, Record<string, number>> | undefined {
  if (tables === undefined) return undefined;
  return Object.fromEntries(Object.entries(tables).map(([name, rates]) => [name, convert(rates as Record<string, unknown>, `${where}.${name}`)]));
}

/**
 * Refuses a stored price that, at some key value and mode serving can select,
 * no operation of the connection can charge (the one charge function decides,
 * `savedPriceProblem`), or that holds a rate too large to store.
 */
function assertEffectivePrices(stored: CustomerRates, model: string, providerType: string, where: string): void {
  const problem = savedPriceProblem(stored, model, providerType, builtInProvider(providerType)?.operations ?? []);
  if (problem === null) return;
  if (problem.kind === "too_many_combinations") {
    throw new GatewayError(
      400,
      "invalid_request",
      `${where}: its price keys combine in ${problem.combinations} ways; at most ${MAX_PRICE_KEY_COMBINATIONS} are allowed`,
    );
  }
  if (problem.kind === "too_large") throw new GatewayError(400, "invalid_request", `${where}: a rate is too large once a service mode's factor applies`);
  const named = Object.entries(problem.values).map(([key, value]) => `${key} ${value}`).join(", ");
  throw new GatewayError(400, "invalid_request", `${where}: the price${named === "" ? "" : ` for ${named}`} in ${problem.mode} has no rate that bills`);
}

/** Dollars to stored rates: each rate to whole nano-dollars per its amount, modes and price keys too. */
export function ratesFromPricing(pricing: DollarPricing, providerType: string): CustomerRates {
  const rates: Record<string, Record<string, unknown>> = {};
  for (const [model, price] of Object.entries(pricing)) {
    const where = `pricing.${model}`;
    const { modes, by, ...flat } = price as Record<string, unknown> & { modes?: Record<string, unknown>; by?: Record<string, Record<string, unknown>> };
    const entry: Record<string, unknown> = storedRates(flat, where);
    const storedModes = mapTables(modes, storedRates, `${where}.modes`);
    if (storedModes !== undefined) entry.modes = storedModes;
    if (by !== undefined) {
      entry.by = Object.fromEntries(Object.entries(by).map(([key, table]) => [key, mapTables(table, storedRates, `${where}.by.${key}`)]));
    }
    rates[model] = entry;
  }
  for (const model of Object.keys(rates)) assertEffectivePrices(rates, model, providerType, `pricing.${model}`);
  return rates;
}

/** One set of stored rates back to dollars, for display only. */
function dollarRates(rates: Readonly<Record<string, unknown>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [field, value] of Object.entries(rates)) {
    if (typeof value !== "number") continue;
    out[field] = field === "factor" || field === "long_context_threshold" ? value : value / NANO_PER_DOLLAR;
  }
  return out;
}

/** Stored rates back to dollars, for display only. */
function pricingFromRates(rates: CustomerRates): DollarPricing {
  const pricing: Record<string, Record<string, unknown>> = {};
  for (const [model, entry] of Object.entries(rates)) {
    const out: Record<string, unknown> = dollarRates(entry);
    const modes = mapTables(entry.modes as Record<string, unknown> | undefined, dollarRates, "");
    if (modes !== undefined) out.modes = modes;
    const by = entry.by as Record<string, Record<string, unknown>> | undefined;
    if (by !== undefined) out.by = Object.fromEntries(Object.entries(by).map(([key, table]) => [key, mapTables(table, dollarRates, "")]));
    pricing[model] = out;
  }
  return pricing as DollarPricing;
}

export function providerView(row: ConnectionRow) {
  return {
    id: row.id,
    type: row.type,
    slug: row.slug,
    name: row.name,
    status: row.status,
    secretHint: row.secret_hint,
    baseUrl: row.base_url,
    cloudflareGateway: cloudflareView(readCloudflareGateway(row.cloudflare_gateway_json)),
    servingProviders: row.serving_providers_json === null ? null : (JSON.parse(row.serving_providers_json) as string[]),
    pricing: row.rates_json === null ? null : pricingFromRates(JSON.parse(row.rates_json) as CustomerRates),
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function cloudflareView(setting: CloudflareGatewaySetting | null) {
  return setting === null ? null : { accountId: setting.accountId, gatewayId: setting.gatewayId, tokenHint: setting.tokenHint };
}

/** A Cloudflare AI Gateway setting as stored: ids, and its token sealed to this connection. */
async function storedCloudflare(
  env: Env,
  accountId: string,
  connectionId: string,
  setting: { readonly accountId: string; readonly gatewayId: string; readonly token: string },
): Promise<string> {
  const blob = await sealSecret(env, "cloudflareGatewayToken", [accountId, connectionId], setting.token);
  return JSON.stringify({
    account_id: setting.accountId,
    gateway_id: setting.gatewayId,
    token_blob: blob,
    token_hint: secretHint(setting.token),
  });
}

/**
 * Where a connection's requests may go, checked when it is saved: Cloudflare
 * AI Gateway only for a provider it serves, and never beside a base URL,
 * which would leave two places a request could go.
 */
function checkRoute(
  description: ProviderDescription,
  baseUrl: string | null,
  cloudflare: { readonly accountId: string; readonly gatewayId: string } | null,
): void {
  if (cloudflare === null) return;
  if (description.cloudflareGateway === undefined) {
    throw new GatewayError(400, "invalid_request", `cloudflareGateway: ${description.label} cannot be reached through Cloudflare AI Gateway`);
  }
  if (baseUrl !== null) {
    throw new GatewayError(400, "invalid_request", "cloudflareGateway: a connection goes through a base URL or Cloudflare AI Gateway, not both");
  }
}

/** Pinned serving providers, for a provider type that has the field (`servingProvidersField`) only. */
function servingProvidersJson(description: ProviderDescription, list: readonly string[] | null | undefined): string | null {
  if (list === undefined || list === null) return null;
  if (description.servingProvidersField === undefined) {
    throw new GatewayError(400, "invalid_request", `servingProviders: ${description.label} takes no serving providers`);
  }
  return list.length === 0 ? null : JSON.stringify(list);
}

/** A connection with no key reaches its provider only through Cloudflare AI Gateway, with Cloudflare's stored keys. */
function keyNeeded(): GatewayError {
  return new GatewayError(400, "invalid_request", "secret: a connection needs the provider's key, unless it goes through Cloudflare AI Gateway");
}

export function checkedBaseUrl(raw: string): string {
  const checked = checkOperatorBaseUrl(raw);
  if (!checked.ok) throw new GatewayError(400, "invalid_request", `baseUrl: ${checked.message}`);
  return checked.baseUrl;
}

export async function connectionRow(db: D1Database, accountId: string, id: string): Promise<ConnectionRow> {
  const row = await db
    .prepare("SELECT * FROM provider_connection WHERE id = ? AND account_id = ?")
    .bind(id, accountId)
    .first<ConnectionRow>();
  if (row === null) throw new GatewayError(404, "provider_not_found", "Provider connection not found");
  return row;
}

export function newConnectionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function listProviders(c: AdminContext): Promise<Response> {
  const { results } = await c.env.DB.prepare("SELECT * FROM provider_connection WHERE account_id = ? ORDER BY created_at, id")
    .bind(c.get("actor").accountId)
    .all<ConnectionRow>();
  return c.json({ providers: results.map(providerView) } satisfies OperationResponse<"listProviders">);
}

export async function getProvider(c: AdminContext): Promise<Response> {
  const row = await connectionRow(c.env.DB, c.get("actor").accountId, c.req.param("id")!);
  return c.json({ provider: providerView(row) } satisfies OperationResponse<"getProvider">);
}

export async function createProvider(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const body = await parseBody(c, ProviderCreateRequestSchema);
  const description = builtInProvider(body.type);
  if (description === null) {
    throw new GatewayError(400, "invalid_request", `type: ${body.type} is not a supported provider type`);
  }
  const slug = body.slug ?? body.type;
  const baseUrl = body.baseUrl === undefined ? null : checkedBaseUrl(body.baseUrl);
  const cloudflare = body.cloudflareGateway ?? null;
  checkRoute(description, baseUrl, cloudflare);
  if (body.secret === undefined && cloudflare === null) throw keyNeeded();
  const id = newConnectionId();
  const origin = keyOrigin({ baseUrl, cloudflareGateway: cloudflare });
  const blob = body.secret === undefined ? null : await sealSecret(c.env, "providerKey", [actor.accountId, id, body.type, origin], body.secret);
  const cloudflareJson = cloudflare === null ? null : await storedCloudflare(c.env, actor.accountId, id, cloudflare);
  const servingJson = servingProvidersJson(description, body.servingProviders);
  const newRates = body.pricing === undefined ? null : ratesFromPricing(body.pricing, body.type);
  // Apps may already route to the slug (a connection deleted and made again): their calls are judged on the new rates.
  await checkNewConnection(c.env.DB, actor.accountId, { slug, type: body.type }, newRates);
  const cap = await planCap(c.env, c.env.DB, actor.accountId, "provider");
  const now = Date.now();
  let written: D1Result;
  try {
    written = await c.env.DB.prepare(
      `INSERT INTO provider_connection
        (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, cloudflare_gateway_json, serving_providers_json, rates_json, revision, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE ${cap.condition}`,
    )
      .bind(
        id,
        actor.accountId,
        body.type,
        slug,
        body.name,
        blob,
        body.secret === undefined ? null : secretHint(body.secret),
        baseUrl,
        cloudflareJson,
        servingJson,
        newRates === null ? null : JSON.stringify(newRates),
        actor.userId,
        now,
        now,
        ...cap.binds,
      )
      .run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new GatewayError(409, "conflict", `A provider connection with slug ${slug} already exists`);
    }
    throw error;
  }
  if (written.meta.changes !== 1) {
    await cap.assertNotReached();
    throw new GatewayError(409, "conflict", "The provider connection could not be created; retry");
  }
  invalidateConnection(actor.accountId, slug);
  const row = await connectionRow(c.env.DB, actor.accountId, id);
  return c.json({ provider: providerView(row) } satisfies OperationResponse<"createProvider">, 201);
}

export async function updateProvider(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const body = await parseBody(c, ProviderUpdateRequestSchema);
  const current = await connectionRow(c.env.DB, actor.accountId, c.req.param("id")!);
  const description = builtInProvider(current.type);
  const baseUrl = body.baseUrl === undefined ? current.base_url : body.baseUrl === null ? null : checkedBaseUrl(body.baseUrl);

  // Cloudflare AI Gateway: kept, removed, or set. A new account or gateway needs a token for it.
  const storedCloudflareSetting = readCloudflareGateway(current.cloudflare_gateway_json);
  const asked = body.cloudflareGateway;
  if (asked !== undefined && asked !== null && asked.token === undefined) {
    const same = storedCloudflareSetting?.accountId === asked.accountId && storedCloudflareSetting?.gatewayId === asked.gatewayId;
    if (!same) {
      throw new GatewayError(400, "invalid_request", "cloudflareGateway.token: a new Cloudflare account or gateway needs its token");
    }
  }
  const cloudflare =
    asked === undefined
      ? storedCloudflareSetting
      : asked === null
        ? null
        : { accountId: asked.accountId, gatewayId: asked.gatewayId };
  if (description !== null) checkRoute(description, baseUrl, cloudflare);
  const cloudflareJson =
    asked === undefined
      ? current.cloudflare_gateway_json
      : asked === null
        ? null
        : asked.token === undefined
          ? current.cloudflare_gateway_json
          : await storedCloudflare(c.env, actor.accountId, current.id, { ...asked, token: asked.token });

  // A change of Cloudflare route (on, off, or another gateway) always says what
  // key goes with it: a key that was sent to one gateway is never quietly
  // re-sealed for another destination, and a keyless connection never
  // quietly stays keyless on a new one.
  const cloudflareMoved =
    (storedCloudflareSetting === null) !== (cloudflare === null) ||
    (storedCloudflareSetting !== null &&
      cloudflare !== null &&
      (storedCloudflareSetting.accountId !== cloudflare.accountId || storedCloudflareSetting.gatewayId !== cloudflare.gatewayId));
  if (cloudflareMoved && cloudflare === null && typeof body.secret !== "string") {
    throw new GatewayError(400, "invalid_request", "secret: going direct again needs the provider's key in the same request");
  }
  if (cloudflareMoved && cloudflare !== null && body.secret === undefined) {
    throw new GatewayError(
      400,
      "invalid_request",
      "secret: a new Cloudflare AI Gateway needs the provider's key in the same request, or null to use the keys stored in Cloudflare",
    );
  }

  // The key follows its origin: a new origin needs the key again, and going back to the provider's own re-seals it.
  const from = keyOrigin({ baseUrl: current.base_url, cloudflareGateway: storedCloudflareSetting });
  const to = keyOrigin({ baseUrl, cloudflareGateway: cloudflare });
  const identity = (origin: string): [string, string, string, string] => [actor.accountId, current.id, current.type, origin];
  let blob = current.secret_blob;
  let hint = current.secret_hint;
  if (body.secret === null) {
    if (cloudflare === null) throw keyNeeded();
    blob = null;
    hint = null;
  } else if (body.secret !== undefined) {
    blob = await sealSecret(c.env, "providerKey", identity(to), body.secret);
    hint = secretHint(body.secret);
  } else if (to !== from && current.secret_blob !== null) {
    if (to !== "") {
      throw new GatewayError(
        400,
        "invalid_request",
        "secret: a new baseUrl or Cloudflare AI Gateway needs the key in the same request; a stored key is never sent to a new origin",
      );
    }
    // Back to the provider's own origin: the stored key is re-sealed for it.
    const secret = await openSecret(c.env, "providerKey", identity(from), current.secret_blob);
    blob = await sealSecret(c.env, "providerKey", identity(to), secret);
  }
  if (blob === null && cloudflare === null) throw keyNeeded();
  const servingJson =
    body.servingProviders === undefined
      ? current.serving_providers_json
      : description === null
        ? null
        : servingProvidersJson(description, body.servingProviders);
  const newRates = body.pricing === undefined || body.pricing === null ? null : ratesFromPricing(body.pricing, current.type);
  if (body.pricing !== undefined) {
    // Every change of rates, whatever its shape (a replacement, a deletion inside it, or `null`, every
    // model's rate deleted), is judged against the apps that route to this connection.
    const before = (() => {
      try {
        return current.rates_json === null ? null : (JSON.parse(current.rates_json) as CustomerRates);
      } catch {
        return null;
      }
    })();
    await checkConnectionRates(c.env.DB, actor.accountId, { slug: current.slug, type: current.type }, before, newRates);
  }
  const rates = body.pricing === undefined ? current.rates_json : newRates === null ? null : JSON.stringify(newRates);
  const result = await c.env.DB.prepare(
    `UPDATE provider_connection SET name = ?, status = ?, secret_blob = ?, secret_hint = ?, base_url = ?, cloudflare_gateway_json = ?,
       serving_providers_json = ?, rates_json = ?, revision = revision + 1, updated_at = ?
     WHERE id = ? AND account_id = ? AND revision = ?`,
  )
    .bind(
      body.name ?? current.name,
      body.status ?? current.status,
      blob,
      hint,
      baseUrl,
      cloudflareJson,
      servingJson,
      rates,
      Date.now(),
      current.id,
      actor.accountId,
      body.revision,
    )
    .run();
  if (result.meta.changes === 0) {
    throw new GatewayError(409, "conflict", "The provider connection changed since it was read; read it again and retry");
  }
  invalidateConnection(actor.accountId, current.slug);
  const row = await connectionRow(c.env.DB, actor.accountId, current.id);
  return c.json({ provider: providerView(row) } satisfies OperationResponse<"updateProvider">);
}

export async function deleteProvider(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const current = await connectionRow(c.env.DB, actor.accountId, c.req.param("id")!);
  await c.env.DB.prepare("DELETE FROM provider_connection WHERE id = ? AND account_id = ?").bind(current.id, actor.accountId).run();
  invalidateConnection(actor.accountId, current.slug);
  return c.json({ deleted: true, provider_id: current.id } satisfies OperationResponse<"deleteProvider">);
}

/**
 * Tests a key with the provider, without storing anything. Needs the manage
 * grant: it sends a key the caller supplies to a host the caller may name.
 */
export async function testProvider(c: AdminContext): Promise<Response> {
  requireManage(c.get("actor"));
  const body = await parseBody(c, ProviderTestRequestSchema);
  const description = builtInProvider(body.type);
  if (description === null) {
    throw new GatewayError(400, "invalid_request", `type: ${body.type} is not a supported provider type`);
  }
  const baseUrl = body.baseUrl === undefined ? null : checkedBaseUrl(body.baseUrl);
  const cloudflare = body.cloudflareGateway ?? null;
  checkRoute(description, baseUrl, cloudflare);
  if (body.secret === undefined && cloudflare === null) throw keyNeeded();
  // The probe is built as a live request would be: same host, same credentials.
  const probe =
    description.probe === undefined
      ? null
      : upstreamRequest(
          {
            id: "",
            accountId: "",
            type: body.type,
            slug: "",
            status: "active",
            baseUrl,
            secretBlob: null,
            rates: null,
            servingProviders: null,
            cloudflareGateway:
              cloudflare === null ? null : { accountId: cloudflare.accountId, gatewayId: cloudflare.gatewayId, tokenBlob: "", tokenHint: null },
          },
          description,
          {
            hostKey: "main",
            path: description.probe.path,
            query: "",
            credentials: { providerKey: body.secret ?? null, cloudflareToken: cloudflare?.token ?? null },
            appId: "",
            userId: null,
          },
        );
  return c.json((await probeProviderKey(description, probe)) satisfies OperationResponse<"testProvider">);
}
