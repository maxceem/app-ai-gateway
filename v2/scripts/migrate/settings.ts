/**
 * The settings half of the v1-to-v2 migration (plan section 9.1): the rows v2
 * needs before an app can call it. Accounts, logins, memberships and open
 * invitations; management keys; provider connections, with their keys sealed
 * again under v2's vault; apps, with their routing, presets, limits,
 * rewrites and conversation storage; app keys, App Attest keys, and the ids
 * of deleted apps.
 *
 * Usage, events and stored conversations are the history half, built at
 * step 13 beside this one.
 *
 * Nothing is dropped or changed silently. Every row left out, and every
 * setting v2 cannot hold as v1 held it, is a line in the report, saying what
 * happens to the app or account because of it.
 *
 * The rules, as the plan sets them:
 * - Ids are kept, so installed apps, app keys and management keys go on
 *   working, and the hosted billing service still knows each account.
 * - An unclaimed account (v1's temporary CLI accounts) has no owner in v2. It
 *   is not moved, and neither are its apps and connections.
 * - Google's own tokens on a login are dropped. The password hash and the
 *   Google link move. Sessions, CLI sign-ins and MCP connections do not move:
 *   people sign in once more.
 * - A provider key, or a gateway token, is opened with v1's vault and sealed
 *   again with v2's, in memory only (`Resealer`).
 * - A base URL v2 does not take never sends a key anywhere new: the
 *   connection is left out and reported, except where v2 reaches the same
 *   provider without the base URL.
 * - An app's allowed paths become operations. A path no operation serves
 *   becomes a passthrough path on the connection, judged by the same rules
 *   as a save in the console (`passthroughJson`), with the safe defaults a
 *   new listing gets. v2 lists paths per connection, so a path one app listed
 *   becomes reachable by every app on that connection that allows
 *   passthrough: reported as a widening.
 * - Budgets move from dollars to whole nano-dollars.
 */
import { AppConfigSchema, ConversationsConfigSchema, conversationsAreDefault, type AppConfig } from "../../src/contracts/app-config.ts";
import { ModelPricingSchema } from "../../src/contracts/admin.ts";
import { checkCloudflareIds, checkDestination, checkedBaseUrl, passthroughJson, ratesFromPricing, type ListingSubject } from "../../src/admin/providers.ts";
import { knownHostOwner } from "../../src/providers/custom.ts";
import { BUILT_IN_PROVIDERS, builtInProvider } from "../../src/providers/index.ts";
import { ProviderMatcher } from "../../src/providers/matcher.ts";
import type { ApiStyle, HttpMethod, ProviderDescription } from "../../src/providers/operation.ts";
import { PASSTHROUGH } from "../../src/providers/passthrough.ts";
import { presetOperation } from "../../src/providers/presets.ts";
import type { V1App, V1Gateway, V1Provider, V1Settings } from "./v1-rows.ts";

/** One line of the report. */
export interface ReportLine {
  /** `left_out`: not moved. `changed`: moved, but not as v1 held it. `check`: moved, but worth a look before release. */
  readonly kind: "left_out" | "changed" | "check";
  /** What it is about, such as `app chat-a1b2` or `account org_1`. */
  readonly subject: string;
  readonly what: string;
}

/** A v2 row: column name to value. */
export type Row = Record<string, string | number | null>;

/** The tables the settings half writes, in the order they are written, so each row's references exist first. */
export const TABLE_ORDER = [
  "mgmt_user",
  "mgmt_organization",
  "mgmt_organization_user",
  "mgmt_organization_invitation",
  "mgmt_user_account",
  "mgmt_api_key",
  "provider_connection",
  "app",
  "app_key",
  "app_attest_key",
  "retired_app_id",
] as const;

export type V2Table = (typeof TABLE_ORDER)[number];
export type V2Rows = Record<V2Table, Row[]>;

/** Where a secret is sealed: the kind and the ids its context binds, as each version's vault names them. */
export type V1Sealed =
  | { readonly kind: "providerKey"; readonly identity: readonly [organizationId: string, providerId: string, providerType: string, baseUrl: string] }
  | { readonly kind: "providerGatewayToken"; readonly identity: readonly [organizationId: string, providerGatewayId: string] };
export type V2Sealed =
  | { readonly kind: "providerKey"; readonly identity: readonly [accountId: string, connectionId: string, providerType: string, baseUrl: string] }
  | { readonly kind: "cloudflareGatewayToken"; readonly identity: readonly [accountId: string, connectionId: string] };

/** Opens a v1 blob and seals its secret for v2. The secret itself never leaves this call. Throws when the blob does not open. */
export type Resealer = (blob: string, from: V1Sealed, to: V2Sealed) => Promise<string>;

export interface MigrationOptions {
  /** The moment the run counts as now: invitations still open, and the time ids are retired. */
  readonly now: Date;
  readonly reseal: Resealer;
}

export interface MigrationResult {
  readonly rows: V2Rows;
  readonly report: ReportLine[];
  /** Each moved app's v2 settings and account, for v2's own save checks (`./judge.ts`). */
  readonly apps: ReadonlyMap<string, { readonly accountId: string; readonly config: AppConfig }>;
}

// ---------------------------------------------------------------- small helpers

/** A v1 text time (SQLite's `YYYY-MM-DD HH:MM:SS`, read as UTC, or ISO) in milliseconds; null when empty or unreadable. */
export function v1TimeMs(text: string | null | undefined): number | null {
  if (text === null || text === undefined || text === "") return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/u.test(text) ? `${text.replace(" ", "T")}Z` : text;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** A gateway error's message without its field prefix, for the report. */
function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^[a-zA-Z.0-9_]+: /u, "");
}

/** v1's endpoint API styles, as v2 names them. */
const STYLE_OF_ENDPOINT: Readonly<Record<string, ApiStyle>> = {
  chat_completions: "openai-chat",
  responses: "openai-responses",
  anthropic_messages: "anthropic-messages",
  gemini_native: "gemini-generate",
  audio_transcription: "openai-transcription",
  image_generation: "openai-images",
  embeddings: "openai-embeddings",
  gemini_embedding: "gemini-embed",
};

/**
 * The model namespace v1 put before a model's name on Vercel AI Gateway, per
 * provider type (v1's `VERCEL_ROUTES`). A row could name its own instead.
 */
const V1_VERCEL_PREFIX: Readonly<Record<string, string>> = {
  openai: "openai/",
  anthropic: "anthropic/",
  gemini: "google/",
  xai: "spacexai/",
  perplexity: "perplexity/",
  deepseek: "deepseek/",
  moonshot: "moonshotai/",
};

const CLOUDFLARE_HOST = "gateway.ai.cloudflare.com";

/** A name with its article: "an OpenAI", "a Gemini". */
function a(name: string): string {
  return `${/^[AEIOU]/u.test(name) ? "an" : "a"} ${name}`;
}

/** A path as v2 lists it: no leading `/`. */
function plainPath(path: string): string {
  return path.trim().replace(/^\/+/u, "");
}

/** A sample value in each `{name}` part, so a listed v1 path can be matched as a request would be. */
function samplePath(path: string): string {
  return path.replace(/\{[^}/]*\}/gu, "sample");
}

// ---------------------------------------------------------------- connections

interface MovedConnection {
  readonly id: string;
  readonly accountId: string;
  readonly slug: string;
  readonly description: ProviderDescription;
  /** v1's type, when the connection's type changed (a row routed through Vercel AI Gateway). */
  readonly v1Description: ProviderDescription | null;
  /** v1 put this before every model name (Vercel AI Gateway); v2 takes the full name. */
  readonly modelPrefix: string | null;
  readonly subject: ListingSubject & { readonly kind: "builtIn" };
  /** Paths apps listed in v1, accepted for this connection, with the apps that listed each. */
  readonly listed: { readonly asked: { method: HttpMethod; path: string }; readonly apps: Set<string> }[];
  readonly row: Row;
}

/** A model name as the v2 connection takes it. */
function wireModel(connection: MovedConnection, model: string): string {
  return connection.modelPrefix !== null && !model.startsWith(connection.modelPrefix) ? `${connection.modelPrefix}${model}` : model;
}

/** Where a v1 base URL leaves a connection: kept, dropped where v2 reaches the provider without it, or why it cannot move. */
function placeBaseUrl(description: ProviderDescription, raw: string): { baseUrl: string | null; note?: string } | { problem: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: `its base URL ${raw} is not a URL` };
  }
  if (url.hostname.toLowerCase() === CLOUDFLARE_HOST) {
    return {
      baseUrl: null,
      note: `Its base URL went through Cloudflare AI Gateway (${raw}). v2 goes through Cloudflare only with a Cloudflare token, which v1 did not hold, so the connection now goes to ${description.label} directly with the same key. To go through Cloudflare again, turn on the connection's Cloudflare AI Gateway setting in the console.`,
    };
  }
  try {
    const checked = checkedBaseUrl(raw);
    checkDestination(description, checked, null);
    return { baseUrl: checked };
  } catch (error) {
    const owner = knownHostOwner(raw);
    if (owner?.type === description.type) {
      return { baseUrl: null, note: `Its base URL ${raw} was on ${description.label}'s own host, which v2 reaches without one (${reason(error)}).` };
    }
    if (owner !== null) {
      return { problem: `its base URL ${raw} is on ${owner.label}'s host. v2 does not send ${a(description.label)} connection's key there. Add it again as ${a(owner.label)} connection` };
    }
    return { problem: `v2 does not take its base URL ${raw} (${reason(error)}). Its key is not sent anywhere new. Add the connection again in the console` };
  }
}

/** A v1 gateway's Cloudflare ids, or null. */
function cloudflareIds(gateway: V1Gateway): { accountId: string; gatewayId: string } | null {
  try {
    const config = JSON.parse(gateway.config_json) as { accountId?: unknown; gatewayId?: unknown };
    return typeof config.accountId === "string" && typeof config.gatewayId === "string" ? { accountId: config.accountId, gatewayId: config.gatewayId } : null;
  } catch {
    return null;
  }
}

function hint(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

function readRoute(provider: V1Provider, report: ReportLine[], subject: string): { modelPrefix?: string; providerOnly?: string[] } {
  if (provider.gateway_route_json === null || provider.gateway_route_json === "") return {};
  try {
    const route = JSON.parse(provider.gateway_route_json) as { modelPrefix?: unknown; providerOnly?: unknown };
    return {
      ...(typeof route.modelPrefix === "string" ? { modelPrefix: route.modelPrefix } : {}),
      ...(Array.isArray(route.providerOnly) ? { providerOnly: route.providerOnly.filter((entry): entry is string => typeof entry === "string") } : {}),
    };
  } catch {
    report.push({ kind: "changed", subject, what: "Its gateway route settings could not be read, and were left out." });
    return {};
  }
}

/** A v1 connection's own prices as v2 rates, model by model: one v2 refuses is left out and reported. */
function movedRates(provider: V1Provider, type: string, prefix: string | null, report: ReportLine[], subject: string): string | null {
  if (provider.pricing_json === null || provider.pricing_json === "") return null;
  let pricing: Record<string, unknown>;
  try {
    pricing = JSON.parse(provider.pricing_json) as Record<string, unknown>;
  } catch {
    report.push({ kind: "changed", subject, what: "Its own prices could not be read, and were left out. The price list applies instead." });
    return null;
  }
  const rates: Record<string, unknown> = {};
  for (const [v1Model, price] of Object.entries(pricing)) {
    const model = prefix !== null && !v1Model.startsWith(prefix) ? `${prefix}${v1Model}` : v1Model;
    const parsed = ModelPricingSchema.safeParse(price);
    try {
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "unreadable");
      Object.assign(rates, ratesFromPricing({ [model]: parsed.data }, type));
    } catch (error) {
      report.push({ kind: "changed", subject, what: `Its own price for ${v1Model} was left out: ${reason(error)}. The price list applies to that model, if it lists it.` });
    }
  }
  return Object.keys(rates).length > 0 ? JSON.stringify(rates) : null;
}

async function moveConnection(
  provider: V1Provider,
  gateways: ReadonlyMap<string, V1Gateway>,
  options: MigrationOptions,
  report: ReportLine[],
): Promise<MovedConnection | null> {
  const subject = `connection ${provider.slug} (${provider.id}) of account ${provider.organization_id}`;
  const leaveOut = (what: string): null => {
    report.push({ kind: "left_out", subject, what: `Not moved: ${what}. Apps that name ${provider.slug} are refused with provider_not_configured until a connection with that slug is added.` });
    return null;
  };
  const v1Description = builtInProvider(provider.type);
  if (v1Description === null) return leaveOut(`its type ${provider.type} is not a v2 provider type`);
  const route = readRoute(provider, report, subject);
  const createdAt = v1TimeMs(provider.created_at) ?? options.now.getTime();
  const reseal = async (blob: string, from: V1Sealed, to: V2Sealed): Promise<string | null> => {
    try {
      return await options.reseal(blob, from, to);
    } catch (error) {
      leaveOut(`its ${from.kind === "providerKey" ? "key" : "gateway token"} does not open with v1's vault (${reason(error)})`);
      return null;
    }
  };

  let description = v1Description;
  let typeChanged = false;
  let modelPrefix: string | null = null;
  let secretBlob: string | null = null;
  let secretHint: string | null = null;
  let baseUrl: string | null = null;
  let cloudflare: { accountId: string; gatewayId: string } | null = null;
  let cloudflareJson: string | null = null;
  let servingProviders: string | null = null;

  if (provider.provider_gateway_id !== null) {
    const gateway = gateways.get(provider.provider_gateway_id);
    if (gateway === undefined) return leaveOut(`it went through a provider gateway (${provider.provider_gateway_id}) v1 no longer holds`);
    if (gateway.status !== "active") return leaveOut(`it went through a revoked provider gateway (${gateway.name})`);
    const gatewayToken: V1Sealed = { kind: "providerGatewayToken", identity: [gateway.organization_id, gateway.id] };
    if (gateway.type === "cf_aig") {
      if (v1Description.cloudflareGateway === undefined) return leaveOut(`it went through Cloudflare AI Gateway, which v2 does not offer for ${v1Description.label}`);
      cloudflare = cloudflareIds(gateway);
      if (cloudflare === null) return leaveOut(`its Cloudflare AI Gateway ${gateway.name} names no account and gateway ids`);
      try {
        checkCloudflareIds(cloudflare, null);
        checkDestination(v1Description, null, cloudflare);
      } catch (error) {
        return leaveOut(`v2 does not take its Cloudflare AI Gateway ${gateway.name} (${reason(error)})`);
      }
      const blob = await reseal(gateway.secret_blob, gatewayToken, { kind: "cloudflareGatewayToken", identity: [provider.organization_id, provider.id] });
      if (blob === null) return null;
      cloudflareJson = JSON.stringify({ account_id: cloudflare.accountId, gateway_id: cloudflare.gatewayId, token_blob: blob, token_hint: hint(gateway.secret_hint) });
      report.push({
        kind: "changed",
        subject,
        what: `Its Cloudflare AI Gateway ${gateway.name} is now the connection's own Cloudflare AI Gateway setting, with a copy of the gateway's token. As before, it uses the provider keys stored in Cloudflare. Rotating the token now means rotating it on each connection that went through ${gateway.name}.`,
      });
    } else if (gateway.type === "vercel") {
      const vercel = builtInProvider("vercel");
      if (vercel === null) return leaveOut("v2 has no Vercel AI Gateway type");
      description = vercel;
      typeChanged = true;
      modelPrefix = route.modelPrefix ?? V1_VERCEL_PREFIX[provider.type] ?? null;
      const blob = await reseal(gateway.secret_blob, gatewayToken, { kind: "providerKey", identity: [provider.organization_id, provider.id, "vercel", ""] });
      if (blob === null) return null;
      secretBlob = blob;
      secretHint = hint(gateway.secret_hint);
      if (route.providerOnly !== undefined && route.providerOnly.length > 0) servingProviders = JSON.stringify(route.providerOnly);
      report.push({
        kind: "changed",
        subject,
        what:
          `It was ${a(v1Description.label)} connection through Vercel AI Gateway (${gateway.name}). It is now a Vercel AI Gateway connection, with a copy of the gateway's token as its key, and its apps' operations are Vercel's of the same API style.` +
          (modelPrefix === null
            ? ""
            : ` v1 put ${modelPrefix} before every model name on the way out. v2 sends the model name as the app sends it, so an installed app that sends names without ${modelPrefix} is refused until it sends ${modelPrefix}<model>. The connection's prices, its apps' model lists and presets now use the full names.`),
      });
    } else {
      return leaveOut(`it went through a ${gateway.type} gateway, which v2 does not have`);
    }
  } else {
    if (provider.base_url !== null && provider.base_url !== "") {
      const placed = placeBaseUrl(v1Description, provider.base_url);
      if ("problem" in placed) return leaveOut(placed.problem);
      baseUrl = placed.baseUrl;
      if (placed.note !== undefined) report.push({ kind: "changed", subject, what: placed.note });
    }
    if (provider.secret_blob === null) return leaveOut("it holds no key");
    const blob = await reseal(
      provider.secret_blob,
      { kind: "providerKey", identity: [provider.organization_id, provider.id, provider.type, provider.base_url ?? ""] },
      { kind: "providerKey", identity: [provider.organization_id, provider.id, provider.type, baseUrl ?? ""] },
    );
    if (blob === null) return null;
    secretBlob = blob;
    secretHint = hint(provider.secret_hint);
    if (route.modelPrefix !== undefined || route.providerOnly !== undefined) {
      report.push({ kind: "changed", subject, what: "Its gateway route settings applied only through a provider gateway, and were left out." });
    }
  }

  return {
    id: provider.id,
    accountId: provider.organization_id,
    slug: provider.slug,
    description,
    v1Description: typeChanged ? v1Description : null,
    modelPrefix,
    subject: { kind: "builtIn", description, cloudflareGateway: cloudflare, baseUrl },
    listed: [],
    row: {
      id: provider.id,
      account_id: provider.organization_id,
      type: description.type,
      slug: provider.slug,
      name: provider.name,
      status: provider.status === "disabled" ? "disabled" : "active",
      secret_blob: secretBlob,
      secret_hint: secretHint,
      base_url: baseUrl,
      cloudflare_gateway_json: cloudflareJson,
      rates_json: movedRates(provider, description.type, modelPrefix, report, subject),
      passthrough_json: null,
      revision: 1,
      created_by: provider.created_by,
      created_at: createdAt,
      updated_at: v1TimeMs(provider.updated_at) ?? createdAt,
      serving_providers_json: servingProviders,
    },
  };
}

// ---------------------------------------------------------------- app routing

type V1PathEntry = string | { path: string; fixed_model?: string; clamp?: string; methods?: HttpMethod[] };

interface V1Policy {
  allowed_paths?: V1PathEntry[];
  allowed_models?: string[];
  max_output_tokens?: number;
}

/** Matchers for every built-in type, to tell another provider's API from a plain passthrough path. */
const MATCHERS = new Map(Object.values(BUILT_IN_PROVIDERS).map((description) => [description.type, new ProviderMatcher(description)]));

/** The operation of `to` that speaks the same API style as `name` on `from`, for a connection whose type changed. */
function sameStyleOperation(from: ProviderDescription, to: ProviderDescription, name: string): string | null {
  const style = from.operations.find((operation) => operation.name === name)?.style;
  if (style === undefined) return null;
  return to.operations.find((operation) => operation.style === style)?.name ?? null;
}

/** Tries to list `asked` on the connection, by the console's own save rules. Returns why not, or null when it is listed. */
function listPath(connection: MovedConnection, appId: string, asked: { method: HttpMethod; path: string }, report: ReportLine[]): string | null {
  const key = `${asked.method} ${asked.path}`;
  const existing = connection.listed.find((one) => `${one.asked.method} ${one.asked.path}` === key);
  if (existing !== undefined) {
    existing.apps.add(appId);
    return null;
  }
  try {
    passthroughJson(connection.subject, [...connection.listed.map((one) => one.asked), asked], []);
  } catch (error) {
    return reason(error);
  }
  connection.listed.push({ asked, apps: new Set([appId]) });
  // The safe defaults a first listing gets, said in the report.
  const alone = JSON.parse(passthroughJson(connection.subject, [asked], []).stored ?? "{}") as { paths?: { set_fields?: { name: string; value: unknown }[] }[] };
  const fields = alone.paths?.[0]?.set_fields ?? [];
  if (fields.length > 0) {
    report.push({
      kind: "changed",
      subject: `connection ${connection.slug} of account ${connection.accountId}`,
      what: `The listed path ${key} mints a short-lived secret, so it gets the safe defaults a new listing gets: ${fields.map((field) => `${field.name} = ${JSON.stringify(field.value)}`).join(", ")}. An app that asked for a longer-lived secret now gets one that expires sooner.`,
    });
  }
  return null;
}

/** One v1 provider policy as v2 routing, or null when nothing in it can be served. */
function routeFor(app: V1App, slug: string, policy: V1Policy, connection: MovedConnection, report: ReportLine[]): AppConfig["routing"]["providers"][string] | null {
  const subject = `app ${app.id}`;
  const v1Description = connection.v1Description ?? connection.description;
  const ownMatcher = MATCHERS.get(v1Description.type)!;
  const operations = new Set<string>();
  const paths = policy.allowed_paths ?? [];
  if (paths.length === 0) {
    for (const operation of v1Description.operations) operations.add(operation.name);
    report.push({
      kind: "changed",
      subject,
      what: `On ${slug}, v1 allowed every API it serves. v2 names each: it now allows every operation of ${v1Description.label} (${v1Description.operations.length}), and no passthrough path.`,
    });
  }
  for (const entry of paths) {
    const path = plainPath(typeof entry === "string" ? entry : entry.path);
    const methods: readonly HttpMethod[] = (typeof entry === "string" ? undefined : entry.methods) ?? ["POST"];
    if (typeof entry !== "string" && entry.fixed_model !== undefined) {
      report.push({
        kind: "changed",
        subject,
        what: `On ${slug}, v1 sent every request to ${path} with the model ${entry.fixed_model}. v2 has no fixed model per path: the model the request names is used. To keep the app on one model, list only that model for ${slug}.`,
      });
    }
    for (const method of methods) {
      const line = `${method} ${path}`;
      const matched = ownMatcher.match(method, samplePath(path));
      if (matched.kind === "operation") {
        operations.add(matched.operation.name);
        continue;
      }
      // Another provider's API on this connection: v2 serves each type's own operations only (plan 9.1).
      const other = [...MATCHERS].find(([type, matcher]) => type !== v1Description.type && matcher.match(method, samplePath(path)).kind === "operation");
      if (other !== undefined) {
        report.push({
          kind: "left_out",
          subject,
          what: `On ${slug}, the path ${line} was not moved: it is ${BUILT_IN_PROVIDERS[other[0]]!.label}'s API, which v2 does not serve on ${a(v1Description.label)} connection. Requests to it are refused with path_not_allowed.`,
        });
        continue;
      }
      const problem = listPath(connection, app.id, { method, path }, report);
      if (problem !== null) {
        report.push({ kind: "left_out", subject, what: `On ${slug}, the passthrough path ${line} was not moved: ${problem}. Requests to it are refused with path_not_allowed.` });
        continue;
      }
      operations.add(PASSTHROUGH);
    }
  }
  // A connection whose type changed (Vercel AI Gateway): the same API styles on the new type.
  const moved = [...operations].flatMap((name) => {
    if (name === PASSTHROUGH || connection.v1Description === null) return [name];
    const counterpart = sameStyleOperation(connection.v1Description, connection.description, name);
    if (counterpart === null) {
      report.push({ kind: "left_out", subject, what: `On ${slug}, the operation ${name} has no counterpart on ${connection.description.label}, and was not moved.` });
      return [];
    }
    return [counterpart];
  });
  const unique = [...new Set(moved)];
  if (unique.length === 0) {
    report.push({ kind: "left_out", subject, what: `On ${slug}, nothing v1 allowed can be served in v2, so the app no longer reaches ${slug}.` });
    return null;
  }
  const models = [...new Set((policy.allowed_models ?? []).map((model) => wireModel(connection, model.trim())).filter((model) => model !== ""))];
  return {
    operations: unique,
    ...(models.length > 0 ? { models } : {}),
    ...(policy.max_output_tokens !== undefined ? { max_output_tokens: policy.max_output_tokens } : {}),
  };
}

// ---------------------------------------------------------------- presets

interface V1Endpoint {
  provider: string;
  model: string;
  api_style: string;
  params?: Record<string, unknown>;
  max_output_tokens?: number;
  fallback?: { provider: string; model: string }[];
}

function presetsFor(app: V1App, endpoints: Record<string, V1Endpoint>, connections: ReadonlyMap<string, MovedConnection>, report: ReportLine[]): NonNullable<AppConfig["presets"]> {
  const subject = `app ${app.id}`;
  const presets: NonNullable<AppConfig["presets"]> = {};
  for (const [slug, endpoint] of Object.entries(endpoints)) {
    const style = STYLE_OF_ENDPOINT[endpoint.api_style];
    if (style === undefined) {
      report.push({ kind: "left_out", subject, what: `The endpoint ${slug} speaks ${endpoint.api_style}, which v2 presets do not, and was not moved. Calls to it are refused with preset_not_found.` });
      continue;
    }
    const target = (provider: string): { connection: MovedConnection; operation: string } | string => {
      const connection = connections.get(provider);
      if (connection === undefined) return `the connection ${provider} was not moved`;
      const operation = presetOperation(connection.description, style, undefined);
      if (operation === null) return `${connection.description.label} has no ${style} operation a preset can use`;
      return { connection, operation: operation.name };
    };
    const main = target(endpoint.provider);
    if (typeof main === "string") {
      report.push({ kind: "left_out", subject, what: `The endpoint ${slug} was not moved: ${main}. Calls to it are refused with preset_not_found.` });
      continue;
    }
    const fallback = (endpoint.fallback ?? []).flatMap((one) => {
      const found = target(one.provider);
      if (typeof found === "string") {
        report.push({ kind: "changed", subject, what: `The endpoint ${slug}'s fallback to ${one.provider} (${one.model}) was dropped: ${found}.` });
        return [];
      }
      return [{ provider: one.provider, model: wireModel(found.connection, one.model) }];
    });
    presets[slug] = {
      provider: endpoint.provider,
      operation: main.operation,
      model: wireModel(main.connection, endpoint.model),
      ...(endpoint.params !== undefined && Object.keys(endpoint.params).length > 0 ? { params: endpoint.params } : {}),
      ...(endpoint.max_output_tokens !== undefined ? { max_output_tokens: endpoint.max_output_tokens } : {}),
      ...(fallback.length > 0 ? { fallback } : {}),
    };
  }
  return presets;
}

// ---------------------------------------------------------------- apps

interface V1Scope {
  requests?: { per_minute?: number | null; per_day?: number | null };
  spending?: { monthly_usd?: number | null; scope?: string };
}

/** A v1 limit scope as v2 writes it: the budget in whole nano-dollars, its scope only when not the default. */
function limitScope(scope: V1Scope | undefined, defaultScope: string | null): Record<string, unknown> {
  const usd = scope?.spending?.monthly_usd ?? null;
  const budgetScope = scope?.spending?.scope;
  return {
    requests: { per_minute: scope?.requests?.per_minute ?? null, per_day: scope?.requests?.per_day ?? null },
    spending: {
      monthly_nano: usd === null ? null : Math.round(usd * 1_000_000_000),
      ...(budgetScope !== undefined && budgetScope !== defaultScope ? { scope: budgetScope } : {}),
    },
  };
}

function convertApp(app: V1App, connections: ReadonlyMap<string, MovedConnection>, leftOut: ReadonlySet<string>, report: ReportLine[]): AppConfig | null {
  const subject = `app ${app.id}`;
  let v1: Record<string, unknown>;
  try {
    v1 = JSON.parse(app.config_json) as Record<string, unknown>;
  } catch {
    report.push({ kind: "left_out", subject, what: "Not moved: its settings could not be read. Its app keys stop working." });
    return null;
  }
  const authentication = v1.authentication as { type?: string } | undefined;
  const routing = (v1.routing ?? {}) as { providers?: { mode?: string; selected?: Record<string, V1Policy> }; model_rewrites?: Record<string, string> };
  const providers: Record<string, unknown> = {};
  if (routing.providers?.mode === "all") {
    for (const [slug, connection] of connections) providers[slug] = { operations: connection.description.operations.map((operation) => operation.name) };
    report.push({
      kind: "changed",
      subject,
      what: `v1 let it reach every connection of its account. v2 names each one: it now allows every operation of ${connections.size === 0 ? "no connection" : [...connections.keys()].join(", ")}. A connection added later is not allowed until you allow it.`,
    });
  } else {
    for (const [slug, policy] of Object.entries(routing.providers?.selected ?? {})) {
      const connection = connections.get(slug);
      if (connection === undefined) {
        // A connection left out is reported once, with the reason; a slug v1 never had needs a line of its own.
        if (!leftOut.has(slug)) report.push({ kind: "changed", subject, what: `It allowed ${slug}, which no connection of its account has. That entry was left out.` });
        continue;
      }
      const route = routeFor(app, slug, policy, connection, report);
      if (route !== null) providers[slug] = route;
    }
  }
  const presets = presetsFor(app, (v1.endpoints ?? {}) as Record<string, V1Endpoint>, connections, report);
  const rewrites = routing.model_rewrites ?? {};
  const limits = (v1.limits ?? {}) as { per_user?: V1Scope; per_app?: V1Scope };
  const config = {
    authentication: v1.authentication,
    routing: { providers, ...(Object.keys(rewrites).length > 0 ? { model_rewrites: rewrites } : {}) },
    limits: {
      per_user: limitScope(limits.per_user, authentication?.type === "apple_app_attest" ? "apple_account" : "user"),
      per_app: limitScope(limits.per_app, null),
    },
    ...(Object.keys(presets).length > 0 ? { presets } : {}),
  };
  const parsed = AppConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    report.push({ kind: "left_out", subject, what: `Not moved: its settings do not fit v2 (${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}). Its app keys stop working.` });
    return null;
  }
  const conversations = ConversationsConfigSchema.safeParse(v1.conversations ?? {});
  if (!conversations.success) {
    report.push({ kind: "changed", subject, what: "Its conversation storage settings could not be read, so v2 does not store its conversations. Turn storage on again in the console." });
    return parsed.data;
  }
  return conversationsAreDefault(conversations.data) ? parsed.data : { ...parsed.data, conversations: conversations.data };
}

// ---------------------------------------------------------------- the run

/** Builds every v2 settings row from v1's, and the report of what changed. */
export async function migrateSettings(v1: V1Settings, options: MigrationOptions): Promise<MigrationResult> {
  const report: ReportLine[] = [];
  const rows = Object.fromEntries(TABLE_ORDER.map((table) => [table, [] as Row[]])) as V2Rows;
  const now = options.now.getTime();
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  // Accounts. An unclaimed one has no owner in v2.
  const kept = new Set<string>();
  for (const account of v1.accounts) {
    if (account.expires_at !== null && account.expires_at !== "") {
      report.push({ kind: "left_out", subject: `account ${account.id}`, what: `Not moved: it was never claimed (a temporary CLI account, ending ${account.expires_at}). Its apps and connections are not moved either.` });
      continue;
    }
    kept.add(account.id);
    rows.mgmt_organization.push({ id: account.id, name: account.name, created_by_user_id: account.created_by_user_id, created_at: account.created_at, updated_at: account.updated_at });
  }

  // People: those a moved account names.
  const named = new Set<string>();
  for (const account of v1.accounts) if (kept.has(account.id)) named.add(account.created_by_user_id);
  for (const member of v1.members) if (kept.has(member.organization_id)) named.add(member.user_id);
  let unnamed = 0;
  for (const user of v1.users) {
    if (!named.has(user.id)) {
      unnamed += 1;
      continue;
    }
    rows.mgmt_user.push({ id: user.id, name: user.name, email: user.email, kind: user.kind, email_verified: user.email_verified, image: user.image, created_at: user.created_at, updated_at: user.updated_at });
  }
  if (unnamed > 0) report.push({ kind: "left_out", subject: "people", what: `${count(unnamed, "person or service identity belongs", "people and service identities belong")} to no moved account, and ${unnamed === 1 ? "was" : "were"} not moved.` });
  const users = new Set(rows.mgmt_user.map((user) => user.id as string));
  const known = (id: string | null) => (id !== null && users.has(id) ? id : null);

  for (const member of v1.members) {
    if (!kept.has(member.organization_id) || !users.has(member.user_id)) continue;
    rows.mgmt_organization_user.push({ id: member.id, organization_id: member.organization_id, user_id: member.user_id, role: member.role, status: member.status, joined_at: member.joined_at, last_active_at: member.last_active_at });
  }

  let closed = 0;
  for (const invitation of v1.invitations) {
    if (!kept.has(invitation.organization_id)) continue;
    if (invitation.response !== null || (v1TimeMs(invitation.expires_at) ?? 0) <= now) {
      closed += 1;
      continue;
    }
    rows.mgmt_organization_invitation.push({
      id: invitation.id,
      organization_id: invitation.organization_id,
      email: invitation.email,
      role: invitation.role,
      token_hash: invitation.token_hash,
      invited_by_user_id: known(invitation.invited_by_user_id),
      created_at: invitation.created_at,
      expires_at: invitation.expires_at,
      response: null,
      responded_at: null,
      responded_by_user_id: null,
    });
  }
  if (closed > 0) report.push({ kind: "left_out", subject: "invitations", what: `${count(closed, "invitation was", "invitations were")} answered or had ended, and ${closed === 1 ? "was" : "were"} not moved.` });

  let googleTokens = 0;
  for (const login of v1.logins) {
    if (!users.has(login.user_id)) continue;
    const tokens = login as unknown as Record<string, unknown>;
    if (tokens.access_token != null || tokens.refresh_token != null || tokens.id_token != null) googleTokens += 1;
    rows.mgmt_user_account.push({
      id: login.id,
      account_id: login.account_id,
      provider_id: login.provider_id,
      user_id: login.user_id,
      access_token: null,
      refresh_token: null,
      id_token: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
      scope: null,
      password: login.password,
      created_at: login.created_at,
      updated_at: login.updated_at,
    });
  }
  if (googleTokens > 0) report.push({ kind: "changed", subject: "sign-ins", what: `${count(googleTokens, "Google sign-in was", "Google sign-ins were")} moved without Google's own tokens, which v2 does not use. Everyone signs in once more in any case: sessions do not move.` });

  // Management keys made in the console move. CLI sign-ins, the CLI's own keys and MCP connections sign in to v2 once more.
  const signIns = new Map<string, number>();
  for (const key of v1.managementKeys) {
    if (!kept.has(key.organization_id) || !users.has(key.user_id)) continue;
    if (key.credential_type !== "apiKey" || key.client_id !== null || key.resource !== null || key.source !== "console") {
      const what = key.credential_type !== "apiKey" || key.client_id !== null ? "MCP or CLI connection" : key.source === "cli" ? "CLI sign-in key" : `${key.source} key`;
      signIns.set(what, (signIns.get(what) ?? 0) + 1);
      continue;
    }
    rows.mgmt_api_key.push({
      id: key.id,
      user_id: key.user_id,
      organization_id: key.organization_id,
      name: key.name,
      token_hash: key.token_hash,
      token_hint: key.token_hint,
      enabled: key.enabled,
      expires_at: key.expires_at,
      created_at: key.created_at,
      revoked_at: key.revoked_at,
      source: key.source,
      label: key.label,
      grant: key.grant,
      client_id: null,
      resource: null,
      credential_type: key.credential_type,
    });
  }
  for (const [what, n] of signIns) {
    report.push({ kind: "left_out", subject: "CLI and MCP sign-ins", what: `${n} ${what}${n === 1 ? " was" : "s were"} not moved: each signs in to v2 once more (agw 2.0 cannot use a v1 sign-in anyway).` });
  }

  // Connections.
  const gateways = new Map(v1.gateways.map((gateway) => [gateway.id, gateway]));
  const connections = new Map<string, Map<string, MovedConnection>>();
  const leftOut = new Map<string, Set<string>>();
  for (const provider of v1.providers) {
    if (!kept.has(provider.organization_id)) continue;
    const moved = await moveConnection(provider, gateways, options, report);
    const into = <T>(map: Map<string, T>, make: () => T) => map.get(provider.organization_id) ?? map.set(provider.organization_id, make()).get(provider.organization_id)!;
    if (moved === null) into(leftOut, () => new Set<string>()).add(provider.slug);
    else into(connections, () => new Map<string, MovedConnection>()).set(moved.slug, moved);
  }

  // Apps.
  const apps = new Map<string, { accountId: string; config: AppConfig }>();
  for (const app of v1.apps) {
    if (!kept.has(app.organization_id)) continue;
    const config = convertApp(app, connections.get(app.organization_id) ?? new Map(), leftOut.get(app.organization_id) ?? new Set(), report);
    if (config === null) continue;
    apps.set(app.id, { accountId: app.organization_id, config });
    const createdAt = v1TimeMs(app.created_at) ?? now;
    rows.app.push({
      id: app.id,
      account_id: app.organization_id,
      name: app.name,
      config_json: JSON.stringify(config),
      revision: 1,
      status: app.status === "disabled" ? "disabled" : "active",
      created_at: createdAt,
      updated_at: v1TimeMs(app.updated_at) ?? createdAt,
    });
  }

  // Each connection's listed paths, now that every app has added its own, and who else can now reach them.
  for (const account of connections.values()) {
    for (const connection of account.values()) {
      if (connection.listed.length > 0) {
        connection.row.passthrough_json = passthroughJson(connection.subject, connection.listed.map((one) => one.asked), []).stored;
        const allowing = [...apps]
          .filter(([, app]) => app.accountId === connection.accountId && (app.config.routing.providers[connection.slug]?.operations ?? []).includes(PASSTHROUGH))
          .map(([id]) => id);
        for (const { asked, apps: listedBy } of connection.listed) {
          const widened = allowing.filter((id) => !listedBy.has(id));
          if (widened.length === 0) continue;
          report.push({
            kind: "check",
            subject: `connection ${connection.slug} of account ${connection.accountId}`,
            what: `The path ${asked.method} ${asked.path}, listed in v1 by ${[...listedBy].join(", ")}, can now be reached by ${widened.join(", ")} too: v2 lists paths per connection, with one passthrough switch per app. To keep them apart, give those apps a connection of their own.`,
          });
        }
      }
      rows.provider_connection.push(connection.row);
    }
  }

  for (const key of v1.appKeys) {
    if (!apps.has(key.app_id)) continue;
    rows.app_key.push({
      id: key.id,
      app_id: key.app_id,
      name: key.name,
      key_hash: key.key_hash,
      key_prefix: key.key_prefix,
      status: key.status === "revoked" ? "revoked" : "active",
      created_at: v1TimeMs(key.created_at) ?? now,
      last_used_at: v1TimeMs(key.last_used_at),
    });
  }
  let unknownEnvironment = 0;
  for (const key of v1.attestKeys) {
    if (!apps.has(key.app_id)) continue;
    if (key.environment !== "production" && key.environment !== "development") {
      unknownEnvironment += 1;
      continue;
    }
    const createdAt = v1TimeMs(key.created_at) ?? now;
    rows.app_attest_key.push({ app_id: key.app_id, key_id: key.key_id, public_key: key.public_key, environment: key.environment, user_id: key.user_id, created_at: createdAt, last_seen_at: v1TimeMs(key.last_seen_at) ?? createdAt });
  }
  if (unknownEnvironment > 0) report.push({ kind: "left_out", subject: "App Attest keys", what: `${count(unknownEnvironment, "key names", "keys name")} an environment v2 does not know. Those installs attest again.` });

  // Every app id v1 gave out that v2 does not hold, so v2 never gives it out again.
  const retired = new Set<string>([...v1.historyAppIds, ...v1.apps.map((app) => app.id)]);
  for (const id of [...retired].sort()) if (!apps.has(id)) rows.retired_app_id.push({ id, retired_at: now });

  return { rows, report, apps };
}
