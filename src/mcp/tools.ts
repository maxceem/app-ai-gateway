import { z } from "zod";
import {
  CATALOG,
  type Catalog,
  type OperationName,
  type OperationParams,
  type OperationResponse,
  type OperationSpec,
} from "../contracts/catalog";
import { GatewayError, type ErrorCode } from "../core/errors";
import { operationPolicy, type OperationRequest } from "../management/executor";
import type { RegisteredOperation } from "../management/handlers";
import { parseRequest } from "../management/validation";
import { accountUnclaimed, unclaimedAccessDeadline } from "../policy/accounts";

/**
 * The tools the MCP server offers, as an explicit allowlist over the catalog.
 *
 * Every tool runs a catalog operation through the same executor the HTTP API
 * and the CLI run it through, so its authorization is the operation's policy
 * and its answer is the operation's response body. What a tool adds is what an
 * agent needs and an HTTP client does not: a verb-first name, a description of
 * when to reach for it, one input object in place of a path and a query, and a
 * sentence summarising the answer.
 *
 * The order is the design's and is deliberate: `tools/list` answers with it,
 * and a stable order is what lets a client cache the list.
 *
 * Every tool in this table reads. That is checked twice: a tool's operation has
 * the type {@link ReadOperation}, which only an operation whose catalog policy
 * needs no more than the `read` grant has, and the table refuses to build if
 * `operationPolicy` says otherwise — so a write cannot be added by naming it.
 */

/**
 * The least grant an operation needs, as a type: the entry's own `grant` where
 * it declares one, `read` for a `GET` and `manage` for anything else. The same
 * rule `operationPolicy` applies at run time.
 */
type LeastGrant<K extends OperationName> =
  Catalog[K] extends { readonly policy: { readonly grant: infer G } }
    ? G
    : Catalog[K]["method"] extends "GET"
      ? "read"
      : "manage";

/** A registered operation a `read` credential may run: the only kind a tool here may name. */
export type ReadOperation = {
  [K in RegisteredOperation]: LeastGrant<K> extends "read" ? K : never;
}[RegisteredOperation];

/**
 * One operation, the request a tool call makes of it, and — for an argument
 * the operation's own schemas do not cover — the check that refuses it, run by
 * the executor once the application is found and the policy has passed.
 */
export type ToolCall = {
  [K in ReadOperation]: { operation: K; request: OperationRequest<K>; before?: () => void };
}[ReadOperation];

/**
 * The annotations a client shows beside a tool, as the protocol spells them.
 * Declared here rather than imported, so nothing but the adapter in
 * `./server` names the SDK.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpTool {
  /** Verb-first snake_case, the name an agent calls. */
  readonly name: string;
  readonly title: string;
  /** For an agent: what it returns, when to use it, and what it does not do. */
  readonly description: string;
  /** The catalog operation it runs, or the two a dual tool chooses between. */
  readonly operation: ReadOperation | readonly [ReadOperation, ReadOperation];
  /**
   * Path parameters and query fields of the operation, reusing the catalog's
   * own field schemas. What `tools/list` advertises, and only that: the
   * arguments of a call reach the executor as they were sent, so it refuses
   * them in the order and the words it refuses an HTTP request in.
   */
  readonly input: z.ZodObject;
  readonly annotations: ToolAnnotations;
  /** The operation to run for one validated input, and its request. */
  call(input: Record<string, unknown>): ToolCall;
  /** Where a tool answers with part of the operation's body: that part. */
  result?(body: unknown, input: Record<string, unknown>): unknown;
  /** One or two sentences for the text block beside the structured result. */
  summary(result: unknown, input: Record<string, unknown>): string;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * What each `{name}` segment of an operation's path is, as a tool argument.
 * `app` keeps its name, so an agent passes the same id every tool and every
 * HTTP path calls `app`.
 */
const PATH_ARGUMENTS: Readonly<Record<string, z.ZodType>> = {
  app: z.string().min(1).meta({ description: "The application's id, as list_apps returns it." }),
  user: z.string().min(1).meta({ description: "The end user's id, as list_app_users returns it." }),
};

function pathParameterNames(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]!);
}

/** An operation's path parameters, then its query fields — the catalog's own schemas for both. */
function operationInput(operation: ReadOperation): z.ZodObject {
  const spec: OperationSpec = CATALOG[operation];
  const params: Record<string, z.ZodType> = {};
  for (const name of pathParameterNames(spec.path)) {
    const argument = PATH_ARGUMENTS[name];
    if (!argument) throw new Error(`${operation} names {${name}}, which no tool argument describes`);
    params[name] = argument;
  }
  return z.object(params).extend(spec.query?.shape ?? {});
}

/** A tool argument as the string it would have been in a path or a query string. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * The request one call's arguments make of one operation: the path parameters
 * it names, and everything else as the query string it would have been over
 * HTTP, so the executor parses the query with the operation's own schema
 * exactly as it parses one from the API.
 *
 * Nothing here judges an argument. `app` is the executor's to resolve, which
 * it does first; any other path parameter is checked by the returned `before`,
 * after the policy, because no schema of the operation's covers it.
 */
function operationCall<K extends ReadOperation>(
  operation: K,
  input: Record<string, unknown>,
  body?: unknown,
): ToolCall {
  const names = pathParameterNames(CATALOG[operation].path);
  const params: Record<string, string> = {};
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (names.includes(key)) params[key] = asText(value);
    else query[key] = Array.isArray(value) ? value.map(asText) : asText(value);
  }
  const request: OperationRequest<K> = {
    params: params as OperationParams<K>,
    query,
    ...(body === undefined ? {} : { body: async () => body }),
  };
  const checked = names.filter((name) => name !== "app");
  const before = checked.length === 0
    ? undefined
    : () => {
      parseRequest(z.object(Object.fromEntries(checked.map((name) => [name, PATH_ARGUMENTS[name]!]))), input);
    };
  // Correct by construction — `request` is `operation`'s own — but a mapped
  // union does not narrow on a generic key.
  return { operation, request, ...(before ? { before } : {}) } as unknown as ToolCall;
}

/**
 * `readOnlyHint` from the operation's policy, and the refusal of a tool whose
 * operation writes: a `manage` operation in this table is a mistake to catch
 * when the table is built, not a hint to get wrong.
 */
function readOnly(name: string, operations: readonly ReadOperation[]): ToolAnnotations {
  for (const operation of operations) {
    if (operationPolicy(CATALOG[operation]).grant !== "read") {
      throw new Error(`MCP tool ${name} runs ${operation}, which writes; this server exposes reads only`);
    }
  }
  return { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
}

/** A tool that runs one operation with its own input. */
function tool<K extends ReadOperation>(definition: {
  name: string;
  title: string;
  description: string;
  operation: K;
  summary: (result: OperationResponse<K>) => string;
}): McpTool {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    operation: definition.operation,
    input: operationInput(definition.operation),
    annotations: readOnly(definition.name, [definition.operation]),
    call: (input) => operationCall(definition.operation, input),
    summary: (result) => definition.summary(result as OperationResponse<K>),
  };
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function usd(amount: number): string {
  return `$${amount.toFixed(amount !== 0 && Math.abs(amount) < 0.01 ? 4 : 2)}`;
}

/** A short list of names, and how many more there are. */
function listed(names: readonly string[], limit = 10): string {
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
}

function page(count: number, noun: string, next: number | null): string {
  const more = next === null ? "" : ` Pass before_id ${next} for older ones.`;
  return `${plural(count, noun)}, newest first.${more}`;
}

function accountSummary(result: OperationResponse<"getCliAccount">): string {
  const { account, deployment, usage } = result;
  const standing = usage === null ? "" : ` ${usage.used} of ${usage.limit} requests used this period, which resets ${usage.resetAt}.`;
  const base = `Account "${account.name}" (${account.id}) on ${deployment.consoleOrigin}.${standing}`;
  if (account.claimed) return base;
  if (accountUnclaimed(account)) {
    const accessEnds = unclaimedAccessDeadline(account.createdAt);
    const access = accessEnds === null ? "" : ` Its free access ends ${new Date(accessEnds).toISOString()}, and it`;
    return `${base} This account is unclaimed:${access || " it"} is deleted after ${account.expiresAt} unless a person claims it. Call claim_account to start the claim.`;
  }
  return `${base} Nobody has claimed this account yet; call claim_account to give it a person as its owner.`;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const GET_PROVIDER_INPUT = z.object({
  provider: z.string().min(1).meta({
    description: "The provider's id or its slug, as list_providers returns them.",
  }),
});

export const MCP_TOOLS: readonly McpTool[] = [
  tool({
    name: "get_account",
    title: "Get the account",
    description:
      "Returns the account these credentials act in: its id and name, whether a person has claimed it and its deadlines, the deployment it lives on, its access and how many requests it has used this period. Call it first. An unclaimed account expires unless a person claims it; the summary says so and names claim_account. Changes nothing.",
    operation: "getCliAccount",
    summary: accountSummary,
  }),
  tool({
    name: "get_capabilities",
    title: "Get deployment capabilities",
    description:
      "Returns what this deployment supports: its identity and console origin, the server version, every provider type with its API styles, base URL and example path, and the provider gateway types. Use it to learn which provider types exist before reading or planning configuration. It says nothing about what your account has configured; list_providers does.",
    operation: "getCliCapabilities",
    summary: (result) =>
      `Deployment ${result.deployment.id} (${result.deployment.mode}) at ${result.consoleOrigin}, server ${result.serverVersion}: ${plural(result.providers.length, "provider type")} and ${plural(result.providerGateways.length, "provider gateway type")}.`,
  }),
  tool({
    name: "list_models",
    title: "List priced models",
    description:
      "Returns the model catalog this deployment prices, grouped by provider type: per-token prices and, where known, the day a model retires. Use it to choose a model an app may allow, or to explain a cost. A model missing here has no price, and an app that allows it by name is refused when validated.",
    operation: "listModelPrices",
    summary: (result) => {
      const providers = Object.keys(result.prices);
      const models = providers.reduce((sum, provider) => sum + Object.keys(result.prices[provider]!).length, 0);
      return `${plural(models, "priced model")} across ${plural(providers.length, "provider type")}.`;
    },
  }),
  tool({
    name: "list_providers",
    title: "List providers",
    description:
      "Returns every provider credential your account holds, disabled ones included: id, type, slug, name, status, route, capability and pricing. Metadata only; a credential is never returned, only the last characters of a direct key as secretHint. Use it before configuring an app, whose routing names providers by slug.",
    operation: "listProviders",
    summary: (result) =>
      result.providers.length === 0
        ? "No providers yet. A provider credential is only ever entered in a browser, never passed to a tool."
        : `${plural(result.providers.length, "provider")}: ${listed(result.providers.map((provider) => `${provider.slug} (${provider.type}, ${provider.status})`))}.`,
  }),
  {
    name: "get_provider",
    title: "Get a provider",
    description:
      "Returns one provider credential's metadata by its id or its slug: type, name, status, route, capability, pricing and secretHint. Never the credential itself. Answers provider_not_found when none of your providers has that id or slug.",
    operation: "listProviders",
    input: GET_PROVIDER_INPUT,
    annotations: readOnly("get_provider", ["listProviders"]),
    call: (input) => ({
      ...operationCall("listProviders", {}),
      // `provider` is this tool's own argument, so this tool judges it.
      before: () => {
        parseRequest(GET_PROVIDER_INPUT, input);
      },
    }),
    result: (body, input) => {
      const { providers } = body as OperationResponse<"listProviders">;
      const wanted = String(input.provider);
      const provider = providers.find((candidate) => candidate.id === wanted)
        ?? providers.find((candidate) => candidate.slug === wanted);
      if (!provider) {
        throw new GatewayError(404, "provider_not_found", `None of your providers has the id or slug ${wanted}`);
      }
      return { provider };
    },
    summary: (result) => {
      const { provider } = result as { provider: OperationResponse<"listProviders">["providers"][number] };
      const route = provider.route === null ? "an unavailable route" : provider.route === "direct" ? "direct" : `through a ${provider.route} provider gateway`;
      return `Provider ${provider.slug} (${provider.type}) is ${provider.status}, routed ${route}.`;
    },
  },
  tool({
    name: "list_provider_gateways",
    title: "List provider gateways",
    description:
      "Returns the reusable provider gateways your account holds, such as a Cloudflare AI Gateway several providers route through: id, type, name, status and how many providers use each. Metadata only; a gateway token is never returned, only its secretHint.",
    operation: "listProviderGateways",
    summary: (result) =>
      result.gateways.length === 0
        ? "No provider gateways."
        : `${plural(result.gateways.length, "provider gateway")}: ${listed(result.gateways.map((gateway) => `${gateway.name} (${gateway.type}, ${gateway.status})`))}.`,
  }),
  tool({
    name: "list_apps",
    title: "List apps",
    description:
      "Returns every app in your account with its status, authentication type, the providers it reaches and its usage for one month. Use it to find an app's id, which every other app tool takes as `app`. Does not return an app's configuration; get_app does.",
    operation: "listApps",
    summary: (result) =>
      result.apps.length === 0
        ? `No apps yet (${result.month}).`
        : `${plural(result.apps.length, "app")} in ${result.month}: ${listed(result.apps.map((app) => `${app.id} (${app.status})`))}.`,
  }),
  tool({
    name: "get_app",
    title: "Get an app",
    description:
      "Returns one app's whole stored document: name, status, revision and its complete configuration. Read it before proposing a change: a change is judged against this document and must carry its revision. Answers app_not_found for an id that is not one of your apps.",
    operation: "getApp",
    summary: (result) =>
      `App "${result.app.name}" (${result.app.id}) is ${result.app.status}, at revision ${result.app.revision}.`,
  }),
  {
    name: "validate_app",
    title: "Validate an app configuration",
    description:
      "Checks an app document without saving anything: the same {name, config, status?} body creating or updating an app takes, whose every field the `config` argument's schema describes. With `app`, it is judged as an update of that app; without, as a new app. Answers the reason it would be refused, in the gateway's own words, as a tool error. Use it before any change to an app; to change an existing app, start from the document get_app returns, without id and revision.",
    operation: ["validateApp", "validateAppDraft"],
    input: z.object({
      app: z.string().min(1).optional().meta({
        description: "The id of the app this would update. Omit it to judge the document as a new app.",
      }),
      // The catalog's own body schema, so discovery shows every field of an
      // app's configuration. It is advertised, not applied here: the executor
      // parses the document with this same schema and words what it refuses.
      config: CATALOG.validateApp.request.meta({
        description: "The app document to judge: {name, config, status?}, exactly the body creating or updating an app takes, without id or revision.",
      }),
    }),
    annotations: readOnly("validate_app", ["validateApp", "validateAppDraft"]),
    call: ({ app, config }) =>
      app === undefined || app === null
        ? operationCall("validateAppDraft", {}, config)
        : operationCall("validateApp", { app }, config),
    summary: (result) => {
      const appId = (result as { app_id?: string }).app_id;
      return appId === undefined
        ? "The document would be accepted as a new app."
        : `The document would be accepted as an update of ${appId}.`;
    },
  },
  tool({
    name: "check_app",
    title: "Check whether an app is ready",
    description:
      "Checks whether an app can serve requests, without sending any: validates its stored configuration, lists every provider its routing names with that provider's status, and reports ready when the app is active and at least one of them is active. It does not exercise App Attest, issuer sign-in, entitlements or the upstream credentials, and says so in limitations.",
    operation: "checkApp",
    summary: (result) => {
      const active = result.providers.filter((provider) => provider.status === "active").length;
      const standing = `${result.status}, and ${active} of ${plural(result.providers.length, "provider")} it names ${active === 1 ? "is" : "are"} active`;
      return result.ready
        ? `App ${result.appId} is ready: it is ${standing}. No request was sent.`
        : `App ${result.appId} is not ready: it is ${standing}. No request was sent.`;
    },
  }),
  tool({
    name: "get_app_snippet",
    title: "Get an app's first request",
    description:
      "Returns the first request an app can send, written against what it has today: Swift for an App Attest app, curl for a server app, with named placeholders explained in notes where a value is missing. It never contains a credential; a server app's example reads its key from APP_AI_GATEWAY_KEY. Hand it to the person building the app; do not run it unless they ask, since it calls a paid model.",
    operation: "getAppSnippet",
    summary: (result) =>
      `A ${result.language} example${result.notes.length === 0 ? "" : ` with ${plural(result.notes.length, "note")} on what it stands in for`}. It holds no credential.`,
  }),
  tool({
    name: "list_app_keys",
    title: "List an app's keys",
    description:
      "Returns a server app's API keys as metadata: id, name, the key's first characters, status, when it was created and last used. A key's value is shown once, when it is created, and never by this tool.",
    operation: "listAppKeys",
    summary: (result) => {
      const active = result.keys.filter((key) => key.status === "active").length;
      return `${plural(result.keys.length, "key")} for ${result.app_id}, ${active} active. Key values are never returned.`;
    },
  }),
  tool({
    name: "list_app_users",
    title: "List an app's users",
    description:
      "Returns the end users an app has seen, with their status and usage for one month, a page at a time (limit, offset). Filter by a substring of the user id or by status. Use it to find a user before get_app_user, or to see who is blocked. It does not block or unblock anyone.",
    operation: "listAppUsers",
    summary: (result) =>
      `${plural(result.users.length, "user")} of ${result.total} for ${result.app_id} in ${result.month}, from offset ${result.offset}.`,
  }),
  tool({
    name: "get_app_user",
    title: "Get an app user",
    description:
      "Returns one end user of an app: status, attestation state and usage for one month. Use it to explain why one user is refused or what they cost.",
    operation: "getAppUser",
    summary: (result) => `User ${result.user.id} of ${result.app_id} is ${result.user.status} (${result.month}).`,
  }),
  tool({
    name: "list_app_events",
    title: "List an app's usage events",
    description:
      "Returns an app's proxied requests one event each, newest first: user, provider, model, tokens, cost, status and latency. Filter by status, provider, user or model; page back with before_id. Use it to debug failures or to trace one user's traffic. For totals use get_usage.",
    operation: "listAppEvents",
    summary: (result) => page(result.events.length, "usage event", result.next_before_id),
  }),
  tool({
    name: "list_auth_events",
    title: "List an app's authentication events",
    description:
      "Returns an app's authentication attempts one each, newest first: token exchanges and App Attest registrations with their outcome and reason. Filter by outcome, event or user; page back with before_id. Use it to explain why an app's users cannot sign in.",
    operation: "listAppAuthEvents",
    summary: (result) => page(result.events.length, "authentication event", result.next_before_id),
  }),
  tool({
    name: "get_auth_event_summary",
    title: "Summarize an app's authentication",
    description:
      "Returns an app's authentication outcomes per day over a trailing window of days: attempts by outcome and reason, non-ok proxied requests, the token-exchange success rate, entitlement-claim delays and users waiting on a claim. Start here when an app's sign-in looks unhealthy, then drill in with list_auth_events.",
    operation: "getAppAuthEventSummary",
    summary: (result) => {
      const attempts = result.daily.reduce((sum, day) => sum + day.count, 0);
      return `${plural(attempts, "authentication attempt")} for ${result.app_id} from ${result.from} to ${result.to}.`;
    },
  }),
  tool({
    name: "list_rejection_events",
    title: "List an app's refused requests",
    description:
      "Returns samples of an app's requests the gateway refused before contacting a provider — a limit, a disallowed model or path, a blocked user — newest first, with the reason and scope. At most one sample per caller per minute, so counts are not exact totals. Filter by reason, scope, user or day; page back with before_id.",
    operation: "listAppRejectionEvents",
    summary: (result) => page(result.events.length, "refusal sample", result.next_before_id),
  }),
  {
    name: "get_usage",
    title: "Get usage totals",
    description:
      "Returns one month's usage totals: requests, tokens and cost. With `app`, for that app; without, for the whole account, with a line per app including deleted ones. For a breakdown by model, provider or user use get_usage_breakdown; for days use get_usage_timeseries.",
    operation: ["getAppUsage", "getCliUsage"],
    input: z.object({ app: PATH_ARGUMENTS.app!.optional() }).extend(CATALOG.getAppUsage.query.shape),
    annotations: readOnly("get_usage", ["getAppUsage", "getCliUsage"]),
    call: (input) =>
      input.app === undefined
        ? operationCall("getCliUsage", input)
        : operationCall("getAppUsage", input),
    summary: (result) => {
      if ("app_id" in (result as object)) {
        const usage = result as OperationResponse<"getAppUsage">;
        return `${plural(usage.requests, "request")} costing ${usd(usage.cost_usd)} for ${usage.app_id} in ${usage.month}.`;
      }
      const usage = result as OperationResponse<"getCliUsage">;
      return `${plural(usage.totals.requests, "request")} costing ${usd(usage.totals.cost_usd)} across ${plural(usage.apps.length, "app")} in ${usage.month}.`;
    },
  },
  tool({
    name: "get_usage_breakdown",
    title: "Get an app's usage by dimension",
    description:
      "Returns an app's usage totals grouped by one dimension — model, provider, user, status, route, endpoint and others — over a day range, largest first. Use it to find what drives an app's cost or errors.",
    operation: "getAppUsageBreakdown",
    summary: (result) =>
      `${plural(result.rows.length, "row")} by ${result.by} for ${result.app_id} from ${result.from} to ${result.to}.`,
  }),
  tool({
    name: "get_usage_timeseries",
    title: "Get an app's usage per day",
    description:
      "Returns an app's usage per day and provider over a day range: requests, tokens, cost and errors. Use it to see when a change in traffic or cost began.",
    operation: "getAppUsageTimeseries",
    summary: (result) =>
      `${plural(result.buckets.length, "daily bucket")} for ${result.app_id} from ${result.from} to ${result.to}.`,
  }),
];

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * What an agent should do after a refusal, naming a tool or a browser step.
 * The gateway's message says what is wrong; this says what to do about it.
 */
const NEXT_ACTIONS: Partial<Record<ErrorCode, string>> = {
  app_not_found: "Call list_apps for the ids of your apps.",
  provider_not_found: "Call list_providers for the ids and slugs of your providers.",
  endpoint_not_found: "Call get_app to see the app's custom endpoints.",
  invalid_request: "Correct the arguments as the message says and call the tool again.",
  validation_error: "Correct the arguments as the message says and call the tool again.",
  unsupported_snippet: "Ask for the other language: swift for an App Attest app, curl for a server app.",
  provider_unavailable: "Call check_app to see which providers the app can reach.",
  grant_insufficient: "This credential has the read grant. A change needs a management key with the manage grant.",
  forbidden: "Your role in this account does not allow this. Ask an owner or admin of the account.",
  session_required: "This needs a person signed in to the console. Ask them to do it there, in a browser.",
  auth_required: "Reconnect with a valid management key.",
  unclaimed_access_expired: "Call claim_account and give a person the URL to open in their browser; claiming lifts the limit.",
  account_expired: "This account passed its recovery deadline and can no longer be used.",
  rate_limited: "Wait a minute and call the tool again.",
  not_found: "Check the id and call the matching list tool.",
};

export function nextAction(code: ErrorCode): string {
  return NEXT_ACTIONS[code] ?? "Read the message; call get_account to check the account's standing if it is unclear.";
}
