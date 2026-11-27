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
 * - Passthrough paths (plan section 4.5) are checked when saved: each must be
 *   a valid template, and a newly listed one must follow the named-part rule
 *   and not be a built-in endpoint (`passthroughJson`). There are no refused
 *   paths: admin paths work too, if the customer lists them. A newly listed
 *   path the provider suggests safe defaults for gets them written in.
 * - A custom provider (type `custom`, `../providers/custom.ts`) needs its
 *   base URL and the header its key is sent in. Its listed paths are its
 *   whole API; one that names an API style is an operation of that style,
 *   priced at the connection's rates. It takes neither Cloudflare AI Gateway
 *   nor serving providers. Only a person or key with the manage grant can
 *   save one, as any base URL.
 * - A base URL's path is normalized as request paths are (`checkedBaseUrl`).
 *   On the provider's own host it is the plain address, and Cloudflare AI
 *   Gateway is reached through its setting, never a base URL
 *   (`checkDestination`).
 * - Every change that affects which calls a connection serves or their price
 *   (rates, paths, API styles, base URL) is judged against the apps that
 *   route to it by one rule (`checkConnectionChange`).
 */
import type { Context } from "hono";
import {
  CUSTOM_PROVIDER_TYPE,
  ProviderCreateRequestSchema,
  ProviderTestRequestSchema,
  ProviderUpdateRequestSchema,
  type CustomAuthSchema,
  type FieldSettingSchema,
  type ModelPricingSchema,
  type PassthroughPathSchema,
} from "../contracts/admin.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { GatewayError } from "../core/errors.ts";
import { fromDollars, MoneyError, NANO_PER_DOLLAR, rateFromDollarsPerMillion } from "../money.ts";
import { callGap, MAX_PRICE_KEY_COMBINATIONS, resolvePassthrough, savedPriceProblem, unusedModeRate } from "../pricing/billability.ts";
import type { CustomerRates } from "../pricing/prices.ts";
import { UNIT_RATE_FIELDS } from "../pricing/units.ts";
import { selectableModes } from "../proxy/meter.ts";
import {
  CLOUDFLARE_AI_GATEWAY_ORIGIN,
  describeConnection,
  cloudflareTokenIdentity,
  keyIdentity,
  keyOrigin,
  readCloudflareGateway,
  invalidateConnection,
  providerKeyIdentity,
  sealedCredentials,
  type CloudflareGatewaySetting,
  type ConnectionRecord,
} from "../providers/connections.ts";
import {
  customAuthProblem,
  customDescription,
  customOperationName,
  customStyleProblem,
  declaredHostNames,
  hostMatches,
  isCustomStyle,
  knownHostOwner,
} from "../providers/custom.ts";
import { builtInProvider } from "../providers/index.ts";
import {
  compilePassthrough,
  DIRECT_ROUTE,
  listingShape,
  apiPrefixesOf,
  namedPartProblem,
  ProviderMatcher,
  upstreamRoute,
  type CompiledPassthrough,
  type PassthroughPath,
  type UpstreamRoute,
} from "../providers/matcher.ts";
import type { FieldSetting, OperationDescription, ProviderAuth, ProviderDescription, SuggestedPath } from "../providers/operation.ts";
import { readCustomAuth, readPassthrough, storedPassthrough } from "../providers/passthrough.ts";
import { TemplateError } from "../providers/path.ts";
import { cloudflareIdProblem, normalizedBaseUrl } from "../providers/destinations.ts";
import { sealedUpstreamRequest, type SealedUpstreamRequest } from "../providers/route.ts";
import { keyNeededToMove, sealingRoot } from "../vault/split-keys.ts";
import { vault } from "../vault/client.ts";
import { requireManage, type AdminVariables } from "./actor.ts";
import { checkConnectionChange, checkNewConnection, parseBody } from "./apps.ts";
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
  passthrough_json: string | null;
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
function assertEffectivePrices(
  stored: CustomerRates,
  model: string,
  providerType: string,
  operations: readonly OperationDescription[],
  where: string,
): void {
  const problem = savedPriceProblem(stored, model, providerType, operations);
  if (problem === null) return;
  if (problem.kind === "too_many_combinations") {
    throw new GatewayError(
      400,
      "invalid_request",
      `${where}: its price keys combine in ${problem.combinations} ways; at most ${MAX_PRICE_KEY_COMBINATIONS} are allowed`,
    );
  }
  if (problem.kind === "too_large") throw new GatewayError(400, "invalid_request", `${where}: a rate is too large once a service mode's factor applies`);
  if (problem.kind === "session_rates") {
    const needs =
      problem.rates.length > 0
        ? problem.byClock
          ? `${problem.rates.join(" and ")} as ${problem.rates.length === 1 ? "a base rate" : "base rates"}${problem.withoutBy ? ", with no by" : ""}`
          : problem.rates.join(" and ")
        : problem.tokensOnly
          ? "token rates"
          : "token rates or a time rate";
    throw new GatewayError(400, "invalid_request", `${where}: ${problem.operation} needs ${needs}`);
  }
  const named = Object.entries(problem.values).map(([key, value]) => `${key} ${value}`).join(", ");
  throw new GatewayError(
    400,
    "invalid_request",
    `${where}: the price${named === "" ? "" : ` for ${named}`} in ${problem.mode} has no rate that bills${problem.measure === undefined ? "" : `; it needs a rate for ${problem.measure}`}`,
  );
}

/**
 * Dollars to stored rates: each rate to whole nano-dollars per its amount,
 * modes and price keys too. Each price is judged against `operations`, the
 * connection's: its built-in type's by default, a custom provider's own.
 */
export function ratesFromPricing(
  pricing: DollarPricing,
  providerType: string,
  operations: readonly OperationDescription[] = builtInProvider(providerType)?.operations ?? [],
): CustomerRates {
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
  for (const model of Object.keys(rates)) assertEffectivePrices(rates, model, providerType, operations, `pricing.${model}`);
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

/**
 * Listed paths back to how the API writes them, the price in dollars. A
 * field setting the provider suggests (`suggestedPaths`) carries its label,
 * reason and suggested value, read from the description now, never stored,
 * so every console, CLI and MCP answer says why it is there.
 */
function passthroughView(
  stored: string | null,
  description: ProviderDescription | null = null,
  route: UpstreamRoute = DIRECT_ROUTE,
): z.output<typeof PassthroughPathSchema>[] | undefined {
  const paths = readPassthrough(stored);
  if (paths.length === 0) return undefined;
  // Only a listing with field settings needs the matcher, for their labels and reasons.
  let matcher: ProviderMatcher | null = null;
  return paths.map((listed) => {
    let suggested: SuggestedPath | null = null;
    try {
      if (description !== null && listed.setFields !== undefined && listed.setFields.length > 0) {
        matcher ??= new ProviderMatcher(description);
        suggested = matcher.suggestionFor(compilePassthrough([listed])[0]!, route);
      }
    } catch {
      // A path that no longer compiles still shows as stored.
    }
    return {
      method: listed.method,
      path: listed.path,
      ...(listed.priceNano !== undefined ? { per_request: listed.priceNano / NANO_PER_DOLLAR } : {}),
      ...(listed.style !== undefined && isCustomStyle(listed.style) ? { style: listed.style } : {}),
      ...(listed.setFields !== undefined && listed.setFields.length > 0 ? { set_fields: listed.setFields.map((field) => fieldView(field, suggested)) } : {}),
      ...(listed.websocket === true ? { websocket: true as const, per_minute: (listed.perMinuteNano ?? 0) / NANO_PER_DOLLAR } : {}),
    };
  });
}

/** A field setting as the API writes it, with its suggestion's label, reason and suggested value when it has one. */
function fieldView(field: FieldSetting, suggested: SuggestedPath | null): z.output<typeof FieldSettingSchema> {
  const suggestion = suggested?.fields.find((entry) => entry.in === field.in && entry.name === field.name);
  return {
    in: field.in,
    name: field.name,
    value: field.value,
    ...(field.as !== undefined ? { as: field.as } : {}),
    ...(field.aliases !== undefined && field.aliases.length > 0 ? { aliases: [...field.aliases] } : {}),
    ...(suggestion !== undefined ? { label: suggestion.label, reason: suggestion.reason, suggested_value: suggestion.value } : {}),
  };
}

/** A suggested field as a listing stores it: without its label and reason. */
function settingOf(field: FieldSetting): FieldSetting {
  return {
    in: field.in,
    name: field.name,
    value: field.value,
    ...(field.as !== undefined ? { as: field.as } : {}),
    ...(field.aliases !== undefined ? { aliases: field.aliases } : {}),
  };
}

/** The most seconds a `time_from_now` value may hold: 30 days. */
const MAX_SECONDS_FROM_NOW = 30 * 24 * 60 * 60;
/** Field names a JavaScript object treats specially (`set_fields`). */
const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** A listing's field settings, checked: each names a field once, and its value fits where it goes. */
function checkedFields(
  asked: readonly z.output<typeof FieldSettingSchema>[] | undefined,
  where: string,
  method: string,
): FieldSetting[] | undefined {
  if (asked === undefined) return undefined;
  const seen = new Set<string>();
  // Every body field name set so far, with its settings index: a parent and its child would overwrite each other.
  const bodyNames: { readonly path: readonly string[]; readonly name: string }[] = [];
  return asked.map((field, index) => {
    const at = `${where}.set_fields.${index}`;
    if (!Object.hasOwn(field, "value") || field.value === undefined) throw new GatewayError(400, "invalid_request", `${at}.value: a value is needed`);
    // A GET is sent with no body, so a body field could never reach the provider.
    if (field.in === "body" && (method === "GET" || method === "HEAD")) {
      throw new GatewayError(400, "invalid_request", `${at}.in: a ${method} request has no body; set a query parameter instead`);
    }
    const names = [field.name, ...(field.aliases ?? [])];
    for (const name of names) {
      const key = `${field.in}:${name}`;
      if (seen.has(key)) throw new GatewayError(400, "invalid_request", `${at}: ${name} is set twice`);
      seen.add(key);
      if (field.in === "body" && name.split(".").includes("")) throw new GatewayError(400, "invalid_request", `${at}: ${name} is not a field name`);
      // Names a JavaScript object treats specially never reach a body as a plain field.
      if (field.in === "body" && name.split(".").some((piece) => RESERVED_FIELD_NAMES.has(piece))) {
        throw new GatewayError(400, "invalid_request", `${at}: ${name} uses a reserved name (__proto__, constructor or prototype)`);
      }
    }
    if (field.in === "body") {
      for (const name of names) {
        const path = name.split(".");
        const clash = bodyNames.find((other) => {
          const shorter = Math.min(other.path.length, path.length);
          return other.path.slice(0, shorter).every((piece, depth) => piece === path[depth]);
        });
        if (clash !== undefined) {
          throw new GatewayError(400, "invalid_request", `${at}: ${name} and ${clash.name} are the same field or one holds the other; set one of them`);
        }
        // Checked against the setting's own other names and aliases too, not only earlier settings'.
        bodyNames.push({ path, name });
      }
    }
    if (field.as === "time_from_now") {
      if (!Number.isSafeInteger(field.value) || (field.value as number) < 0 || (field.value as number) > MAX_SECONDS_FROM_NOW) {
        throw new GatewayError(400, "invalid_request", `${at}.value: a time from now is a whole number of seconds, from 0 to ${MAX_SECONDS_FROM_NOW}`);
      }
    } else if (field.in === "query" && typeof field.value !== "string") {
      throw new GatewayError(400, "invalid_request", `${at}.value: a query parameter's value is a string`);
    }
    if (JSON.stringify(field.value).length > 4096) throw new GatewayError(400, "invalid_request", `${at}.value: the value is too large`);
    return settingOf(field as FieldSetting);
  });
}

/** What a connection's listed paths are judged against: a built-in provider, or a custom one's base URL and key header. */
export type ListingSubject =
  | { readonly kind: "builtIn"; readonly description: ProviderDescription; readonly cloudflareGateway: object | null; readonly baseUrl: string | null }
  | { readonly kind: "custom"; readonly baseUrl: string; readonly auth: ProviderAuth };

/** A connection's listed paths, checked: what to store, and the description they make (a custom provider's operations). */
interface CheckedListing {
  readonly stored: string | null;
  readonly description: ProviderDescription;
}

/**
 * A connection's passthrough list as stored, checked (plan section 4.5):
 *
 * - each path is a template whose `{name}` parts match one segment, listed
 *   once per method;
 * - its price, if any, is whole nano-dollars that the one charge function
 *   bills (`resolvePassthrough`, `callGap`);
 * - its field settings, if any, each name a field once (`checkedFields`);
 * - a path not listed before follows the named-part rule
 *   (`namedPartProblem`), and may not be a built-in endpoint: listed paths
 *   are matched first, so it would take a declared operation's requests
 *   unmetered ("turn it on for the app instead"). That is judged where the
 *   provider reads the path, through a base URL or Cloudflare AI Gateway
 *   (`upstreamTargets`). Paths listed before on the same route are not
 *   judged again, so a later release that declares one never stops a save.
 *   A new route judges them all (`before` is then empty).
 * - a path first listed (not in `stored`) that the provider suggests safe
 *   defaults for (`suggestedPaths`) gets them, unless the request names its
 *   own `set_fields`, even an empty list. Removed later, they stay removed.
 * - a custom provider's path may name an API style (`../providers/custom.ts`):
 *   a POST, with no flat price (its models' rates price it), one per style.
 *   It is then one of the provider's operations, so no plain listing may
 *   overlap it, nor another style's path.
 * - a custom provider may list one WebSocket path (plan D4, D10): a GET with
 *   a price per minute, and nothing else (no style, no price per request, no
 *   field settings). A live session reaches it, never an HTTP request.
 */
export function passthroughJson(
  subject: ListingSubject,
  asked: readonly z.output<typeof PassthroughPathSchema>[],
  before: readonly PassthroughPath[],
  stored: readonly PassthroughPath[] = before,
): CheckedListing {
  const shapesOf = (paths: readonly PassthroughPath[]) =>
    new Set(paths.flatMap((listed) => {
      try {
        return [listingKey(compilePassthrough([listed])[0]!)];
      } catch {
        return [];
      }
    }));
  const known = shapesOf(before);
  const kept = shapesOf(stored);
  // A built-in connection's matcher and route, built once: which provider path a listing reaches decides
  // its suggestion (through Cloudflare, the setting's prefix) and whether it is a built-in endpoint.
  const builtInMatcher = subject.kind === "builtIn" ? new ProviderMatcher(subject.description) : null;
  const builtInRoute = subject.kind === "builtIn" ? upstreamRoute(subject.description, subject) : DIRECT_ROUTE;
  const seen = new Set<string>();
  const styles = new Set<string>();
  let websocketAt: string | null = null;
  const checked = asked.map((entry, index) => {
    const where = `passthrough.${index}`;
    const key = `${entry.method} ${entry.path}`;
    if (entry.websocket === true) {
      if (subject.kind !== "custom") throw new GatewayError(400, "invalid_request", `${where}.websocket: only a custom provider's path can be a WebSocket session`);
      if (entry.method !== "GET") throw new GatewayError(400, "invalid_request", `${where}.method: a WebSocket path is a GET`);
      if (entry.per_minute === undefined) throw new GatewayError(400, "invalid_request", `${where}.per_minute: a WebSocket path needs a price per minute`);
      if (entry.style !== undefined || entry.per_request !== undefined) {
        throw new GatewayError(400, "invalid_request", `${where}: a WebSocket path is priced per minute; it names no API style and no price per request`);
      }
      if (entry.set_fields !== undefined && entry.set_fields.length > 0) {
        throw new GatewayError(400, "invalid_request", `${where}.set_fields: a WebSocket path is relayed as it is; it sets no fields`);
      }
      if (websocketAt !== null) throw new GatewayError(400, "invalid_request", `${where}.websocket: list one WebSocket path per provider; ${websocketAt} is one already`);
      websocketAt = key;
    } else if (entry.per_minute !== undefined) {
      throw new GatewayError(400, "invalid_request", `${where}.per_minute: only a WebSocket path has a price per minute; a path is priced per request`);
    }
    if (entry.style !== undefined) {
      if (subject.kind !== "custom") throw new GatewayError(400, "invalid_request", `${where}.style: only a custom provider's path names an API style`);
      if (entry.method !== "POST") throw new GatewayError(400, "invalid_request", `${where}.method: a path of the ${entry.style} style is a POST`);
      if (entry.per_request !== undefined) {
        throw new GatewayError(400, "invalid_request", `${where}.per_request: a path of an API style is priced by its models' rates, not per request`);
      }
      if (styles.has(entry.style)) throw new GatewayError(400, "invalid_request", `${where}.style: list one path per API style; ${entry.style} has one already`);
      styles.add(entry.style);
      if (entry.set_fields !== undefined && entry.set_fields.length > 0) {
        throw new GatewayError(400, "invalid_request", `${where}.set_fields: a path of an API style is served as that style; it sets no fields`);
      }
    }
    const nanoOf = (dollars: number | undefined, field: string): number | undefined => {
      if (dollars === undefined) return undefined;
      try {
        return fromDollars(dollars);
      } catch (error) {
        if (!(error instanceof MoneyError)) throw error;
        throw new GatewayError(400, "invalid_request", `${where}.${field}: the price is too large`);
      }
    };
    const priceNano = nanoOf(entry.per_request, "per_request");
    const perMinuteNano = nanoOf(entry.per_minute, "per_minute");
    const setFields = checkedFields(entry.set_fields, where, entry.method);
    const bare: PassthroughPath = {
      method: entry.method,
      path: entry.path,
      ...(priceNano !== undefined ? { priceNano } : {}),
      ...(entry.style !== undefined ? { style: entry.style } : {}),
      ...(entry.websocket === true && perMinuteNano !== undefined ? { websocket: true as const, perMinuteNano } : {}),
    };
    let compiled: CompiledPassthrough;
    try {
      [compiled] = compilePassthrough([bare]) as [CompiledPassthrough];
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error;
      throw new GatewayError(400, "invalid_request", `${where}.path: ${error.message}`);
    }
    // Two listings that match the same requests are one, whatever their parts are called.
    const shape = listingShape(bare.method, compiled.template);
    if (seen.has(shape)) throw new GatewayError(400, "invalid_request", `${where}: ${key} matches the same requests as another listed path`);
    seen.add(shape);
    if (callGap(resolvePassthrough(bare)) !== null) {
      throw new GatewayError(400, "invalid_request", `${where}.per_request: the price cannot be charged`);
    }
    const isNew = !known.has(listingKey(compiled));
    if (isNew) {
      const problem = namedPartProblem(compiled.template, subject.kind === "custom" ? [] : apiPrefixesOf(subject.description));
      if (problem !== null) throw new GatewayError(400, "invalid_request", `${where}.path: ${problem}`);
    }
    // First listed with no settings of its own: the provider's safe defaults, written in so the customer sees them.
    const suggested =
      setFields === undefined && !kept.has(listingKey(compiled)) ? (builtInMatcher?.suggestionFor(compiled, builtInRoute)?.fields.map(settingOf) ?? []) : [];
    const fields = setFields ?? suggested;
    const listed: PassthroughPath = { ...bare, ...(fields.length > 0 ? { setFields: fields } : {}) };
    return { where, key, listed, compiled: { listed, template: compiled.template }, isNew };
  });
  // Two listings that can match one request need no refusal: the more specific one serves it (`moreSpecific`).
  // A plain GET that could match a WebSocket path's address is served as listed: HTTP passthrough sends only
  // allowed headers, so it never opens a WebSocket.
  const paths = checked.map((one) => one.listed);
  // A custom provider's description holds its API-style paths as operations, so it is built from this save.
  const description = subject.kind === "custom" ? customDescription({ baseUrl: subject.baseUrl, auth: subject.auth, paths }) : subject.description;
  const route = builtInMatcher !== null ? builtInRoute : upstreamRoute(description, { baseUrl: subject.kind === "custom" ? subject.baseUrl : null, cloudflareGateway: null });
  const matcher = builtInMatcher ?? new ProviderMatcher(description);
  // A new API-style path is an operation the plain listings could now overlap: they are judged against it again.
  const styleAdded = checked.some((one) => one.listed.style !== undefined && one.isNew);
  // A custom provider on a built-in provider's host takes only two things from that provider (plan 4.5): its
  // built-in endpoints are never listed as plain paths, which would serve them unmetered, and an API-style path
  // reads answers by that provider's rules (`./providers/custom.ts`). Nothing else: no prices, regions or headers.
  const owner = subject.kind === "custom" ? knownHostOwner(subject.baseUrl) : null;
  const ownerMatcher = owner === null ? null : new ProviderMatcher(owner);
  const ownerRoute = owner === null || subject.baseUrl === null ? null : upstreamRoute(owner, { baseUrl: subject.baseUrl, cloudflareGateway: null });
  for (const { where, key, listed, compiled, isNew } of checked) {
    // A path new or changed in this save is judged for its style: one already listed keeps working.
    if (isNew && subject.kind === "custom" && listed.style !== undefined && isCustomStyle(listed.style)) {
      const problem = customStyleProblem(listed.style, subject.baseUrl, listed.path);
      if (problem !== null) throw new GatewayError(400, "invalid_request", `${where}.style: ${problem}`);
      // On a known provider's host, a path its declared operation serves speaks that operation's style:
      // another style's reader would miss what its answers report.
      const overlapped = ownerMatcher === null || ownerRoute === null ? [] : ownerMatcher.overlappingOperations(compiled, ownerRoute);
      const styleOf = (name: string) => owner!.operations.find((operation) => operation.name === name)?.style;
      const declared = overlapped.find((name) => styleOf(name) !== listed.style) ?? null;
      const declaredStyle = declared === null ? undefined : styleOf(declared);
      if (declared !== null) {
        throw new GatewayError(
          400,
          "invalid_request",
          declaredStyle !== undefined && isCustomStyle(declaredStyle)
            ? `${where}.style: ${key} is ${owner!.label}'s ${declared} operation, which speaks ${declaredStyle}; list it with the style ${declaredStyle}`
            : `${where}.style: ${key} is ${owner!.label}'s ${declared} operation, which a custom path cannot meter; use a ${owner!.label} connection for it`,
        );
      }
    }
    // As on a built-in connection: a plain path newly listed on a known provider's host may not take
    // one of that provider's declared operations, which would pass it through unmetered.
    if (isNew && listed.style === undefined && ownerMatcher !== null && ownerRoute !== null) {
      const declared = ownerMatcher.overlappingOperation(compiled, ownerRoute);
      if (declared !== null) {
        const style = owner!.operations.find((operation) => operation.name === declared)?.style;
        throw new GatewayError(
          400,
          "invalid_request",
          style !== undefined && isCustomStyle(style)
            ? `${where}.path: ${key} is ${owner!.label}'s built-in ${declared} endpoint; list it with the style ${style}, which meters and prices it`
            : `${where}.path: ${key} is ${owner!.label}'s built-in ${declared} endpoint; use a ${owner!.label} connection and turn it on for the app instead`,
        );
      }
    }
    if (listed.style !== undefined && isCustomStyle(listed.style)) {
      // Its own operation aside, no other style's path may take its requests.
      const name = customOperationName(listed.style);
      const others = new ProviderMatcher({ ...description, operations: description.operations.filter((operation) => operation.name !== name) });
      const other = others.overlappingOperation(compiled, route);
      if (other !== null) throw new GatewayError(400, "invalid_request", `${where}.path: ${key} can match the requests of the ${other} path; list paths that do not overlap`);
      continue;
    }
    if (!isNew && !styleAdded) continue;
    // Listed paths are matched before declared operations, so a listing that
    // could match any of an operation's paths would take its requests unmetered.
    const operation = matcher.overlappingOperation(compiled, route);
    if (operation !== null) {
      throw new GatewayError(
        400,
        "invalid_request",
        subject.kind === "custom"
          ? `${where}.path: ${key} can match the requests of the ${operation} path; list paths that do not overlap`
          : `${where}.path: ${key} is built in as the ${operation} operation; turn it on for the app instead`,
      );
    }
  }
  return { stored: storedPassthrough(paths, subject.kind === "custom" ? subject.auth : null), description };
}

/**
 * A rate in a service mode that no call on the connection can ever bill:
 * refused when this save adds or changes it. Which modes a call can be
 * billed in is read by the code that reads them when serving
 * (`selectableModes`), for the connection's base URL and each operation; and
 * whether a rate entry is ever used, by the one charge function, fallbacks
 * included (`unusedModeRate`). Every save of rates runs it: a direct create
 * or update, and a hand-off.
 */
export function assertModesSelectable(
  description: ProviderDescription,
  baseUrl: string | null,
  rates: CustomerRates | null,
  before: CustomerRates | null,
): void {
  assertOneJobRate(description, rates, before);
  for (const model of Object.keys(rates ?? {})) {
    const calls = description.operations.map((operation) => ({ operation, modes: selectableModes(description, operation, baseUrl, model) }));
    const unused = unusedModeRate(rates!, before, model, calls);
    if (unused === null) continue;
    throw new GatewayError(
      400,
      "invalid_request",
      `pricing.${model}.modes.${unused}: no call on this connection is ever billed at this rate; price the mode its calls are served in instead`,
    );
  }
}

/**
 * A job settles from the one rate its estimate stored, so a model a job can
 * serve takes exactly one unit rate: a price with two (say per unit and per
 * job) could settle on the wrong one. Judged only for prices this save adds
 * or changes, so a stored price keeps working.
 */
function assertOneJobRate(description: ProviderDescription, rates: CustomerRates | null, before: CustomerRates | null): void {
  if (rates === null || !description.operations.some((operation) => operation.lifecycle === "job")) return;
  const unitRates = (table: Readonly<Record<string, unknown>>) => UNIT_RATE_FIELDS.filter((field) => typeof table[field] === "number");
  for (const [model, entry] of Object.entries(rates)) {
    if (before !== null && JSON.stringify(before[model]) === JSON.stringify(entry)) continue;
    const { by, modes: _modes, ...flat } = entry as Record<string, unknown> & { by?: Record<string, Record<string, Record<string, unknown>>> };
    const tables = [flat, ...Object.values(by ?? {}).flatMap((values) => Object.values(values))];
    if (tables.some((table) => unitRates(table).length > 1)) {
      throw new GatewayError(400, "invalid_request", `pricing.${model}: a job model takes one rate: per job, per unit, per image or per video`);
    }
  }
}

/**
 * A listing's shape and, for a custom provider's path, its API style or whether it is a WebSocket path: what
 * makes it the same listing as before. A plain path turned into a WebSocket path is judged as a new one.
 */
function listingKey(compiled: CompiledPassthrough): string {
  return `${listingShape(compiled.listed.method, compiled.template)}\u0000${compiled.listed.style ?? ""}${compiled.listed.websocket === true ? "\u0000websocket" : ""}`;
}

/** Whether two routes send every path to the same provider path (`upstreamTargets`). */
function sameRoute(a: UpstreamRoute, b: UpstreamRoute): boolean {
  const same = (x: readonly string[] | null, y: readonly string[] | null) =>
    x === null || y === null ? x === y : x.length === y.length && x.every((piece, index) => piece === y[index]);
  return same(a.basePath, b.basePath) && same(a.cloudflarePrefix, b.cloudflarePrefix);
}

export function providerView(row: ConnectionRow) {
  const builtIn = builtInProvider(row.type);
  const passthrough = passthroughView(
    row.passthrough_json,
    builtIn,
    builtIn === null ? DIRECT_ROUTE : upstreamRoute(builtIn, { baseUrl: row.base_url, cloudflareGateway: readCloudflareGateway(row.cloudflare_gateway_json) }),
  );
  const auth = row.type === CUSTOM_PROVIDER_TYPE ? readCustomAuth(row.passthrough_json) : null;
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
    ...(passthrough !== undefined ? { passthrough } : {}),
    ...(auth !== null ? { auth } : {}),
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
export async function storedCloudflare(
  env: Env,
  accountId: string,
  connectionId: string,
  setting: { readonly accountId: string; readonly gatewayId: string; readonly token: string },
): Promise<string> {
  const blob = await vault(env).seal("cloudflareGatewayToken", cloudflareTokenIdentity(accountId, connectionId, setting), setting.token, await sealingRoot(env, accountId));
  return JSON.stringify({
    account_id: setting.accountId,
    gateway_id: setting.gatewayId,
    token_blob: blob,
    token_hint: secretHint(setting.token),
  });
}

/**
 * A Cloudflare setting's ids as a save judges them: each one new or changed
 * must be one plain path segment (`cloudflareIdProblem`); one exactly as
 * `stored` keeps saving, so an older connection can still rotate its token.
 * The schema has already refused `.` and `..` everywhere.
 */
export function checkCloudflareIds(
  gateway: { readonly accountId: string; readonly gatewayId: string },
  stored: { readonly accountId: string; readonly gatewayId: string } | null,
): void {
  for (const field of ["accountId", "gatewayId"] as const) {
    if (stored !== null && stored[field] === gateway[field]) continue;
    const problem = cloudflareIdProblem(gateway[field]);
    if (problem !== null) throw new GatewayError(400, "invalid_request", `cloudflareGateway.${field}: ${problem}`);
  }
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

/**
 * Why a built-in connection's new or changed base URL is refused, or null
 * (plan section 4.5):
 *
 * - Cloudflare AI Gateway's host: Cloudflare is reached through the
 *   connection's own setting, never a base URL.
 * - the provider's own declared host with a path: there the base URL is the
 *   plain address the provider declares (`https://openrouter.ai/api/`).
 *
 * Any other host, such as a self-hosted server, is the customer's own.
 */
/** Cloudflare AI Gateway's host name (`CLOUDFLARE_AI_GATEWAY_ORIGIN`). */
const CLOUDFLARE_AI_GATEWAY_HOSTNAME = new URL(CLOUDFLARE_AI_GATEWAY_ORIGIN).hostname;

function baseUrlProblem(description: ProviderDescription, baseUrl: string): string | null {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  if (host === CLOUDFLARE_AI_GATEWAY_HOSTNAME) {
    return "Cloudflare AI Gateway is reached through the connection's cloudflareGateway setting, not a base URL";
  }
  // Another built-in provider's host: its endpoints would be reached under this provider's rules and prices.
  const owner = knownHostOwner(baseUrl);
  if (owner !== null && owner.type !== description.type) {
    return `${host} is ${owner.label}'s host; connect it as the ${owner.type} provider type, or as a custom provider`;
  }
  // A declared host with a path (`openrouter.ai/api`, and its regional `eu.openrouter.ai/api`) keeps it.
  const declared = [...Object.values(description.hosts), ...(description.otherHosts ?? [])].find((entry) => entry.split("/")[0]!.toLowerCase() === host);
  const plain = declared !== undefined ? `/${declared.slice(declared.split("/")[0]!.length + 1)}`.replace(/\/?$/u, "/") : "/";
  const own = declaredHostNames(description).some((name) => hostMatches(name, host));
  if (own && url.pathname !== plain) return `on ${description.label}'s own host the base URL is its plain address: https://${url.host}${plain}`;
  return null;
}

/**
 * Where a built-in connection's requests go, judged the one way every write
 * of a type and base URL goes through: direct create, update, the key test,
 * and a provider handoff both when it is opened and when it is approved.
 * The route (a base URL or Cloudflare AI Gateway, not both) is always checked;
 * the base URL itself only when it is new or changed (`stored`), so one
 * stored before keeps working.
 */
export function checkDestination(
  description: ProviderDescription,
  baseUrl: string | null,
  cloudflare: { accountId: string; gatewayId: string } | null,
  stored: string | null = null,
): void {
  checkRoute(description, baseUrl, cloudflare);
  if (baseUrl === null || baseUrl === stored) return;
  const problem = baseUrlProblem(description, baseUrl);
  if (problem !== null) throw new GatewayError(400, "invalid_request", `baseUrl: ${problem}`);
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

/**
 * A custom provider's key header and base URL, checked when saved. Its base
 * URL passed the origin guard. It may not be Cloudflare AI Gateway's host:
 * a built-in connection's own setting goes there instead.
 */
function checkedCustom(
  baseUrl: string | null,
  auth: z.output<typeof CustomAuthSchema> | undefined | null,
  stored: { readonly baseUrl: string | null; readonly auth: ProviderAuth | null } | null = null,
): { baseUrl: string; auth: ProviderAuth } {
  if (baseUrl === null) throw new GatewayError(400, "invalid_request", "baseUrl: a custom provider needs its base URL");
  if (auth === undefined || auth === null) throw new GatewayError(400, "invalid_request", "auth: a custom provider needs the header its key is sent in");
  // Only what this save sets or changes is judged: a stricter rule in a later release never stops a save that keeps them.
  const sameAuth = stored?.auth !== null && stored?.auth !== undefined && stored.auth.header === auth.header && stored.auth.format === auth.format;
  const problem = sameAuth ? null : customAuthProblem(auth);
  if (problem !== null) throw new GatewayError(400, "invalid_request", problem);
  if (baseUrl !== stored?.baseUrl && new URL(baseUrl).hostname === CLOUDFLARE_AI_GATEWAY_HOSTNAME) {
    throw new GatewayError(
      400,
      "invalid_request",
      "baseUrl: Cloudflare AI Gateway is not a custom provider; add the provider itself and turn on its Cloudflare AI Gateway setting",
    );
  }
  return { baseUrl, auth: { header: auth.header, format: auth.format } };
}

/** Fields a custom provider does not take, and the ones only it takes. */
function assertFieldsFit(
  type: string,
  body: { readonly auth?: unknown; readonly cloudflareGateway?: unknown; readonly servingProviders?: unknown },
): void {
  if (type === CUSTOM_PROVIDER_TYPE) {
    if (body.cloudflareGateway !== undefined && body.cloudflareGateway !== null) {
      throw new GatewayError(400, "invalid_request", "cloudflareGateway: a custom provider is reached at its base URL only");
    }
    if (body.servingProviders !== undefined && body.servingProviders !== null) {
      throw new GatewayError(400, "invalid_request", "servingProviders: a custom provider takes no serving providers");
    }
  } else if (body.auth !== undefined) {
    throw new GatewayError(400, "invalid_request", "auth: only a custom provider sets how its key is sent");
  }
}

/**
 * A base URL, checked when saved (`normalizedBaseUrl`, shared with the
 * console). A stored base URL sent back unchanged (`unchanged`) is not judged
 * again.
 */
export function checkedBaseUrl(raw: string, unchanged: string | null = null): string {
  const checked = normalizedBaseUrl(raw, unchanged);
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
  const custom = body.type === CUSTOM_PROVIDER_TYPE;
  const builtIn = builtInProvider(body.type);
  if (builtIn === null && !custom) {
    throw new GatewayError(400, "invalid_request", `type: ${body.type} is not a supported provider type`);
  }
  assertFieldsFit(body.type, body);
  const slug = body.slug ?? body.type;
  const baseUrl = body.baseUrl === undefined ? null : checkedBaseUrl(body.baseUrl);
  const cloudflare = body.cloudflareGateway ?? null;
  if (cloudflare !== null) checkCloudflareIds(cloudflare, null);
  const customSetting = custom ? checkedCustom(baseUrl, body.auth) : null;
  if (builtIn !== null) checkDestination(builtIn, baseUrl, cloudflare);
  if (body.secret === undefined && cloudflare === null) throw keyNeeded();
  const id = newConnectionId();
  const origin = keyOrigin({ type: body.type, baseUrl, cloudflareGateway: cloudflare });
  const blob =
    body.secret === undefined
      ? null
      : await vault(c.env).seal("providerKey", keyIdentity(actor.accountId, id, body.type, origin, customSetting?.auth ?? null), body.secret, await sealingRoot(c.env, actor.accountId));
  const cloudflareJson = cloudflare === null ? null : await storedCloudflare(c.env, actor.accountId, id, cloudflare);
  const servingJson = builtIn === null ? null : servingProvidersJson(builtIn, body.servingProviders);
  // A custom provider always stores its key header, so its paths are judged even when it lists none yet.
  const listing =
    customSetting !== null
      ? passthroughJson({ kind: "custom", ...customSetting }, body.passthrough ?? [], [])
      : body.passthrough === undefined
        ? null
        : passthroughJson({ kind: "builtIn", description: builtIn!, baseUrl, cloudflareGateway: cloudflare }, body.passthrough, []);
  const passthroughStored = listing?.stored ?? null;
  const operations = listing?.description.operations ?? builtIn!.operations;
  const newRates = body.pricing === undefined ? null : ratesFromPricing(body.pricing, body.type, operations);
  assertModesSelectable(listing?.description ?? builtIn!, baseUrl, newRates, null);
  // Apps may already route to the slug (a connection deleted and made again): their calls are judged on the new rates.
  await checkNewConnection(
    c.env.DB,
    actor.accountId,
    { slug, type: body.type, baseUrl, ...(listing !== null && custom ? { description: listing.description } : {}) },
    newRates,
  );
  const cap = await planCap(c.env, c.env.DB, actor.accountId, "provider");
  const now = Date.now();
  let written: D1Result;
  try {
    written = await c.env.DB.prepare(
      `INSERT INTO provider_connection
        (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, cloudflare_gateway_json, serving_providers_json, rates_json, passthrough_json, revision, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE ${cap.condition}`,
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
        passthroughStored,
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
  // A change made since it was read is a conflict before anything is judged against what changed; the write checks again.
  if (current.revision !== body.revision) throw new GatewayError(409, "conflict", "The provider connection changed since it was read; read it again and retry");
  const custom = current.type === CUSTOM_PROVIDER_TYPE;
  const description = builtInProvider(current.type);
  assertFieldsFit(current.type, body);
  const baseUrl = body.baseUrl === undefined ? current.base_url : body.baseUrl === null ? null : checkedBaseUrl(body.baseUrl, current.base_url);
  const storedAuth = custom ? readCustomAuth(current.passthrough_json) : null;
  const customSetting = custom ? checkedCustom(baseUrl, body.auth ?? storedAuth, { baseUrl: current.base_url, auth: storedAuth }) : null;

  // Cloudflare AI Gateway: kept, removed, or set. A new account or gateway needs a token for it.
  const storedCloudflareSetting = readCloudflareGateway(current.cloudflare_gateway_json);
  const asked = body.cloudflareGateway;
  if (asked !== undefined && asked !== null) checkCloudflareIds(asked, storedCloudflareSetting);
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
  // A base URL is judged when new or changed: one stored before keeps working.
  if (description !== null) checkDestination(description, baseUrl, cloudflare, current.base_url);
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
  const from = keyOrigin({ type: current.type, baseUrl: current.base_url, cloudflareGateway: storedCloudflareSetting });
  const to = keyOrigin({ type: current.type, baseUrl, cloudflareGateway: cloudflare });
  // A custom provider's key is sealed with its header and format: a new one needs the key again.
  const newAuth = customSetting?.auth ?? null;
  const identity = (origin: string, auth: ProviderAuth | null) => keyIdentity(actor.accountId, current.id, current.type, origin, auth);
  const keyAuthMoved = custom && (storedAuth?.header !== newAuth?.header || storedAuth?.format !== newAuth?.format);
  let blob = current.secret_blob;
  let hint = current.secret_hint;
  if (body.secret === null) {
    if (cloudflare === null) throw keyNeeded();
    blob = null;
    hint = null;
  } else if (body.secret !== undefined) {
    blob = await vault(c.env).seal("providerKey", identity(to, newAuth), body.secret, await sealingRoot(c.env, actor.accountId));
    hint = secretHint(body.secret);
  } else if (keyAuthMoved && current.secret_blob !== null) {
    throw new GatewayError(400, "invalid_request", "secret: a new key header or format needs the key in the same request; a stored key is only ever sent the way it was saved");
  } else if (to !== from && current.secret_blob !== null) {
    if (to !== "") {
      throw new GatewayError(
        400,
        "invalid_request",
        "secret: a new baseUrl or Cloudflare AI Gateway needs the key in the same request; a stored key is never sent to a new origin",
      );
    }
    // Back to the provider's own origin: the stored key is re-sealed for it.
    // The vault opens and seals it again itself: the key never comes back here (plan step 8i).
    // With split keys on it cannot: the key is needed again (step 8j).
    if ((await sealingRoot(c.env, actor.accountId)) !== undefined) throw keyNeededToMove();
    blob = await vault(c.env).reseal("providerKey", identity(from, storedAuth), identity(to, newAuth), current.secret_blob);
  }
  if (blob === null && cloudflare === null) throw keyNeeded();
  const servingJson =
    body.servingProviders === undefined
      ? current.serving_providers_json
      : description === null
        ? null
        : servingProvidersJson(description, body.servingProviders);
  // Listed paths are judged on the route they will be sent on. A route that
  // changes where the provider reads a path (a base URL's path, or going
  // through Cloudflare or not) judges every listed path again, kept or sent.
  // Another Cloudflare gateway, or another host with the same path, does not.
  let passthroughStored = current.passthrough_json;
  const storedPaths = readPassthrough(current.passthrough_json);
  const oldDescription = describeConnection({ type: current.type, baseUrl: current.base_url, passthrough: storedPaths, customAuth: storedAuth });
  const newDescription = customSetting !== null ? customDescription({ ...customSetting, paths: storedPaths }) : description;
  const routeMoved =
    oldDescription !== null &&
    newDescription !== null &&
    !sameRoute(
      upstreamRoute(oldDescription, { baseUrl: current.base_url, cloudflareGateway: storedCloudflareSetting }),
      upstreamRoute(newDescription, { baseUrl, cloudflareGateway: cloudflare }),
    );
  // Another known provider's host behind the same path: its declared endpoints are judged against every listing again.
  const ownerOf = (url: string | null) => (url === null ? null : (knownHostOwner(url)?.type ?? null));
  const ownerMoved = ownerOf(current.base_url) !== ownerOf(baseUrl);
  const authMoved = customSetting !== null && (storedAuth?.header !== customSetting.auth.header || storedAuth?.format !== customSetting.auth.format);
  const kept = body.passthrough === undefined && (routeMoved || ownerMoved || authMoved) ? (passthroughView(current.passthrough_json, description) ?? []) : undefined;
  const askedPaths = body.passthrough === null ? (custom ? [] : null) : (body.passthrough ?? kept);
  // The description the connection has once saved: its paths decide a custom provider's operations.
  let operationsDescription: ProviderDescription | null = custom ? newDescription : description;
  if (askedPaths === null) passthroughStored = null;
  else if (askedPaths !== undefined) {
    const priorPaths = routeMoved || ownerMoved ? [] : storedPaths;
    let checked: CheckedListing;
    if (customSetting !== null) checked = passthroughJson({ kind: "custom", ...customSetting }, askedPaths, priorPaths, storedPaths);
    else {
      if (description === null) throw new GatewayError(400, "invalid_request", `passthrough: provider type ${current.type} is not supported`);
      checked = passthroughJson({ kind: "builtIn", description, baseUrl, cloudflareGateway: cloudflare }, askedPaths, priorPaths, storedPaths);
    }
    passthroughStored = checked.stored;
    operationsDescription = checked.description;
  }
  const newRates =
    body.pricing === undefined || body.pricing === null ? null : ratesFromPricing(body.pricing, current.type, operationsDescription?.operations ?? []);
  // The stored rates, read once: unreadable ones count as none.
  const oldRates = (() => {
    try {
      return current.rates_json === null ? null : (JSON.parse(current.rates_json) as CustomerRates);
    } catch {
      return null;
    }
  })();
  if (operationsDescription !== null && body.pricing !== undefined) assertModesSelectable(operationsDescription, baseUrl, newRates, oldRates);
  // Every change that affects which calls the connection serves, or their price, is judged against the
  // apps that route to it, by one rule (`checkConnectionChange`): its rates (a replacement, a deletion
  // inside it, or `null`), its paths and a custom provider's API styles, its base URL.
  if (body.pricing !== undefined || askedPaths !== undefined || baseUrl !== current.base_url) {
    const finalRates = body.pricing === undefined ? oldRates : newRates;
    if (oldDescription !== null && operationsDescription !== null) {
      await checkConnectionChange(
        c.env.DB,
        actor.accountId,
        { slug: current.slug, type: current.type },
        { description: oldDescription, baseUrl: current.base_url, rates: oldRates },
        { description: operationsDescription, baseUrl, rates: finalRates },
      );
    }
  }
  const rates = body.pricing === undefined ? current.rates_json : newRates === null ? null : JSON.stringify(newRates);
  const result = await c.env.DB.prepare(
    `UPDATE provider_connection SET name = ?, status = ?, secret_blob = ?, secret_hint = ?, base_url = ?, cloudflare_gateway_json = ?,
       serving_providers_json = ?, rates_json = ?, passthrough_json = ?, revision = revision + 1, updated_at = ?
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
      passthroughStored,
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
  if (body.type === CUSTOM_PROVIDER_TYPE) {
    // A custom provider has no call known to be free: nothing is sent. Its base URL and key header are still checked.
    assertFieldsFit(body.type, body);
    checkedCustom(body.baseUrl === undefined ? null : checkedBaseUrl(body.baseUrl), body.auth ?? { header: "authorization", format: "Bearer {key}" });
    return c.json({ validated: false, reason: "no_probe" } satisfies OperationResponse<"testProvider">);
  }
  const description = builtInProvider(body.type);
  if (description === null) {
    throw new GatewayError(400, "invalid_request", `type: ${body.type} is not a supported provider type`);
  }
  assertFieldsFit(body.type, body);
  const baseUrl = body.baseUrl === undefined ? null : checkedBaseUrl(body.baseUrl);
  const cloudflare = body.cloudflareGateway ?? null;
  // A test names no stored connection, so its ids are judged as new ones: what cannot be saved is not tested.
  if (cloudflare !== null) checkCloudflareIds(cloudflare, null);
  checkDestination(description, baseUrl, cloudflare);
  if (body.secret === undefined && cloudflare === null) throw keyNeeded();
  // The probe is built as a live request would be: same host, same credentials,
  // sealed first and sent by the vault. A test names no stored connection: its id is "".
  // Each credential is sealed for where the probe really goes, Cloudflare included.
  const env = c.env;
  const accountId = c.get("actor").accountId;
  const build =
    description.probe === undefined
      ? null
      : async (): Promise<SealedUpstreamRequest> => {
          const destination: ConnectionRecord = {
            id: "",
            accountId,
            type: body.type,
            slug: "",
            status: "active",
            baseUrl,
            secretBlob: null,
            rates: null,
            servingProviders: null,
            cloudflareGateway:
              cloudflare === null
                ? null
                : {
                    accountId: cloudflare.accountId,
                    gatewayId: cloudflare.gatewayId,
                    tokenBlob: await vault(env).seal("cloudflareGatewayToken", cloudflareTokenIdentity(accountId, "", cloudflare), cloudflare.token),
                    tokenHint: null,
                  },
          };
          const connection: ConnectionRecord = {
            ...destination,
            secretBlob: body.secret === undefined ? null : await vault(env).seal("providerKey", providerKeyIdentity(destination), body.secret),
          };
          return sealedUpstreamRequest(connection, description, {
            hostKey: "main",
            path: description.probe!.path,
            query: "",
            credentials: sealedCredentials(connection),
            appId: "",
            userId: null,
          });
        };
  return c.json((await probeProviderKey(env, description, build)) satisfies OperationResponse<"testProvider">);
}
