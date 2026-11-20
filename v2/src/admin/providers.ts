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
import type { CustomerRates, RateField } from "../pricing/prices.ts";
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
import { parseBody } from "./apps.ts";
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

/** Dollars per million to stored rates. */
export function ratesFromPricing(pricing: DollarPricing): CustomerRates {
  const rates: Record<string, Partial<Record<RateField, number>> & { long_context_threshold?: number }> = {};
  for (const [model, price] of Object.entries(pricing)) {
    const entry: Partial<Record<RateField, number>> & { long_context_threshold?: number } = {};
    for (const [field, value] of Object.entries(price)) {
      if (field === "long_context_threshold") {
        entry.long_context_threshold = value;
        continue;
      }
      try {
        entry[field as RateField] = rateFromDollarsPerMillion(value);
      } catch (error) {
        if (!(error instanceof MoneyError)) throw error;
        throw new GatewayError(400, "invalid_request", `pricing.${model}.${field}: the price is too large`);
      }
    }
    rates[model] = entry;
  }
  return rates;
}

/** Stored rates back to dollars per million, for display only. */
function pricingFromRates(rates: CustomerRates): DollarPricing {
  const pricing: Record<string, Record<string, number>> = {};
  for (const [model, entry] of Object.entries(rates)) {
    const out: Record<string, number> = {};
    for (const [field, value] of Object.entries(entry)) {
      if (value === undefined) continue;
      out[field] = field === "long_context_threshold" ? value : value / NANO_PER_DOLLAR;
    }
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
  const cap = await planCap(c.env, c.env.DB, actor.accountId, "provider");
  const now = Date.now();
  let written: D1Result;
  try {
    written = await c.env.DB.prepare(
      `INSERT INTO provider_connection
        (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, cloudflare_gateway_json, rates_json, revision, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE ${cap.condition}`,
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
        body.pricing === undefined ? null : JSON.stringify(ratesFromPricing(body.pricing)),
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
  const rates =
    body.pricing === undefined
      ? current.rates_json
      : body.pricing === null
        ? null
        : JSON.stringify(ratesFromPricing(body.pricing));
  const result = await c.env.DB.prepare(
    `UPDATE provider_connection SET name = ?, status = ?, secret_blob = ?, secret_hint = ?, base_url = ?, cloudflare_gateway_json = ?,
       rates_json = ?, revision = revision + 1, updated_at = ?
     WHERE id = ? AND account_id = ? AND revision = ?`,
  )
    .bind(
      body.name ?? current.name,
      body.status ?? current.status,
      blob,
      hint,
      baseUrl,
      cloudflareJson,
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
          c.env,
          {
            id: "",
            accountId: "",
            type: body.type,
            slug: "",
            status: "active",
            baseUrl,
            secretBlob: null,
            rates: null,
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
