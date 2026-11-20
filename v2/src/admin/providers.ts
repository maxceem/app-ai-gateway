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
import { invalidateConnection, upstreamOrigin } from "../providers/connections.ts";
import { builtInProvider } from "../providers/index.ts";
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
    pricing: row.rates_json === null ? null : pricingFromRates(JSON.parse(row.rates_json) as CustomerRates),
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
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
  if (builtInProvider(body.type) === null) {
    throw new GatewayError(400, "invalid_request", `type: ${body.type} is not a supported provider type`);
  }
  const slug = body.slug ?? body.type;
  const baseUrl = body.baseUrl === undefined ? null : checkedBaseUrl(body.baseUrl);
  const id = newConnectionId();
  const blob = await sealSecret(c.env, "providerKey", [actor.accountId, id, body.type, baseUrl ?? ""], body.secret);
  const cap = await planCap(c.env, c.env.DB, actor.accountId, "provider");
  const now = Date.now();
  let written: D1Result;
  try {
    written = await c.env.DB.prepare(
      `INSERT INTO provider_connection
        (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 1, ?, ?, ? WHERE ${cap.condition}`,
    )
      .bind(
        id,
        actor.accountId,
        body.type,
        slug,
        body.name,
        blob,
        secretHint(body.secret),
        baseUrl,
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
  const baseUrl = body.baseUrl === undefined ? current.base_url : body.baseUrl === null ? null : checkedBaseUrl(body.baseUrl);
  const moved = baseUrl !== current.base_url;
  if (moved && baseUrl !== null && body.secret === undefined) {
    throw new GatewayError(
      400,
      "invalid_request",
      "secret: a new baseUrl needs the key in the same request; a stored key is never sent to a new origin",
    );
  }
  let blob = current.secret_blob;
  let hint = current.secret_hint;
  const identity = (url: string | null): [string, string, string, string] => [actor.accountId, current.id, current.type, url ?? ""];
  if (body.secret !== undefined) {
    blob = await sealSecret(c.env, "providerKey", identity(baseUrl), body.secret);
    hint = secretHint(body.secret);
  } else if (moved && current.secret_blob !== null) {
    // Back to the provider's own origin: the stored key is re-sealed for it.
    const secret = await openSecret(c.env, "providerKey", identity(current.base_url), current.secret_blob);
    blob = await sealSecret(c.env, "providerKey", identity(baseUrl), secret);
  }
  const rates =
    body.pricing === undefined
      ? current.rates_json
      : body.pricing === null
        ? null
        : JSON.stringify(ratesFromPricing(body.pricing));
  const result = await c.env.DB.prepare(
    `UPDATE provider_connection SET name = ?, status = ?, secret_blob = ?, secret_hint = ?, base_url = ?, rates_json = ?,
       revision = revision + 1, updated_at = ?
     WHERE id = ? AND account_id = ? AND revision = ?`,
  )
    .bind(
      body.name ?? current.name,
      body.status ?? current.status,
      blob,
      hint,
      baseUrl,
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
  const origin = upstreamOrigin(
    { id: "", accountId: "", type: body.type, slug: "", status: "active", baseUrl, secretBlob: null, rates: null },
    description,
    "main",
  );
  return c.json((await probeProviderKey(description, origin, body.secret)) satisfies OperationResponse<"testProvider">);
}
