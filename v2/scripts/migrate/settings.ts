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
 * - Whenever v2 cannot express exactly what v1 allowed, or cannot send to
 *   exactly the same URL (`addresses`), that route, path, preset or
 *   connection is left out and reported. Nothing is approximated: the owner
 *   adds it back by hand after reading the report.
 * - Traffic and keys keep their destination. A base URL v2 cannot hold as it
 *   is, a Cloudflare AI Gateway URL with no Cloudflare token to go with it,
 *   or a gateway token of another account leaves the connection out, and the
 *   report says so. Nothing ever goes direct that went through a gateway, or
 *   to another host.
 * - Access never widens silently. An app reaches in v2 what it reached in v1:
 *   with no paths listed, v1's default API styles and its type's own
 *   endpoints (`./v1-defaults.ts`), never live sessions. Where v2 cannot
 *   draw the same line (one model list per connection, paths listed per
 *   connection), the report names the exact difference.
 * - An app's allowed paths become operations. A path no operation serves
 *   becomes a passthrough path on the connection, judged by the same rules
 *   as a save in the console (`passthroughJson`), with the safe defaults a
 *   new listing gets. v2 lists paths per connection, so a path one app listed
 *   becomes reachable by every app on that connection that allows
 *   passthrough: reported as a widening.
 * - Budgets move from dollars to whole nano-dollars, and a budget above zero
 *   stays above zero.
 *
 * Lines that need a decision before the SQL is applied are marked `first`:
 * every row left out, every widened access, and every change that makes an
 * installed app fail.
 */
import { AppConfigSchema, ConversationsConfigSchema, conversationsAreDefault, type AppConfig } from "../../src/contracts/app-config.ts";
import { ModelPricingSchema } from "../../src/contracts/admin.ts";
import { checkCloudflareIds, checkDestination, checkedBaseUrl, passthroughJson, ratesFromPricing, type ListingSubject } from "../../src/admin/providers.ts";
import { keyOrigin, type ConnectionRecord } from "../../src/providers/connections.ts";
import { declaredHostNames, hostMatches, knownHostOwner } from "../../src/providers/custom.ts";
import { BUILT_IN_PROVIDERS, builtInProvider } from "../../src/providers/index.ts";
import { ProviderMatcher } from "../../src/providers/matcher.ts";
import type { ApiStyle, HttpMethod, OperationDescription, ProviderDescription } from "../../src/providers/operation.ts";
import { PASSTHROUGH } from "../../src/providers/passthrough.ts";
import { presetOperationProblem } from "../../src/providers/presets.ts";
import { upstreamUrl } from "../../src/providers/route.ts";
import {
  V1_CLOUDFLARE_BASE,
  V1_CLOUDFLARE_ROUTES,
  V1_DEFAULT_STYLES,
  V1_DIRECT_BASE_URL,
  V1_ENDPOINT_PATHS,
  V1_STYLE_PATHS,
  V1_TYPE_DEFAULTS,
  V1_VERCEL_BASE,
  V1_VERCEL_STYLES,
  V2_CAPS_OF_CLAMP,
  V2_STYLE_OF,
} from "./v1-defaults.ts";
import type { V1App, V1Gateway, V1Provider, V1Settings } from "./v1-rows.ts";

/** One line of the report. */
export interface ReportLine {
  /** `left_out`: not moved. `changed`: moved, but not as v1 held it. `check`: moved, but worth a look before release. */
  readonly kind: "left_out" | "changed" | "check";
  /** What it is about, such as `app chat-a1b2` or `account org_1`. */
  readonly subject: string;
  readonly what: string;
  /** Read before applying: a widened access, or a change that makes an installed app fail. Every `left_out` line is read first too. */
  readonly first?: true;
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

/**
 * Opens a v1 blob and seals its secret for v2. The secret itself never leaves
 * this call. Throws `SecretDoesNotOpen` when the blob does not open under its
 * row's context (the row is left out); any other error stops the run.
 */
export type Resealer = (blob: string, from: V1Sealed, to: V2Sealed) => Promise<string>;

/** A v1 blob that does not open under its row's context: that row's problem alone. */
export class SecretDoesNotOpen extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretDoesNotOpen";
  }
}

export interface MigrationOptions {
  /** The moment the run counts as now: invitations still open, and the time ids are retired. */
  readonly now: Date;
  readonly reseal: Resealer;
}

export interface MigrationResult {
  readonly rows: V2Rows;
  readonly report: ReportLine[];
  /** Each moved app's v2 settings and account, for v2's own save checks (`checkAgainstV2` in `./output.ts`). */
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

/** A v1 budget in dollars as whole nano-dollars: one above zero stays above zero (the table map's one-nano-dollar minimum). */
export function budgetNano(usd: number | null): number | null {
  if (usd === null) return null;
  if (usd <= 0) return 0;
  return Math.max(1, Math.round(usd * 1_000_000_000));
}

/** A gateway error's message without its field prefix, for the report. */
function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^[a-zA-Z.0-9_]+: /u, "");
}

/** A name with its article: "an OpenAI", "a Gemini". */
function a(name: string): string {
  return `${/^[AEIOU]/u.test(name) ? "an" : "a"} ${name}`;
}

function list(values: Iterable<string>): string {
  return [...values].join(", ");
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
 * The model namespace v1 put before every model name on Vercel AI Gateway, per
 * provider type (v1's `VERCEL_ROUTES`). A row could name its own instead. A
 * type with none could not go through Vercel in v1.
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

/** A path as v2 lists it: no leading `/`. */
function plainPath(path: string): string {
  return path.trim().replace(/^\/+/u, "");
}

/** A `{name}` part other than `{model}`: v1 matched it as that literal text, never as a wildcard. */
const LITERAL_PART = /\{(?!model\})[^}/]*\}/u;

/** A sample value in each `{model}` part, so a listed v1 path can be matched as a request would be. */
function samplePath(path: string): string {
  return path.replaceAll("{model}", "sample");
}

// ---------------------------------------------------------------- where requests go

/**
 * Where v1 sent a row's requests: to its base URL or its type's own address,
 * through Cloudflare AI Gateway, or through Vercel AI Gateway.
 */
type V1Destination =
  | { readonly kind: "direct"; readonly base: string }
  | { readonly kind: "cloudflare"; readonly accountId: string; readonly gatewayId: string; readonly slug: string; readonly stripPathPrefix?: string }
  | { readonly kind: "vercel" };

/** The URL v1 sent a request for `path` to, built as v1's route adapters built it. */
function v1Url(destination: V1Destination, path: string): string {
  switch (destination.kind) {
    case "direct":
      return `${destination.base}${path}`;
    case "cloudflare": {
      const prefix = destination.stripPathPrefix;
      const adapted = prefix !== undefined && path.startsWith(prefix) ? path.slice(prefix.length) : path;
      return [V1_CLOUDFLARE_BASE, encodeURIComponent(destination.accountId), encodeURIComponent(destination.gatewayId), destination.slug, adapted].join("/");
    }
    case "vercel":
      return `${V1_VERCEL_BASE}${path}`;
  }
}

/** v1's stored base URL ends in `/` (v1's origin guard): one stored otherwise is read the way v1 joined it. */
function v1Base(raw: string): string {
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/** A `{name}` or `{name...}` part filled with a value a request could send: a fixed list's first entry, the model where given, else `sample`. */
function filledPath(operation: OperationDescription, model = "sample"): string {
  return operation.match.path.replace(/\{([^}.]+)(\.\.\.)?\}/gu, (_whole, name: string, multi: string | undefined) => {
    const list = operation.multiSegment?.[name];
    if (multi !== undefined && Array.isArray(list) && list.length > 0) return list[0]!;
    return operation.model.in === "path" && operation.model.part === name ? model : "sample";
  });
}

// ---------------------------------------------------------------- connections

interface MovedConnection {
  readonly id: string;
  readonly accountId: string;
  readonly slug: string;
  readonly description: ProviderDescription;
  /** v1's type, when the connection's type changed (a row routed through Vercel AI Gateway). */
  readonly v1Description: ProviderDescription | null;
  /** What v1 put before every model name on the way out (Vercel AI Gateway); v2 sends the name as the app sends it. */
  readonly modelPrefix: string | null;
  /** v1's row had a base URL of its own on another host than the provider's: v1 sent every API style there, and it may have answered. */
  readonly hadBaseUrl: boolean;
  /** Where v1 sent this row's requests. */
  readonly v1: V1Destination;
  /** What v2's address rules read of the connection (`upstreamUrl`). */
  readonly record: ConnectionRecord;
  readonly matcher: ProviderMatcher;
  readonly subject: ListingSubject & { readonly kind: "builtIn" };
  /** Paths apps listed in v1, accepted for this connection, with the apps that listed each. */
  readonly listed: { readonly asked: { method: HttpMethod; path: string }; readonly apps: Set<string> }[];
  readonly row: Row;
}

/** The URL v2 sends a request to, or null when it sends none (`upstreamUrl` refuses). */
function v2Url(connection: MovedConnection, hostKey: string, path: string, passthrough: boolean): string | null {
  try {
    // As the Worker sends it (`sendAttempt` in `src/proxy/serve.ts`): the matcher's path without its leading `/`.
    return upstreamUrl(connection.record, connection.description, { hostKey, path: path.replace(/^\//u, ""), query: "", passthrough });
  } catch {
    return null;
  }
}

/** Where a request for `path` goes in v1 and in v2, and the operation v2 serves it with, if any. */
function addresses(connection: MovedConnection, path: string, method: HttpMethod = "POST"): { readonly v1: string; readonly v2: string | null; readonly operation: OperationDescription | null; readonly parts: Readonly<Record<string, string>> } {
  const matched = connection.matcher.match(method, path);
  if (matched.kind !== "operation") return { v1: v1Url(connection.v1, path), v2: null, operation: null, parts: {} };
  return { v1: v1Url(connection.v1, path), v2: v2Url(connection, matched.upstream.host, matched.upstream.path, false), operation: matched.operation, parts: matched.parts };
}

/** A model name as v1 put it on the wire, which v2 sends as the app names it: v1's rule exactly, the prefix always added. */
function wireModel(connection: MovedConnection, model: string): string {
  return connection.modelPrefix === null ? model : `${connection.modelPrefix}${model}`;
}

/** An account's active Cloudflare AI Gateway rows, with their ids. */
type CloudflareGateways = readonly { readonly gateway: V1Gateway; readonly ids: { accountId: string; gatewayId: string } }[];

type Placement =
  | { readonly kind: "keep"; readonly baseUrl: string; readonly note?: string }
  | { readonly kind: "cloudflare"; readonly gateway: V1Gateway; readonly ids: { accountId: string; gatewayId: string } }
  | { readonly kind: "problem"; readonly what: string };

/** Whether v2 takes `baseUrl` for `description` as it is. */
function accepted(description: ProviderDescription, baseUrl: string): string | null {
  try {
    checkDestination(description, checkedBaseUrl(baseUrl), null);
    return null;
  } catch (error) {
    return reason(error);
  }
}

/** A URL with nothing but scheme, host and path: https, no port, user, query or fragment. */
function plainHttps(url: URL): boolean {
  return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}

/**
 * Where a v1 base URL leaves a connection. The host never changes, and each
 * route later keeps only the requests whose whole URL stays the same
 * (`addresses`):
 * - on Cloudflare AI Gateway, the same gateway through the connection's
 *   Cloudflare setting, when the account holds that gateway's token;
 * - elsewhere, the URL as it is, or, on the provider's own declared host,
 *   that host's plain address, which v2 takes in its place;
 * - otherwise the connection is left out.
 */
function placeBaseUrl(description: ProviderDescription, raw: string, cloudflare: CloudflareGateways): Placement {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "problem", what: `its base URL ${raw} is not a URL` };
  }
  if (url.hostname.toLowerCase() === CLOUDFLARE_HOST) {
    if (!plainHttps(url)) return { kind: "problem", what: `its base URL ${raw} goes to Cloudflare AI Gateway with a port, a query, a fragment or credentials, or without https, which v2's Cloudflare setting cannot carry` };
    const [version, accountId, gatewayId, slug, ...rest] = url.pathname.split("/").filter((piece) => piece !== "");
    const own = description.cloudflareGateway?.slug;
    if (own === undefined) return { kind: "problem", what: `its base URL ${raw} goes through Cloudflare AI Gateway, which v2 does not offer for ${description.label}` };
    if (version !== "v1" || accountId === undefined || gatewayId === undefined || slug !== own || rest.length > 0) {
      return {
        kind: "problem",
        what: `its base URL ${raw} goes to Cloudflare AI Gateway's ${slug ?? "unnamed"} endpoint${rest.length > 0 ? " with more path after it" : ""}, not the ${own} one v2's Cloudflare setting reaches for ${description.label}`,
      };
    }
    const ids = { accountId: decodeURIComponent(accountId), gatewayId: decodeURIComponent(gatewayId) };
    try {
      checkCloudflareIds(ids, null);
      checkDestination(description, null, ids);
    } catch (error) {
      return { kind: "problem", what: `v2 does not take the Cloudflare AI Gateway its base URL ${raw} names (${reason(error)})` };
    }
    const match = cloudflare.find((one) => one.ids.accountId === ids.accountId && one.ids.gatewayId === ids.gatewayId);
    if (match === undefined) {
      return {
        kind: "problem",
        what: `its base URL ${raw} goes through Cloudflare AI Gateway ${ids.gatewayId}. v2 goes through Cloudflare only with a Cloudflare token, and the account holds none for that gateway. Add the connection again with its Cloudflare AI Gateway setting and a token`,
      };
    }
    return { kind: "cloudflare", gateway: match.gateway, ids };
  }
  const refused = accepted(description, raw);
  if (refused === null) return { kind: "keep", baseUrl: checkedBaseUrl(raw) };
  // On the provider's own declared host, v2 takes only that host's plain address (`baseUrlProblem`).
  const host = url.hostname.toLowerCase();
  if (declaredHostNames(description).some((name) => hostMatches(name, host)) && plainHttps(url)) {
    const declared = Object.values(description.hosts).find((entry) => entry.split("/")[0]!.toLowerCase() === host);
    const plain = declared !== undefined ? `/${declared.slice(declared.split("/")[0]!.length + 1)}`.replace(/\/?$/u, "/") : "/";
    const address = `${url.origin}${plain}`;
    if (address !== raw && accepted(description, address) === null) {
      return { kind: "keep", baseUrl: checkedBaseUrl(address), note: `Its base URL ${raw} is now ${address}, the plain address of the same host, which v2 takes in its place (${refused}). Only requests whose whole URL stays the same are allowed: see each app's line.` };
    }
  }
  const owner = knownHostOwner(raw);
  if (owner !== null && owner.type !== description.type) {
    return { kind: "problem", what: `its base URL ${raw} is on ${owner.label}'s host. v2 does not send ${a(description.label)} connection's key there. Add it again as ${a(owner.label)} connection` };
  }
  return { kind: "problem", what: `v2 does not take its base URL ${raw} (${refused}), and its key is not sent anywhere else. Add the connection again in the console` };
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

/**
 * A v1 connection's own prices as v2 rates, model by model, under the model
 * names v2 sees. One v2 refuses is left out and reported, and so are two that
 * would land on one name: neither silently wins.
 */
function movedRates(provider: V1Provider, type: string, prefix: string | null, report: ReportLine[], subject: string): string | null {
  if (provider.pricing_json === null || provider.pricing_json === "") return null;
  let pricing: Record<string, unknown>;
  try {
    pricing = JSON.parse(provider.pricing_json) as Record<string, unknown>;
  } catch {
    report.push({ kind: "changed", subject, what: "Its own prices could not be read, and were left out. The price list applies instead." });
    return null;
  }
  const byName = new Map<string, string[]>();
  for (const v1Model of Object.keys(pricing)) {
    const model = (prefix === null ? v1Model : `${prefix}${v1Model}`).trim();
    byName.set(model, [...(byName.get(model) ?? []), v1Model]);
  }
  const rates: Record<string, unknown> = {};
  for (const [model, sources] of byName) {
    if (sources.length > 1) {
      report.push({ kind: "changed", subject, what: `Its own prices for ${list(sources.map((name) => JSON.stringify(name)))} all name ${JSON.stringify(model)} in v2, so none of them was kept. The price list applies to that model, if it lists it.`, first: true });
      continue;
    }
    const v1Model = sources[0]!;
    const parsed = ModelPricingSchema.safeParse(pricing[v1Model]);
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
  cloudflare: CloudflareGateways,
  options: MigrationOptions,
  report: ReportLine[],
): Promise<MovedConnection | null> {
  const subject = `connection ${provider.slug} (${provider.id}) of account ${provider.organization_id}`;
  const leaveOut = (what: string): null => {
    report.push({ kind: "left_out", subject, what: `Not moved: ${what}. Each app that allowed ${provider.slug} loses it: see the app's own line.` });
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
      // Anything but a blob that does not open stops the run: say which row it stopped on.
      if (!(error instanceof SecretDoesNotOpen)) throw new Error(`${subject}, ${from.kind === "providerKey" ? "its key" : `gateway ${from.identity[1]}'s token`}: ${(error as Error).message}`, { cause: error });
      leaveOut(`its ${from.kind === "providerKey" ? "key" : "gateway token"} does not open with v1's vault (${error.message})`);
      return null;
    }
  };

  let description = v1Description;
  let typeChanged = false;
  let modelPrefix: string | null = null;
  let secretBlob: string | null = null;
  let secretHint: string | null = null;
  let baseUrl: string | null = null;
  let ids: { accountId: string; gatewayId: string } | null = null;
  let cloudflareJson: string | null = null;
  let servingProviders: string | null = null;
  let v1: V1Destination = { kind: "direct", base: V1_DIRECT_BASE_URL[provider.type] ?? "" };
  const sealToken = async (gateway: V1Gateway): Promise<string | null> => {
    const blob = await reseal(gateway.secret_blob, { kind: "providerGatewayToken", identity: [gateway.organization_id, gateway.id] }, { kind: "cloudflareGatewayToken", identity: [provider.organization_id, provider.id] });
    return blob === null ? null : JSON.stringify({ account_id: ids!.accountId, gateway_id: ids!.gatewayId, token_blob: blob, token_hint: hint(gateway.secret_hint) });
  };

  if (provider.provider_gateway_id !== null) {
    const gateway = gateways.get(provider.provider_gateway_id);
    if (gateway === undefined) return leaveOut(`it went through a provider gateway (${provider.provider_gateway_id}) v1 no longer holds`);
    // v1 opened a gateway token under the calling account's context, so a row could never use another account's gateway.
    if (gateway.organization_id !== provider.organization_id) return leaveOut(`it names provider gateway ${gateway.id} of another account (${gateway.organization_id}), which v1 could not open for it either`);
    if (gateway.status !== "active") return leaveOut(`it went through a revoked provider gateway (${gateway.name})`);
    if (gateway.type === "cf_aig") {
      const v1Route = V1_CLOUDFLARE_ROUTES[provider.type];
      if (v1Route === undefined) return leaveOut(`v1 could not send ${a(v1Description.label)} row through Cloudflare AI Gateway, so it served nothing`);
      if (v1Description.cloudflareGateway === undefined) return leaveOut(`it went through Cloudflare AI Gateway, which v2 does not offer for ${v1Description.label}`);
      ids = cloudflareIds(gateway);
      if (ids === null) return leaveOut(`its Cloudflare AI Gateway ${gateway.name} names no account and gateway ids`);
      try {
        checkCloudflareIds(ids, null);
        checkDestination(v1Description, null, ids);
      } catch (error) {
        return leaveOut(`v2 does not take its Cloudflare AI Gateway ${gateway.name} (${reason(error)})`);
      }
      v1 = { kind: "cloudflare", ...ids, ...v1Route };
      cloudflareJson = await sealToken(gateway);
      if (cloudflareJson === null) return null;
      report.push({
        kind: "changed",
        subject,
        what: `Its Cloudflare AI Gateway ${gateway.name} is now the connection's own Cloudflare AI Gateway setting, with a copy of the gateway's token. As before, it uses the provider keys stored in Cloudflare. Rotating the token now means rotating it on each connection that went through ${gateway.name}.`,
      });
    } else if (gateway.type === "vercel") {
      modelPrefix = route.modelPrefix ?? V1_VERCEL_PREFIX[provider.type] ?? null;
      if (modelPrefix === null) return leaveOut(`v1 could not send ${a(v1Description.label)} row through Vercel AI Gateway (it has no model namespace there), so it served nothing`);
      const vercel = builtInProvider("vercel");
      if (vercel === null) return leaveOut("v2 has no Vercel AI Gateway type");
      description = vercel;
      typeChanged = true;
      v1 = { kind: "vercel" };
      const blob = await reseal(gateway.secret_blob, { kind: "providerGatewayToken", identity: [gateway.organization_id, gateway.id] }, { kind: "providerKey", identity: [provider.organization_id, provider.id, "vercel", keyOrigin({ baseUrl: null, cloudflareGateway: null })] });
      if (blob === null) return null;
      secretBlob = blob;
      secretHint = hint(gateway.secret_hint);
      if (route.providerOnly !== undefined && route.providerOnly.length > 0) servingProviders = JSON.stringify(route.providerOnly);
      report.push({
        kind: "changed",
        subject,
        what: `It was ${a(v1Description.label)} connection through Vercel AI Gateway (${gateway.name}). It is now a Vercel AI Gateway connection, with a copy of the gateway's token as its key. v1 put ${modelPrefix} before every model name on the way out. v2 sends the model name as the app sends it, so an installed app that sends names without ${modelPrefix} is refused until it sends ${modelPrefix}<model>. The connection's prices, its apps' model lists and rewrite targets, and its presets now use the full names. An app route with no model list is left out: v1's prefix kept it to ${modelPrefix} models, a limit v2 cannot hold.`,
        first: true,
      });
    } else {
      return leaveOut(`it went through a ${gateway.type} gateway, which v2 does not have`);
    }
  } else {
    if (provider.base_url !== null && provider.base_url !== "") {
      v1 = { kind: "direct", base: v1Base(provider.base_url) };
      const placed = placeBaseUrl(v1Description, provider.base_url, cloudflare);
      if (placed.kind === "problem") return leaveOut(placed.what);
      if (placed.kind === "keep") {
        baseUrl = placed.baseUrl;
        if (placed.note !== undefined) report.push({ kind: "changed", subject, what: placed.note });
      } else {
        ids = placed.ids;
        cloudflareJson = await sealToken(placed.gateway);
        if (cloudflareJson === null) return null;
        report.push({
          kind: "changed",
          subject,
          what: `Its base URL went through Cloudflare AI Gateway ${placed.ids.gatewayId}. It now goes through the same gateway with the connection's own Cloudflare AI Gateway setting: the same key, and a copy of the token of the account's gateway ${placed.gateway.name}. Only requests whose whole URL stays the same are allowed: see each app's line.`,
        });
      }
    }
    if (provider.secret_blob === null) return leaveOut("it holds no key");
    // Sealed for the address the Worker opens it for (`keyOrigin`): its base URL, or its Cloudflare gateway's.
    const blob = await reseal(
      provider.secret_blob,
      { kind: "providerKey", identity: [provider.organization_id, provider.id, provider.type, provider.base_url ?? ""] },
      { kind: "providerKey", identity: [provider.organization_id, provider.id, provider.type, keyOrigin({ baseUrl, cloudflareGateway: ids })] },
    );
    if (blob === null) return null;
    secretBlob = blob;
    secretHint = hint(provider.secret_hint);
    if (route.modelPrefix !== undefined || route.providerOnly !== undefined) {
      report.push({ kind: "changed", subject, what: "Its gateway route settings applied only through a provider gateway, and were left out." });
    }
  }

  const connection: MovedConnection = {
    id: provider.id,
    accountId: provider.organization_id,
    slug: provider.slug,
    description,
    v1Description: typeChanged ? v1Description : null,
    modelPrefix,
    // A base URL on another host than the provider's own, and not Cloudflare's: a proxy that may have answered any API style.
    hadBaseUrl: baseUrl !== null && knownHostOwner(baseUrl)?.type !== description.type,
    v1,
    record: { baseUrl, cloudflareGateway: ids === null ? null : { ...ids, tokenBlob: "", tokenHint: null } } as unknown as ConnectionRecord,
    matcher: new ProviderMatcher(description),
    subject: { kind: "builtIn", description, cloudflareGateway: ids, baseUrl },
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
  // A base URL v2 holds in another form, or a Cloudflare base URL: if no request would reach the same URL, nothing of it moved.
  if (baseUrl !== provider.base_url && provider.base_url !== null && provider.provider_gateway_id === null) {
    const compared = [...defaultReach(connection).operations].map((name) => addresses(connection, filledPath(description.operations.find((one) => one.name === name)!)));
    if (!compared.some((where) => where.v2 !== null && where.v2 === where.v1)) {
      const example = compared[0];
      return leaveOut(`v2 would send none of its requests to the URL v1 sent them to${example === undefined ? "" : ` (for example ${example.v1} in v1, ${example.v2 ?? "nowhere"} in v2)`}`);
    }
  }
  return connection;
}

// ---------------------------------------------------------------- app routing

type V1PathEntry = string | { path: string; fixed_model?: string; clamp?: string; methods?: HttpMethod[] };

interface V1Policy {
  allowed_paths?: V1PathEntry[];
  allowed_models?: string[];
  max_output_tokens?: number;
}

/** One app's route on one connection, before model names are put as v2 sees them. */
interface Route {
  readonly connection: MovedConnection;
  readonly operations: string[];
  /** The model list, as v1 named the models; absent for none. */
  readonly models?: string[];
  readonly max_output_tokens?: number;
}

/** Matchers for every built-in type, to tell another provider's API from a plain passthrough path. */
const MATCHERS = new Map(Object.values(BUILT_IN_PROVIDERS).map((description) => [description.type, new ProviderMatcher(description)]));

/** Tries to list `asked` on the connection, by the console's own save rules. Returns why not, or null when it is listed. */
function listPath(connection: MovedConnection, appId: string, asked: { method: HttpMethod; path: string }, report: ReportLine[]): string | null {
  const key = `${asked.method} ${asked.path}`;
  const existing = connection.listed.find((one) => `${one.asked.method} ${one.asked.path}` === key);
  if (existing !== undefined) {
    existing.apps.add(appId);
    return null;
  }
  // A listed path goes to the connection's own address, as v1 sent it, or it is not listed.
  const v1 = v1Url(connection.v1, asked.path);
  const v2 = v2Url(connection, "main", asked.path, true);
  if (v2 !== v1) return `v1 sent it to ${v1}, and v2 would send it ${v2 === null ? "nowhere" : `to ${v2}`}`;
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

/**
 * What v1 reached on a connection for an app that listed no paths (`./v1-defaults.ts`),
 * as v2 operations, and what of it v2 does not serve.
 */
function defaultReach(connection: MovedConnection): { operations: Set<string>; lostStyles: string[]; lostPaths: string[]; sessions: string[] } {
  const vercel = connection.v1Description !== null;
  const v1Type = (connection.v1Description ?? connection.description).type;
  const target = connection.description;
  const operations = new Set<string>();
  const lostStyles: string[] = [];
  const lostPaths: string[] = [];
  for (const style of vercel ? V1_VERCEL_STYLES : (V1_TYPE_DEFAULTS[v1Type]?.styles ?? V1_DEFAULT_STYLES)) {
    const found = target.operations.filter((operation) => operation.lifecycle === "call" && operation.style === V2_STYLE_OF[style]);
    if (found.length === 0) lostStyles.push(style);
    for (const operation of found) operations.add(operation.name);
  }
  if (!vercel) {
    for (const path of V1_TYPE_DEFAULTS[v1Type]?.inference ?? []) {
      const matched = MATCHERS.get(target.type)!.match("POST", samplePath(path));
      if (matched.kind === "operation") operations.add(matched.operation.name);
      else lostPaths.push(path);
    }
  }
  const sessions = target.operations.filter((operation) => operation.lifecycle !== "call" && !operations.has(operation.name)).map((operation) => operation.name);
  return { operations, lostStyles, lostPaths, sessions };
}

/** A route on a Vercel connection with no model list: v1's prefix kept it to one namespace, which v2 cannot hold. */
function vercelWithoutModels(app: V1App, slug: string, connection: MovedConnection, policy: V1Policy, report: ReportLine[]): boolean {
  if (connection.modelPrefix === null || (policy.allowed_models ?? []).some((model) => model.trim() !== "")) return false;
  report.push({
    kind: "left_out",
    subject: `app ${app.id}`,
    what: `On ${slug}, the app had no model list. v1 put ${connection.modelPrefix} before every model, which kept it to ${connection.modelPrefix} models; v2 cannot hold that limit, so the route was not moved. Allow ${slug} again with the models the app uses.`,
  });
  return true;
}

/** The route of an app that listed no paths on `slug` (or allowed every connection), and the report of what it no longer reaches. */
function defaultRoute(app: V1App, slug: string, policy: V1Policy, connection: MovedConnection, usage: readonly string[], report: ReportLine[]): Route | null {
  const subject = `app ${app.id}`;
  if (vercelWithoutModels(app, slug, connection, policy, report)) return null;
  const reach = defaultReach(connection);
  // Only what still goes to the URL v1 sent it to.
  const moved = new Set<string>();
  const elsewhere: string[] = [];
  for (const name of reach.operations) {
    const operation = connection.description.operations.find((one) => one.name === name)!;
    const where = addresses(connection, filledPath(operation));
    if (where.v2 !== null && where.v2 === where.v1) moved.add(name);
    else elsewhere.push(`${name} (v1: ${where.v1}, v2: ${where.v2 ?? "none"})`);
  }
  const label = (connection.v1Description ?? connection.description).label;
  report.push({
    kind: "changed",
    subject,
    what: `On ${slug}, v1 allowed its default API styles and ${label}'s own endpoints. v2 names each: it now allows those ${moved.size} operations, and no passthrough path.${reach.sessions.length > 0 ? ` As in v1, not ${list(reach.sessions)}, which an app reached only by listing it.` : ""}`,
  });
  if (elsewhere.length > 0) {
    report.push({ kind: "left_out", subject, what: `On ${slug}, v2 would send these to another URL than v1 did, so they are not allowed: ${list(elsewhere)}.` });
  }
  // v1 sent every style to the row's base URL; on the provider's own host, another provider's style never answered.
  if (connection.hadBaseUrl && reach.lostStyles.length > 0) {
    report.push({ kind: "left_out", subject, what: `On ${slug}, v1 sent ${list(reach.lostStyles)} requests to the connection's base URL. v2 serves no such API on ${a(connection.description.label)} connection, so they are refused with path_not_allowed.` });
  }
  if (reach.lostPaths.length > 0) {
    report.push({ kind: "left_out", subject, what: `On ${slug}, v2 does not serve ${list(reach.lostPaths.map((path) => `POST ${path}`))}, which v1 allowed by default. Requests to them are refused.` });
  }
  // What the app really called, by v1's usage: anything v2 no longer serves for it at the same URL.
  const lost = usage.flatMap((route) => {
    if (!route.startsWith(`${slug}/`)) return [];
    const path = route.slice(slug.length + 1);
    const where = addresses(connection, path);
    return where.operation !== null && moved.has(where.operation.name) && where.v2 === where.v1 ? [] : [path];
  });
  if (lost.length > 0) {
    report.push({ kind: "left_out", subject, what: `On ${slug}, v1's usage shows the app called ${list(lost)}, which v2 does not serve for it at the same URL. Those calls are refused.` });
  }
  if (moved.size === 0) {
    report.push({ kind: "left_out", subject, what: `On ${slug}, nothing v1 allowed can be served in v2, so the app no longer reaches ${slug}.` });
    return null;
  }
  const models = [...new Set((policy.allowed_models ?? []).map((model) => model.trim()).filter((model) => model !== ""))];
  return {
    connection,
    operations: [...moved],
    ...(models.length > 0 ? { models } : {}),
    ...(policy.max_output_tokens !== undefined ? { max_output_tokens: policy.max_output_tokens } : {}),
  };
}

/** One v1 provider policy with listed paths as a route, or null when nothing in it can be served. */
function listedRoute(app: V1App, slug: string, policy: V1Policy, connection: MovedConnection, report: ReportLine[]): Route | null {
  const subject = `app ${app.id}`;
  if (vercelWithoutModels(app, slug, connection, policy, report)) return null;
  const v1Type = (connection.v1Description ?? connection.description).type;
  const operations = new Set<string>();
  /** Operations a listed path named the model of, with those models. */
  const pinned = new Map<string, Set<string>>();
  /** Operations a listed path left open to any model. */
  const open = new Set<string>();
  const notMoved = (what: string) => report.push({ kind: "left_out", subject, what: `On ${slug}, ${what}. Requests to it are refused with path_not_allowed.` });
  for (const entry of policy.allowed_paths ?? []) {
    const path = plainPath(typeof entry === "string" ? entry : entry.path);
    const methods: readonly HttpMethod[] = (typeof entry === "string" ? undefined : entry.methods) ?? ["POST"];
    if (LITERAL_PART.test(path)) {
      notMoved(`the path ${path} was not moved: v1 matched its ${path.match(LITERAL_PART)![0]} as that literal text, never as an id, and v2 would read it as any id. List the exact path again if the app needs it`);
      continue;
    }
    const where = addresses(connection, samplePath(path));
    if (where.operation !== null) {
      const operation = where.operation;
      // A `{model}` part must be the whole model segment: `gemini-{model}` let v1 match only part of it.
      if (path.includes("{model}") && !(operation.model.in === "path" && where.parts[operation.model.part] === "sample")) {
        notMoved(`the path ${path} was not moved: its {model} covers only part of the model name, a limit v2 cannot hold`);
        continue;
      }
      if (where.v2 !== where.v1) {
        notMoved(`the path ${path} was not moved: v1 sent it to ${where.v1}, and v2 would send it ${where.v2 === null ? "nowhere" : `to ${where.v2}`}`);
        continue;
      }
      operations.add(operation.name);
      // An exact path names its model, as v1 matched it: that model only.
      if (operation.model.in === "path" && !path.includes("{model}")) {
        const model = where.parts[operation.model.part];
        if (model !== undefined) pinned.set(operation.name, new Set([...(pinned.get(operation.name) ?? []), model]));
      } else {
        open.add(operation.name);
      }
      if (typeof entry !== "string" && entry.fixed_model !== undefined) {
        report.push({
          kind: "changed",
          subject,
          what: `On ${slug}, v1 used the model ${entry.fixed_model} for a request to ${path} that named none. v2 has no fixed model per path, and refuses a request that names no model.`,
          first: true,
        });
      }
      if (typeof entry !== "string" && entry.clamp !== undefined && policy.max_output_tokens !== undefined) {
        const v1Caps = V2_CAPS_OF_CLAMP[entry.clamp] ?? [];
        const v2Cap = operation.policy?.outputCap;
        if (v2Cap === undefined ? v1Caps.length > 0 : !v1Caps.includes(v2Cap)) {
          report.push({
            kind: "changed",
            subject,
            what: `On ${slug}, v1 capped output on ${path} in its ${entry.clamp} field. v2 caps ${operation.name} ${v2Cap === undefined ? "nowhere: it has no output to cap" : `in its ${v2Cap} field`}.`,
          });
        }
      }
      continue;
    }
    // Another provider's API on this connection: v2 serves each type's own operations only (plan 9.1).
    const other = [...MATCHERS].find(([type, matcher]) => type !== v1Type && type !== connection.description.type && matcher.match("POST", samplePath(path)).kind === "operation");
    if (other !== undefined) {
      notMoved(`the path ${path} was not moved: it is ${BUILT_IN_PROVIDERS[other[0]]!.label}'s API, which v2 does not serve on ${a(connection.description.label)} connection`);
      continue;
    }
    if (connection.v1Description !== null) {
      notMoved(`the path ${path} was not moved: ${connection.description.label} serves no such operation, and v2 lists no passthrough path through it`);
      continue;
    }
    for (const method of methods) {
      const line = `${method} ${path}`;
      const problem = listPath(connection, app.id, { method, path }, report);
      if (problem !== null) {
        notMoved(`the passthrough path ${line} was not moved: ${problem}`);
        continue;
      }
      operations.add(PASSTHROUGH);
    }
  }
  const unique = [...operations];
  if (unique.length === 0) {
    report.push({ kind: "left_out", subject, what: `On ${slug}, nothing v1 allowed can be served in v2, so the app no longer reaches ${slug}.` });
    return null;
  }

  // One model list per connection in v2: v1's list, else the models the exact paths named.
  const allowed = [...new Set((policy.allowed_models ?? []).map((model) => model.trim()).filter((model) => model !== ""))];
  let models: string[] | undefined;
  if (allowed.length > 0) {
    models = allowed;
    for (const [name, pins] of pinned) {
      const more = allowed.filter((model) => !pins.has(model));
      if (more.length > 0) {
        report.push({ kind: "check", subject, what: `On ${slug}, v1 let ${name} take only ${list(pins)}, the model its listed path named. v2 lets it take every model the app lists for ${slug}: ${list(more)} too.`, first: true });
      }
    }
  } else if (pinned.size > 0) {
    models = [...new Set([...pinned.values()].flatMap((pins) => [...pins]))];
    const freed = [...open].filter((name) => !pinned.has(name));
    if (freed.length > 0) {
      report.push({ kind: "changed", subject, what: `On ${slug}, v1 let ${list(freed)} take any priced model. v2 has one model list per connection, which holds the models the app's exact paths named, so they now take only ${list(models)}.`, first: true });
    }
    for (const [name, pins] of pinned) {
      const more = models.filter((model) => !pins.has(model));
      if (more.length > 0 || open.has(name)) {
        report.push({ kind: "check", subject, what: `On ${slug}, v1 let ${name} take only ${list(pins)}${open.has(name) ? " through one path and any model through another" : ""}. v2 lets it take ${list(models)}.`, first: true });
      }
    }
  }
  return {
    connection,
    operations: unique,
    ...(models !== undefined ? { models } : {}),
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

/**
 * The operation a preset target uses: one of the connection's preset
 * operations of the style whose URL, for this model, is the one v1's endpoint
 * posted to. Named explicitly, so a later change of v2's default never moves
 * it. A reason instead when there is none.
 */
function presetTarget(connections: ReadonlyMap<string, MovedConnection>, provider: string, v1Style: string, style: ApiStyle, model: string): { connection: MovedConnection; operation: string; model: string } | string {
  const connection = connections.get(provider);
  if (connection === undefined) return `the connection ${provider} was not moved`;
  const wire = wireModel(connection, model);
  const v1Type = (connection.v1Description ?? connection.description).type;
  const v1Path = connection.v1.kind === "vercel" ? V1_STYLE_PATHS[v1Style] : V1_ENDPOINT_PATHS[v1Type]?.[v1Style];
  if (v1Path === undefined) return `v1 had no ${v1Style} endpoint path for ${a(connection.description.label)} connection`;
  const v1 = v1Url(connection.v1, v1Path.replace("{model}", encodeURIComponent(wire)));
  for (const operation of connection.description.operations) {
    if (operation.style !== style || presetOperationProblem(connection.description, operation) !== null) continue;
    const where = addresses(connection, filledPath(operation, encodeURIComponent(wire)));
    if (where.operation?.name === operation.name && where.v2 === v1) return { connection, operation: operation.name, model: wire };
  }
  return `no ${style} operation of ${connection.description.label} posts to ${v1}, where v1 sent it`;
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
    const main = presetTarget(connections, endpoint.provider, endpoint.api_style, style, endpoint.model);
    if (typeof main === "string") {
      report.push({ kind: "left_out", subject, what: `The endpoint ${slug} was not moved: ${main}. Calls to it are refused with preset_not_found.` });
      continue;
    }
    const fallback = (endpoint.fallback ?? []).flatMap((one) => {
      const found = presetTarget(connections, one.provider, endpoint.api_style, style, one.model);
      if (typeof found === "string") {
        report.push({ kind: "changed", subject, what: `The endpoint ${slug}'s fallback to ${one.provider} (${one.model}) was dropped: ${found}.`, first: true });
        return [];
      }
      return [{ provider: one.provider, operation: found.operation, model: found.model }];
    });
    presets[slug] = {
      provider: endpoint.provider,
      operation: main.operation,
      model: main.model,
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
  const budgetScope = scope?.spending?.scope;
  return {
    requests: { per_minute: scope?.requests?.per_minute ?? null, per_day: scope?.requests?.per_day ?? null },
    spending: {
      monthly_nano: budgetNano(scope?.spending?.monthly_usd ?? null),
      ...(budgetScope !== undefined && budgetScope !== defaultScope ? { scope: budgetScope } : {}),
    },
  };
}

/**
 * Model names as v2 sees them. v1 judged an app's model list on the name the
 * request sent, rewrote it, and only then put a Vercel prefix before it. v2
 * judges the list on the name sent too, and sends the rewritten name as it is:
 * a listed name the app rewrites stays as it is, every other listed name on a
 * Vercel connection gets its prefix, and so does a rewrite target that only
 * Vercel connections with one prefix can carry.
 */
function namesForV2(app: V1App, routes: ReadonlyMap<string, Route>, rewrites: Record<string, string>, report: ReportLine[]): { providers: Record<string, unknown>; rewrites: Record<string, string> } {
  const subject = `app ${app.id}`;
  const sources = new Set(Object.keys(rewrites));
  const moved: Record<string, string> = {};
  for (const [source, target] of Object.entries(rewrites)) {
    const carriers = [...routes.values()].filter((route) => route.operations.some((name) => name !== PASSTHROUGH) && (route.models === undefined || route.models.includes(source)));
    const prefixes = new Set(carriers.map((route) => route.connection.modelPrefix));
    const [only] = prefixes;
    if (prefixes.size === 1 && only !== null && only !== undefined) {
      moved[source] = `${only}${target}`;
      report.push({ kind: "changed", subject, what: `Its rewrite of ${source} to ${target} now names ${only}${target}: only Vercel AI Gateway connections carry it, and v1 put ${only} before the name there.` });
    } else {
      moved[source] = target;
      const vercel = carriers.filter((route) => route.connection.modelPrefix !== null).map((route) => route.connection.slug);
      if (vercel.length > 0) {
        report.push({
          kind: "changed",
          subject,
          what: `Its rewrite of ${source} to ${target} is carried by Vercel AI Gateway (${list(vercel)}) and by other connections. One app-wide rewrite cannot name both, so it keeps ${target}: on ${list(vercel)}, where v1 sent ${carriers.find((route) => route.connection.modelPrefix !== null)!.connection.modelPrefix}${target}, Vercel now refuses it.`,
          first: true,
        });
      }
    }
  }
  const providers: Record<string, unknown> = {};
  for (const [slug, route] of routes) {
    const models = route.models?.map((model) => (sources.has(model) ? model : wireModel(route.connection, model)));
    providers[slug] = {
      operations: route.operations,
      ...(models !== undefined && models.length > 0 ? { models: [...new Set(models)] } : {}),
      ...(route.max_output_tokens !== undefined ? { max_output_tokens: route.max_output_tokens } : {}),
    };
  }
  return { providers, rewrites: moved };
}

function convertApp(app: V1App, connections: ReadonlyMap<string, MovedConnection>, leftOut: ReadonlySet<string>, usage: readonly string[], report: ReportLine[]): AppConfig | null {
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
  const routes = new Map<string, Route>();
  if (routing.providers?.mode === "all") {
    report.push({
      kind: "changed",
      subject,
      what: `v1 let it reach every connection of its account. v2 names each one: it now allows ${connections.size === 0 ? "no connection" : list(connections.keys())}, each as v1's defaults reached it. A connection added later is not allowed until you allow it.`,
    });
    for (const [slug, connection] of connections) {
      const route = defaultRoute(app, slug, {}, connection, usage, report);
      if (route !== null) routes.set(slug, route);
    }
    if (leftOut.size > 0) {
      report.push({ kind: "left_out", subject, what: `It reached ${list(leftOut)} in v1, which ${leftOut.size === 1 ? "was" : "were"} not moved: see each connection's line. Adding a connection back does not allow it for the app: allow it again.` });
    }
  } else {
    for (const [slug, policy] of Object.entries(routing.providers?.selected ?? {})) {
      const connection = connections.get(slug);
      if (connection === undefined) {
        report.push(
          leftOut.has(slug)
            ? { kind: "left_out", subject, what: `Its access to ${slug} was dropped with the connection: see the connection's line. Adding the connection back does not restore it: allow ${slug} for the app again.` }
            : { kind: "changed", subject, what: `It allowed ${slug}, which no connection of its account has. That entry was left out.` },
        );
        continue;
      }
      const route = (policy.allowed_paths ?? []).length === 0 ? defaultRoute(app, slug, policy, connection, usage, report) : listedRoute(app, slug, policy, connection, report);
      if (route !== null) routes.set(slug, route);
    }
  }
  const names = namesForV2(app, routes, routing.model_rewrites ?? {}, report);
  const presets = presetsFor(app, (v1.endpoints ?? {}) as Record<string, V1Endpoint>, connections, report);
  const limits = (v1.limits ?? {}) as { per_user?: V1Scope; per_app?: V1Scope };
  const config = {
    authentication: v1.authentication,
    routing: { providers: names.providers, ...(Object.keys(names.rewrites).length > 0 ? { model_rewrites: names.rewrites } : {}) },
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

  // Accounts v1 refused while email verification was on: none of their owners had a verified address, and no activation.
  const activated = new Set(v1.activatedAccountIds);
  const humans = new Map(v1.users.map((user) => [user.id, user]));
  const unverified = [...kept].filter(
    (id) =>
      !activated.has(id) &&
      !v1.members.some((member) => member.organization_id === id && member.role === "owner" && humans.get(member.user_id)?.kind === "human" && humans.get(member.user_id)?.email_verified === 1),
  );
  if (unverified.length > 0) {
    report.push({
      kind: "check",
      subject: "accounts",
      first: true,
      what: `${count(unverified.length, "account", "accounts")} v1 refused while email verification was on, because no owner had a verified address: ${list(unverified.sort())}. v2 has no activation step and does not mark imported accounts, so ${unverified.length === 1 ? "it serves" : "they serve"} in v2.`,
    });
  }

  // Connections.
  const gateways = new Map(v1.gateways.map((gateway) => [gateway.id, gateway]));
  const cloudflareByAccount = new Map<string, { gateway: V1Gateway; ids: { accountId: string; gatewayId: string } }[]>();
  for (const gateway of v1.gateways) {
    const ids = gateway.type === "cf_aig" && gateway.status === "active" ? cloudflareIds(gateway) : null;
    if (ids !== null) cloudflareByAccount.set(gateway.organization_id, [...(cloudflareByAccount.get(gateway.organization_id) ?? []), { gateway, ids }]);
  }
  const connections = new Map<string, Map<string, MovedConnection>>();
  const leftOut = new Map<string, Set<string>>();
  for (const provider of v1.providers) {
    if (!kept.has(provider.organization_id)) continue;
    const moved = await moveConnection(provider, gateways, cloudflareByAccount.get(provider.organization_id) ?? [], options, report);
    const into = <T>(map: Map<string, T>, make: () => T) => map.get(provider.organization_id) ?? map.set(provider.organization_id, make()).get(provider.organization_id)!;
    if (moved === null) into(leftOut, () => new Set<string>()).add(provider.slug);
    else into(connections, () => new Map<string, MovedConnection>()).set(moved.slug, moved);
  }

  // Apps.
  const apps = new Map<string, { accountId: string; config: AppConfig }>();
  for (const app of v1.apps) {
    if (!kept.has(app.organization_id)) continue;
    const config = convertApp(app, connections.get(app.organization_id) ?? new Map(), leftOut.get(app.organization_id) ?? new Set(), v1.usageRoutes[app.id] ?? [], report);
    if (config === null) continue;
    apps.set(app.id, { accountId: app.organization_id, config });
    const blocked = v1.blockedUsers[app.id] ?? 0;
    if (blocked > 0) {
      report.push({ kind: "check", subject: `app ${app.id}`, first: true, what: `v1 blocked ${count(blocked, "user", "users")}: ${blocked === 1 ? "it is" : "they are"} not blocked in v2 until the history half of the migration runs, which brings v1's user records over.` });
    }
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
            what: `The path ${asked.method} ${asked.path}, listed in v1 by ${list(listedBy)}, can now be reached by ${list(widened)} too: v2 lists paths per connection, with one passthrough switch per app. To keep them apart, give those apps a connection of their own.`,
            first: true,
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
