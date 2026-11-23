/**
 * The tools the MCP server offers, and the CLI builds its commands from (v1's
 * table, ported to the v2 management API).
 *
 * Every tool runs one management API operation, as a request made inside the
 * Worker on behalf of the caller (`./run.ts`), so its authorization, its
 * checks and its answer are the operation's own. What a tool adds is what an
 * agent needs and an HTTP client does not: a verb-first name, a description of
 * when to use it, one input object in place of a path, a query and a body, and
 * a sentence summing up the answer.
 *
 * The table is an allowlist. Each tool names its operations, and every one
 * must be in {@link MCP_READ_OPERATIONS} or {@link MCP_WRITE_OPERATIONS}: a
 * write cannot be added by naming it. Nothing here takes or answers a secret.
 * The creates that involve one hand it to a person (`../admin/handoffs.ts`):
 * adding a provider connection or replacing its key answers a console link
 * where a person enters the key, and creating an app or an app key takes two
 * calls and answers a page where a person sees the new key once.
 *
 * The order is deliberate: `tools/list` answers with it, and a stable order
 * lets a client cache the list.
 */
import type { AppPatchOperation } from "../contracts/admin.ts";
import { checkShortcuts, shortcutInput, shortcutOperations, usedShortcuts, type ShortcutApp } from "./shortcuts.ts";
import { z } from "zod";
import { CATALOG, type OperationName, type OperationResponse } from "../contracts/catalog.ts";
import type { CliToolHint } from "../contracts/cli.ts";
import { GatewayError, type ErrorCode } from "../core/errors.ts";
import { isSecretFieldName, type ResultPath } from "./secret-fields.ts";

/** The operations a tool may run that need only the read grant. */
export const MCP_READ_OPERATIONS = [
  "getAdminSession",
  "listModelPrices",
  "listProviderTypes",
  "listProviders",
  "listApps",
  "getApp",
  "getAppSnippet",
  "validateApp",
  "validateAppDraft",
  "checkApp",
  "listAppKeys",
  "listAppUsers",
  "getAppUser",
  "listAppJobs",
  "getAccountUsage",
  "getAppUsage",
  "getAppUsageTimeseries",
  "getAppUsageBreakdown",
  "listAppCharges",
  "getAppAuthEventSummary",
  "listAppAuthEvents",
  "listAppRejectionEvents",
  "getOperation",
] as const satisfies readonly OperationName[];

/**
 * The writes a tool may run, each the operation of one tool: updates guarded
 * by a revision, deletions confirmed by the caller, revoking an app key, and
 * blocking an app's user. None takes or returns a secret.
 */
export const MCP_WRITE_OPERATIONS = [
  "updateApp",
  "patchApp",
  "deleteApp",
  "revokeAppKey",
  "blockAppUser",
  "unblockAppUser",
  "updateProvider",
  "deleteProvider",
  "openProviderHandoff",
  "openProviderKeyHandoff",
  "createReservedApp",
  "createReservedAppKey",
] as const satisfies readonly OperationName[];

export type ReadOperation = (typeof MCP_READ_OPERATIONS)[number];
export type WriteOperation = (typeof MCP_WRITE_OPERATIONS)[number];
export type ToolOperation = ReadOperation | WriteOperation;

/** The annotations a client shows beside a tool, as the protocol spells them. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** One operation, and what a tool call asks of it. */
export interface ToolRequest {
  readonly operation: ToolOperation;
  /** The `{name}` segments of the operation's path. */
  readonly params?: Readonly<Record<string, string>>;
  /** The query string, each value as it would be written in a URL. */
  readonly query?: Readonly<Record<string, string>>;
  /** The JSON body, for an operation that takes one. */
  readonly body?: unknown;
}

export interface McpTool {
  /** Verb-first snake_case, the name an agent calls. */
  readonly name: string;
  readonly title: string;
  /** For an agent: what it returns, when to use it, and what it does not do. */
  readonly description: string;
  /** The operations it may run: one, or the two a dual tool chooses between. */
  readonly operations: readonly ToolOperation[];
  /** Its arguments. Advertised by `tools/list`; the operation judges the values. */
  readonly input: z.ZodObject;
  readonly annotations: ToolAnnotations;
  /** Where it sits among `agw`'s commands. */
  readonly cli: CliToolHint;
  /** Where the tool answers the metadata of an app key it created: shown, though `api_key` is a credential's name. */
  readonly keyMetadataAt?: readonly ResultPath[];
  /** What to do after a refusal, where this tool knows better than {@link nextAction}. */
  readonly next?: Partial<Record<ErrorCode, string>>;
  /** A check of the tool's own, run before the operation. */
  check?(input: Record<string, unknown>): void;
  /**
   * A read to run first, whose answer `request` is given: for a tool whose
   * request depends on what is stored now (`patch_app`'s shortcuts). Null
   * when this call needs none.
   */
  before?(input: Record<string, unknown>): ToolRequest | null;
  /**
   * The refusal after which this call reads again and writes once more, when
   * the write took what it needed from the read alone; null when the caller
   * named what it read (a revision), whose conflict is the caller's to settle.
   */
  retryAfter?(input: Record<string, unknown>): ErrorCode | null;
  /** The operation one call runs, and its request. */
  request(input: Record<string, unknown>, read?: unknown): ToolRequest;
  /** Where a tool answers with part of the operation's body: that part. */
  result?(body: unknown, input: Record<string, unknown>): unknown;
  /** One or two sentences for the text block beside the structured result. */
  summary(result: unknown, input: Record<string, unknown>): string;
}

// ---------------------------------------------------------------------------
// Inputs

/** What each `{name}` path segment is, as a tool argument. */
const PATH_ARGUMENTS: Readonly<Record<string, z.ZodString>> = {
  app: z.string().min(1).meta({ description: "The app's id, as list_apps returns it." }),
  user: z.string().min(1).meta({ description: "The end user's id, as list_app_users returns it." }),
  key: z.string().min(1).meta({ description: "The key's id, as list_app_keys returns it." }),
  id: z.string().min(1).meta({ description: "The provider connection's id, as list_providers returns it." }),
};

/** The `{name}` segments of a catalog path. */
export function pathParameterNames(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]!);
}

/** An operation's path parameters, then its query fields: the catalog's own schemas for both. */
function operationInput(operation: ToolOperation): z.ZodObject {
  const spec = CATALOG[operation];
  const params: Record<string, z.ZodType> = {};
  for (const name of pathParameterNames(spec.path)) {
    const argument = PATH_ARGUMENTS[name];
    if (!argument) throw new Error(`${operation} names {${name}}, which no tool argument describes`);
    params[name] = argument;
  }
  const query = "query" in spec ? (spec.query as z.ZodObject).shape : {};
  return z.object(params).extend(query);
}

/** A tool argument as the string it would be in a path or a query string. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * The request one call's arguments make of one operation: the path
 * parameters it names, everything else as the query string. Nothing here
 * judges an argument; the operation does.
 */
function plainRequest(operation: ToolOperation, input: Record<string, unknown>, body?: unknown): ToolRequest {
  const names = pathParameterNames(CATALOG[operation].path);
  const params: Record<string, string> = {};
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (names.includes(key)) params[key] = asText(value);
    else query[key] = asText(value);
  }
  return { operation, params, query, ...(body === undefined ? {} : { body }) };
}

/** The path parameters of a call, and nothing else. */
function pathOnly(operation: ToolOperation, input: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const name of pathParameterNames(CATALOG[operation].path)) {
    const value = input[name];
    if (value !== undefined && value !== null) params[name] = asText(value);
  }
  return params;
}

const READS: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

function writes(effect: { destructive: boolean; idempotent: boolean }): ToolAnnotations {
  return { readOnlyHint: false, destructiveHint: effect.destructive, idempotentHint: effect.idempotent, openWorldHint: false };
}

/** A tool that runs one operation with its own path and query as input. */
function tool<K extends ToolOperation>(definition: {
  name: string;
  title: string;
  description: string;
  operation: K;
  input?: z.ZodObject;
  effect?: K extends WriteOperation ? { destructive: boolean; idempotent: boolean } : never;
  cli: CliToolHint;
  check?: (input: Record<string, unknown>) => void;
  next?: Partial<Record<ErrorCode, string>>;
  keyMetadataAt?: readonly ResultPath[];
  summary: (result: OperationResponse<K>) => string;
}): McpTool {
  const { operation } = definition;
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    operations: [operation],
    input: definition.input ?? operationInput(operation),
    annotations: definition.effect ? writes(definition.effect) : READS,
    cli: definition.cli,
    ...(definition.next ? { next: definition.next } : {}),
    ...(definition.keyMetadataAt ? { keyMetadataAt: definition.keyMetadataAt } : {}),
    ...(definition.check ? { check: definition.check } : {}),
    request: (input) => plainRequest(operation, input),
    summary: (result) => definition.summary(result as OperationResponse<K>),
  };
}

/** The argument a deletion repeats, so that nothing is deleted by a call that did not mean to. */
const CONFIRM_ARGUMENT = z.string().min(1).meta({
  description: "The id of what is deleted, repeated exactly. Without it, nothing is deleted.",
});

/** Refuses a deletion whose `confirm` is not the id it deletes. */
function confirmed(field: string, noun: string) {
  return (input: Record<string, unknown>) => {
    if (typeof input[field] !== "string" || input.confirm !== input[field]) {
      throw new GatewayError(400, "invalid_request", `confirm: pass the ${noun}'s id again as confirm; nothing was deleted`);
    }
  };
}

/**
 * Refuses a patch that writes a setting named like a credential (v1's check).
 * The shared scan of the arguments reads only each operation's own fields, so
 * the name a value is written under is read here: the last segment of each
 * `add` or `replace` pointer, decoded. The refusal names the operation, never
 * the value.
 */
function refuseCredentialTargets(input: Record<string, unknown>): void {
  if (!Array.isArray(input.operations)) return;
  for (const [index, operation] of input.operations.entries()) {
    if (operation === null || typeof operation !== "object") continue;
    const { op, path } = operation as { op?: unknown; path?: unknown };
    if ((op !== "add" && op !== "replace") || typeof path !== "string") continue;
    const key = path.split("/").at(-1)!.replaceAll("~1", "/").replaceAll("~0", "~");
    if (isSecretFieldName(key)) {
      throw new GatewayError(
        400,
        "invalid_request",
        `operations.${index}.path: an app document holds no credentials, so a tool never writes a setting named like one`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Summaries

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A short list of names, and how many more there are. */
function listed(names: readonly string[], limit = 10): string {
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
}

/** Nano-dollars as dollars. */
function usd(nano: number): string {
  const dollars = nano / 1e9;
  return `$${dollars.toFixed(dollars !== 0 && Math.abs(dollars) < 0.01 ? 4 : 2)}`;
}

type Provider = OperationResponse<"listProviders">["providers"][number];

const GET_PROVIDER_INPUT = z.object({
  provider: z.string().min(1).meta({ description: "The provider connection's id or its slug, as list_providers returns them." }),
});

const APP_UPDATE = CATALOG.updateApp.request;
const APP_PATCH = CATALOG.patchApp.request;
const APP_DOCUMENT = CATALOG.validateApp.request;
const PROVIDER_UPDATE = CATALOG.updateProvider.request;

function appSaved(result: unknown): string {
  const { app } = result as OperationResponse<"updateApp">;
  return `App "${app.name}" (${app.id}) is ${app.status}, now at revision ${app.revision}. Changes reach live traffic within a minute.`;
}

// ---------------------------------------------------------------------------
// Writes handed to a person

const BROWSER_NEXT =
  "Give the URL to the person: they open it in their browser, enter the key there and approve. Then call get_operation with this answer's id until it completes. Do not open the URL yourself.";

const BROWSER_STEP_NEXT: Partial<Record<ErrorCode, string>> = {
  invalid_request: "Correct the arguments as the message says and call the tool again. A key is never an argument: the person enters it on the page this tool returns.",
};

/** What a tool that opens a browser step answers, and its summary. */
function openedSummary(asking: (input: Record<string, unknown>) => string) {
  return (raw: unknown, input: Record<string, unknown>): string => {
    const result = raw as OperationResponse<"openProviderHandoff">;
    const notice = result.notice === undefined ? "" : ` ${result.notice}`;
    return `Opened operation ${result.id} to ${asking(input)}. A person opens ${result.url} in their browser before ${result.expiresAt}, enters the key there and approves; then call get_operation.${notice}`;
  };
}

const RESERVATION_ARGUMENT = z.string().min(1).max(512).optional().meta({
  description:
    "Omit it to reserve: nothing is created, and the answer's `handle` is this argument. Then call again with the same arguments and that handle to create it, once. Calling again with the same handle repeats the first answer rather than creating another.",
});

/** What to do after each refusal particular to a reserved create. */
function reservationNext(tool: string): Partial<Record<ErrorCode, string>> {
  return {
    operation_not_found: `This server never gave out that handle. Call ${tool} without handle to reserve again.`,
    operation_mismatch: `The handle was reserved for other arguments, or for another account. Call ${tool} without handle to reserve these arguments, or send the arguments you reserved.`,
    operation_expired: `The reservation lapsed after 15 minutes. Call ${tool} without handle to reserve again.`,
    already_completed: "That create ran more than 15 minutes ago. Call get_operation with the id its reservation answered to see what it created before creating another.",
    conflict: `Nothing was written. Call ${tool} again with the same arguments and handle in a few seconds.`,
  };
}

const REVEAL_NOTE = "Give reveal_url to the person: signed in to the console as an owner or admin, they see the key there once. Never ask them to paste it into this conversation.";

/** The summary of a reserved create: what was reserved, or what was created. */
function reservedSummary(tool: string, reserving: (input: Record<string, unknown>) => string, created: (result: Record<string, unknown>) => string) {
  return (raw: unknown, input: Record<string, unknown>): string => {
    const result = raw as Record<string, unknown>;
    if (result.state === "reserved") {
      const notice = typeof result.notice === "string" ? ` ${result.notice}` : "";
      return `Reserved ${reserving(input)} as operation ${String(result.id)}; nothing is created yet. Call ${tool} again with the same arguments and handle "${String(result.handle)}" before ${String(result.expiresAt)} to create it.${notice}`;
    }
    const repeated = result.replayed === true ? " This repeats the answer of the call that created it; nothing new was created." : "";
    const reveal = typeof result.reveal_url === "string"
      ? ` Its key is not shown here: a person signed in as an owner or admin reveals it once at ${result.reveal_url}. ${REVEAL_NOTE}`
      : "";
    return `${created(result)}${repeated}${reveal}`;
  };
}

/** The arguments without `handle`, which goes in the body as it is. */
function withHandle(input: Record<string, unknown>): Record<string, unknown> {
  const { handle, ...rest } = input;
  return handle === undefined ? rest : { ...rest, handle };
}

// ---------------------------------------------------------------------------
// The table

export const MCP_TOOLS: readonly McpTool[] = [
  tool({
    name: "get_account",
    title: "Get the account",
    description:
      "Returns who these credentials are and the account they act in: the person, the account's id and name, their role in it, and the credential's grant (read, or manage for changes). On a hosted deployment it also gives the account's plan and how much of this period's request allowance is used. Call it first. Changes nothing.",
    operation: "getAdminSession",
    cli: {
      command: "account status",
      summary: "Show the account these credentials act in",
      view: {
        record: "session",
        columns: [
          "account.name=Account",
          "account.id=Account ID",
          "user.email=Signed in as",
          "role",
          "grant",
          "credentialType=Credential",
          // Only on a hosted deployment with billing; a CLI that predates them skips them.
          "billing.planName=Plan",
          "billing.allowance.used=Requests this period",
          "billing.allowance.limit=Allowance",
          "billing.allowance.resetAt=Resets",
        ],
      },
    },
    summary: ({ session }) => {
      const who = `Account "${session.account.name}" (${session.account.id}): ${session.user.email ?? session.user.id} is ${session.role} with the ${session.grant} grant.`;
      const billing = session.billing;
      if (billing === undefined) return who;
      if (billing.state === "unavailable") return `${who} Its plan could not be read just now.`;
      const plan = billing.planName === null ? " It has no plan." : ` Plan: ${billing.planName}.`;
      const allowance = billing.allowance === null
        ? ""
        : ` ${billing.allowance.used} of ${billing.allowance.limit} requests used this period; the allowance resets ${billing.allowance.resetAt}.`;
      return `${who}${plan}${allowance}`;
    },
  }),
  tool({
    name: "list_models",
    title: "List priced models",
    description:
      "Returns the built-in price list this deployment bills with, by provider type and model, in dollars per million units. Use it to choose a model an app may allow, or to explain a cost. A provider connection can also set its own prices, which get_provider shows. A model with neither price is refused when an app that allows it by name is saved or validated.",
    operation: "listModelPrices",
    cli: {
      command: "model list",
      view: { rows: "prices.*.*", columns: ["$1=Provider", "$2=Model", "kind", "input=Input $/1M", "output=Output $/1M", "unlisted_since=Unlisted since", "retirement_date=Retires"] },
    },
    summary: ({ prices }) => {
      const providers = Object.keys(prices);
      const models = providers.reduce((sum, provider) => sum + Object.keys(prices[provider]!).length, 0);
      return `${plural(models, "priced model")} across ${plural(providers.length, "provider type")}.`;
    },
  }),
  tool({
    name: "list_provider_types",
    title: "List provider types",
    description:
      "Returns every provider type a connection can be added for: its label, the API styles its operations speak, the names of its operations (which an app's routing allows), whether it may go through Cloudflare AI Gateway, and whether it is the custom type. Use it to choose a type before adding a provider connection, or an operation before allowing one in an app. A custom provider needs a base URL and how its key is sent, and speaks the styles its listed paths name.",
    operation: "listProviderTypes",
    cli: {
      command: "provider types",
      view: { rows: "types", columns: ["type", "label", "cloudflareGateway=Cloudflare", "custom", "operations"] },
    },
    summary: ({ types }) => `${plural(types.length, "provider type")}: ${listed(types.map((entry) => entry.type), 30)}.`,
  }),
  tool({
    name: "list_providers",
    title: "List provider connections",
    description:
      "Returns every provider connection your account holds, disabled ones included: id, type, slug, name, status, base URL, custom pricing and revision. Never a key, only its last characters as secretHint. Use it before configuring an app, whose routing names connections by slug.",
    operation: "listProviders",
    cli: { command: "provider list", view: { rows: "providers", columns: ["slug", "type", "status", "id"] } },
    summary: ({ providers }) =>
      providers.length === 0
        ? "No provider connections yet. A provider key is never passed to a tool: add the connection in the console or with agw."
        : `${plural(providers.length, "provider connection")}: ${listed(providers.map((provider) => `${provider.slug} (${provider.type}, ${provider.status})`))}.`,
  }),
  {
    name: "get_provider",
    title: "Get a provider connection",
    description:
      "Returns one provider connection's metadata by its id or its slug: type, name, status, base URL, pricing, revision and secretHint. Never the key itself. Answers provider_not_found when none of your connections has that id or slug.",
    operations: ["listProviders"],
    input: GET_PROVIDER_INPUT,
    annotations: READS,
    cli: {
      command: "provider show",
      args: ["provider"],
      view: { record: "provider", columns: ["slug", "name", "id", "type", "status", "baseUrl=Base URL", "secretHint=Key", "revision", "createdAt=Created"] },
    },
    check: (input) => {
      if (typeof input.provider !== "string" || input.provider === "") {
        throw new GatewayError(400, "invalid_request", "provider: the provider connection's id or slug is required");
      }
    },
    request: () => ({ operation: "listProviders" }),
    result: (body, input) => {
      const { providers } = body as OperationResponse<"listProviders">;
      const wanted = String(input.provider);
      const provider = providers.find((candidate) => candidate.id === wanted) ?? providers.find((candidate) => candidate.slug === wanted);
      // The message never repeats the argument: it may be a key pasted by mistake.
      if (!provider) throw new GatewayError(404, "provider_not_found", "None of your provider connections has this id or slug");
      return { provider };
    },
    summary: (result) => {
      const { provider } = result as { provider: Provider };
      return `Provider connection ${provider.slug} (${provider.type}) is ${provider.status}, at revision ${provider.revision}.`;
    },
  },
  tool({
    name: "list_apps",
    title: "List apps",
    description:
      "Returns every app in your account with its status, revision and whole configuration. Use it to find an app's id, which every other app tool takes as `app`.",
    operation: "listApps",
    cli: {
      command: "app list",
      view: { rows: "apps", columns: ["id", "name", "status", "config.authentication.type=Type", "revision"] },
    },
    summary: ({ apps }) =>
      apps.length === 0 ? "No apps yet." : `${plural(apps.length, "app")}: ${listed(apps.map((app) => `${app.id} (${app.status})`))}.`,
  }),
  tool({
    name: "get_app",
    title: "Get an app",
    description:
      "Returns one app's whole stored document: name, status, revision and its complete configuration. Read it before proposing a change: a change is judged against this document and must carry its revision. Answers app_not_found for an id that is not one of your apps.",
    operation: "getApp",
    cli: {
      command: "app show",
      args: ["app"],
      view: {
        record: "app",
        columns: ["name", "id", "status", "config.authentication.type=Type", "revision", "updated_at=Updated"],
        document: "app.config",
      },
    },
    summary: ({ app }) => `App "${app.name}" (${app.id}) is ${app.status}, at revision ${app.revision}.`,
  }),
  tool({
    name: "get_app_snippet",
    title: "Get first requests for an app",
    description:
      "Returns example requests the app can send today, built by the gateway from its routes and presets: one per API style each provider route serves, and one per preset, each with its URL, headers, model and body or upload, and a model serving admits. An app called with an app key gets each as a curl command that reads the key from $APP_AI_GATEWAY_KEY and gives it to curl on stdin; no key is ever in the answer or in a command's arguments. An iOS app gets each request described in full: it signs them with App Attest through the Swift SDK. Use it to show someone how to make an app's first call.",
    operation: "getAppSnippet",
    cli: {
      command: "app snippet",
      summary: "Show first requests for an app, as curl where it can send them",
      args: ["app"],
      view: { rows: "examples", columns: ["provider", "preset", "operation", "model"], notes: ["notes"], blocks: ["examples.*.text"] },
    },
    summary: ({ app_id, examples }) =>
      examples.length === 0
        ? `No example requests for app ${app_id} yet; the notes say why.`
        : `${plural(examples.length, "example request")} for app ${app_id}: ${listed(examples.map((example) => `${example.provider ?? `preset ${example.preset}`} ${example.style ?? example.operation}`))}.`,
  }),
  {
    name: "validate_app",
    title: "Validate an app configuration",
    description:
      "Checks an app document without saving anything: the {name, config, status?} body creating or updating an app takes. With `app`, it is judged as an update of that app; without, as a new app. A refusal is the reason it would be refused, in the gateway's own words, as a tool error. Use it before any change to an app. To change an existing app, copy name, config and status from the app get_app returns, and nothing else: id, revision, created_at and updated_at are refused here.",
    operations: ["validateApp", "validateAppDraft"],
    input: z.object({
      app: z.string().min(1).optional().meta({ description: "The id of the app this would update. Omit it to judge the document as a new app." }),
      config: APP_DOCUMENT.meta({
        description: "The app document to judge: {name, config, status?}, exactly the body creating or updating an app takes, without id or revision.",
      }),
    }),
    annotations: READS,
    cli: { command: "app validate", args: ["app"] },
    request: (input) =>
      input.app === undefined || input.app === null
        ? { operation: "validateAppDraft", body: input.config }
        : { operation: "validateApp", params: { app: asText(input.app) }, body: input.config },
    summary: (result) => {
      const appId = (result as { app_id?: string }).app_id;
      return appId === undefined ? "The document would be accepted as a new app." : `The document would be accepted as an update of ${appId}.`;
    },
  },
  tool({
    name: "check_app",
    title: "Check whether an app is ready",
    description:
      "Checks whether an app can serve requests, without sending any: checks its stored configuration, lists every provider connection its routing names with that connection's status, and reports ready when the app is active and at least one of them is active. It does not try App Attest, sign-in or the provider keys, and says so in limitations.",
    operation: "checkApp",
    cli: { command: "app check", args: ["app"], view: { rows: "providers", columns: ["slug=Provider", "status", "id"], notes: ["limitations"] } },
    summary: (result) => {
      const active = result.providers.filter((provider) => provider.status === "active").length;
      const standing = `${result.status}, and ${active} of ${plural(result.providers.length, "provider connection")} it names ${active === 1 ? "is" : "are"} active`;
      return `App ${result.app_id} is ${result.ready ? "" : "not "}ready: it is ${standing}. No request was sent.`;
    },
  }),
  tool({
    name: "list_app_keys",
    title: "List an app's keys",
    description:
      "Returns an app-key app's keys as metadata: id, name, the key's first characters, status, when it was created and last used. A key is shown once, when it is created, and never by this tool.",
    operation: "listAppKeys",
    cli: {
      command: "app key list",
      args: ["app"],
      view: { rows: "keys", columns: ["id", "name", "key_prefix=Prefix", "status", "created_at=Created", "last_used_at=Last used"] },
    },
    summary: (result) => {
      const active = result.keys.filter((key) => key.status === "active").length;
      return `${plural(result.keys.length, "key")} for ${result.app_id}, ${active} active. Keys themselves are never returned.`;
    },
  }),
  tool({
    name: "list_app_users",
    title: "List an app's users",
    description:
      "Returns the end users an app has seen, with their status and usage for one month, a page at a time (limit, offset). Filter by part of the user id (query) or by status. Use it to find a user before get_app_user, or to see who is blocked. It does not block or unblock anyone.",
    operation: "listAppUsers",
    cli: {
      command: "app user list",
      args: ["app"],
      view: { rows: "users", columns: ["id", "status", "installs", "usage.charges=Charges", "usage.cost_nano=Cost (nano-$)", "last_seen_at=Last seen"] },
    },
    summary: (result) => `${plural(result.users.length, "user")} of ${result.total} for ${result.app_id} in ${result.month}, from offset ${result.offset}.`,
  }),
  tool({
    name: "get_app_user",
    title: "Get an app user",
    description:
      "Returns one end user of an app: status, installs and usage for one month. Use it to explain why one user is refused or what they cost.",
    operation: "getAppUser",
    cli: {
      command: "app user show",
      args: ["app", "user"],
      view: {
        record: "user",
        columns: ["id", "status", "installs", "created_at=Created", "last_seen_at=Last seen", "usage.charges=Charges", "usage.failed=Failed", "usage.cost_nano=Cost (nano-$)"],
      },
    },
    summary: ({ app_id, month, user }) =>
      `User ${user.id} of ${app_id} is ${user.status}, with ${plural(user.usage.charges, "charge")} costing ${usd(user.usage.cost_nano)} in ${month}.`,
  }),
  tool({
    name: "list_app_jobs",
    title: "List an app's jobs",
    description:
      "Returns the jobs an app submitted through the gateway (such as fal queue jobs), newest first, a page at a time (limit, offset). Each shows the estimate charged at submit, the correction from the provider's final figure, the total, and its state: settled, checking, estimate_kept or gave_up. settled=false lists only the jobs whose estimate was never settled, such as a result that came too late to count. Use it to explain what a job cost. It changes nothing.",
    operation: "listAppJobs",
    cli: {
      command: "app job list",
      args: ["app"],
      view: {
        rows: "jobs",
        columns: ["id", "model", "state", "estimate_nano=Estimate (nano-$)", "correction_nano=Correction (nano-$)", "total_nano=Total (nano-$)", "submitted_at=Submitted"],
      },
    },
    summary: (result) => {
      const settled = result.jobs.filter((job) => job.state === "settled").length;
      return `${plural(result.jobs.length, "job")} of ${result.total} for ${result.app_id}, ${settled} settled, from offset ${result.offset}.`;
    },
  }),
  {
    name: "get_usage",
    title: "Get usage totals",
    description:
      "Returns one UTC month's usage totals: charges, failed and unpriced charges, tokens, session time and cost. With app, for that app; without, for the whole account, with a line per app, deleted apps included, and the day of its oldest kept usage (null when it has never made a call). For a breakdown use get_usage_breakdown; for days use get_usage_timeseries; for single charges use list_app_charges.",
    operations: ["getAppUsage", "getAccountUsage"],
    input: z.object({ app: PATH_ARGUMENTS.app!.optional() }).extend(CATALOG.getAppUsage.query.shape),
    annotations: READS,
    cli: {
      command: "usage show",
      view: { rows: "apps", columns: ["app_id=App", "name", "charges", "failed", "input_tokens=In", "output_tokens=Out", "cost_usd=Cost $", "deleted"] },
    },
    // An explicit null app is the account, as a left-out one is.
    request: (input) => (input.app === undefined || input.app === null ? plainRequest("getAccountUsage", input) : plainRequest("getAppUsage", input)),
    summary: (result) => {
      if ("app_id" in (result as object)) {
        const usage = result as OperationResponse<"getAppUsage">;
        return `${plural(usage.charges, "charge")} costing ${usd(usage.cost_nano)} for ${usage.app_id} in ${usage.month}, ${usage.failed} failed.`;
      }
      const usage = result as OperationResponse<"getAccountUsage">;
      return `${plural(usage.totals.charges, "charge")} costing ${usd(usage.totals.cost_nano)} across ${plural(usage.apps.length, "app")} in ${usage.month}.`;
    },
  },
  tool({
    name: "get_usage_breakdown",
    title: "Get an app's usage by one dimension",
    description:
      "Returns an app's usage grouped by one dimension over a day range (from, to), largest cost first. From day totals, over at most 400 days: model, provider, connection, status, unit. From the charges (kept 90 days), over at most 31 days: user, install, operation, preset, price_source, measured, app_version. Use it to find what drives an app's cost or failures.",
    operation: "getAppUsageBreakdown",
    cli: {
      command: "usage breakdown",
      view: { rows: "rows", columns: ["key", "label", "charges", "failed", "input_tokens=In", "output_tokens=Out", "cost_usd=Cost $"] },
    },
    summary: (result) => `${plural(result.rows.length, "row")} by ${result.by} for ${result.app_id} from ${result.from} to ${result.to}.`,
  }),
  tool({
    name: "get_usage_timeseries",
    title: "Get an app's usage per day",
    description:
      "Returns an app's usage per UTC day and provider type over a day range (from, to; at most 400 days): charges, failures, tokens, session time and cost. Use it to see when a change in traffic or cost began.",
    operation: "getAppUsageTimeseries",
    cli: {
      command: "usage timeseries",
      view: { rows: "buckets", columns: ["day", "provider_type=Provider", "charges", "failed", "cost_usd=Cost $"] },
    },
    summary: (result) => `${plural(result.buckets.length, "daily bucket")} for ${result.app_id} from ${result.from} to ${result.to}.`,
  }),
  tool({
    name: "list_app_charges",
    title: "List an app's charges",
    description:
      "Returns an app's ledger rows one each, newest first: each upstream attempt, session slice and job estimate, and each correction as its own row naming the charge it corrects. Each has its status, provider, model, user, tokens, cost (null for a failed attempt that cost nothing), how it was measured and where its price came from. Filter by kind, status (or failed), provider, connection, model, user, install, operation, owner (a call, session or job id), price_source, measured, trace and a day range; page back with before. Kept 90 days. Filters other than owner and user cover at most 31 days, by default the last 30, unless owner or user is given too. Use it to debug failures or trace one user's traffic; for totals use get_usage.",
    operation: "listAppCharges",
    cli: {
      command: "app charge list",
      args: ["app"],
      view: {
        rows: "charges",
        columns: ["used_at=Time", "kind", "status", "provider_type=Provider", "model", "input_tokens=In", "output_tokens=Out", "cost_usd=Cost $", "measured"],
      },
    },
    summary: (result) => {
      const more = result.next_before === null ? "" : ` More: pass before "${result.next_before}".`;
      return `${plural(result.charges.length, "charge")} for ${result.app_id}.${more}`;
    },
  }),
  tool({
    name: "get_auth_event_summary",
    title: "Summarize an app's sign-in health",
    description:
      "Returns an app's sign-in health over a trailing window of UTC days (days, 1 to 90, default 30): attempts per day by event, outcome and reason, the networks failures came from, failed charges and sampled refusals per day, the token-exchange success rate, how long users waited for an entitlement claim, and how many wait now. Start here when an app's users cannot sign in or get answers, then drill in with list_auth_events or list_rejection_events.",
    operation: "getAppAuthEventSummary",
    cli: {
      command: "app auth-event summary",
      args: ["app"],
      view: { rows: "daily", columns: ["date", "event", "outcome", "reason", "count"] },
    },
    summary: (result) => {
      const attempts = result.daily.reduce((sum, day) => sum + day.count, 0);
      return `${plural(attempts, "sign-in attempt")} for ${result.app_id} from ${result.from} to ${result.to}, ${result.pending_users} waiting on an entitlement claim.`;
    },
  }),
  tool({
    name: "list_auth_events",
    title: "List an app's sign-in attempts",
    description:
      "Returns an app's sign-in attempts one each, newest first: unused challenges, App Attest registrations and token exchanges, with the outcome and reason. Filter by event, outcome, user and a day range; page back with before. Kept 90 days. An event or outcome filter covers at most 31 days, by default the last 30, unless user is given too. Use it to explain why an app's users cannot sign in.",
    operation: "listAppAuthEvents",
    cli: {
      command: "app auth-event list",
      args: ["app"],
      view: { rows: "events", columns: ["created_at=Time", "event", "outcome", "reason", "user_id=User", "network_name=Network"] },
    },
    summary: (result) => {
      const more = result.next_before === null ? "" : ` More: pass before "${result.next_before}".`;
      return `${plural(result.events.length, "sign-in attempt")} for ${result.app_id}.${more}`;
    },
  }),
  tool({
    name: "list_rejection_events",
    title: "List an app's refused requests",
    description:
      "Returns samples of the requests the gateway refused before they reached a provider, newest first: a limit, a model or path the app does not allow, a blocked user, with the reason and whose limit it was (scope). At most one sample a minute per caller, so counts are not exact totals. Filter by reason, scope, user and a day range; page back with before. Kept 90 days. A reason or scope filter covers at most 31 days, by default the last 30, unless user is given too.",
    operation: "listAppRejectionEvents",
    cli: {
      command: "app rejection list",
      args: ["app"],
      view: { rows: "events", columns: ["created_at=Time", "reason", "scope", "model", "user_id=User"] },
    },
    summary: (result) => {
      const more = result.next_before === null ? "" : ` More: pass before "${result.next_before}".`;
      return `${plural(result.events.length, "refusal sample")} for ${result.app_id}.${more}`;
    },
  }),
  tool({
    name: "get_operation",
    title: "Get an operation",
    description:
      "Returns where an operation a change tool opened stands: pending with when it lapses, completed with what it created or changed, or expired (with denied when a person declined it). Use it after giving a person a URL to see when they have finished, and to inspect an operation a notice names before creating another. It never returns a key: when a key the operation created can still be revealed, reveal_url is the page a person opens to see it once.",
    operation: "getOperation",
    // Where a completed create reports the key it made, without its value.
    keyMetadataAt: [["result", "api_key"]],
    input: z.object({
      id: z.string().min(1).meta({ description: "The operation's id: the id the tool that opened it answered, never a reservation's handle." }),
    }),
    cli: {
      command: "operation show",
      args: ["id"],
      view: { record: "", columns: ["id", "kind", "state", "expiresAt=Expires", "reveal_url=Reveal at"] },
    },
    summary: (result) => {
      const declined = result.denied ? ": a person declined it" : "";
      const standing = result.state === "pending" ? ` It lapses at ${result.expiresAt}.` : "";
      const reveal = result.reveal_url === undefined
        ? ""
        : ` A person signed in as an owner or admin reveals the key it created once at ${result.reveal_url}.`;
      return `Operation ${result.id} (${result.kind}) is ${result.state}${declined}.${standing}${reveal}`;
    },
  }),
  {
    name: "add_provider",
    title: "Add a provider connection",
    description:
      "Opens adding a provider connection, such as an OpenAI key, and answers a URL. A person opens it in their browser, enters the key there and approves; the key never passes through you, and an argument carrying one is refused. Takes everything list_providers shows but the key: type, name, and optionally slug, baseUrl, pricing and cloudflareGateway. cloudflareGateway names a Cloudflare AI Gateway (accountId and gatewayId) to send the connection through: the person enters its token on the page, and the provider key is then optional. They are checked now, and nothing is created until the person approves. Call get_operation with the answer's id until it completes. Answers a notice when an identical request was made in the last hour.",
    operations: ["openProviderHandoff"],
    input: CATALOG.openProviderHandoff.request,
    annotations: writes({ destructive: false, idempotent: false }),
    cli: { command: "provider add", args: ["type"], requires: ["browser-step"] },
    next: BROWSER_STEP_NEXT,
    request: (input) => ({ operation: "openProviderHandoff", body: input }),
    result: (body) => ({ ...(body as object), next: BROWSER_NEXT }),
    summary: openedSummary((input) => `add the ${String(input.type)} provider "${String(input.name)}"`),
  },
  {
    name: "update_provider",
    title: "Update a provider connection",
    description:
      "Changes a provider connection's name, custom pricing or status (\"disabled\" pauses it and keeps its key; prefer that to removing it). Send the revision list_providers returned: a connection changed since is refused rather than overwritten. A key is never an argument: change it in the console or with agw.",
    operations: ["updateProvider"],
    input: z.object({ id: PATH_ARGUMENTS.id! }).extend(PROVIDER_UPDATE.omit({ secret: true }).shape),
    annotations: writes({ destructive: false, idempotent: true }),
    cli: { command: "provider update", args: ["id"] },
    next: {
      conflict: "The connection changed since you read it. Call list_providers for its current revision and call update_provider again.",
    },
    request: ({ id, ...body }) => ({ operation: "updateProvider", params: { id: asText(id) }, body }),
    summary: (result) => {
      const { provider } = result as OperationResponse<"updateProvider">;
      return `Provider connection ${provider.slug} (${provider.id}) is updated and ${provider.status}.`;
    },
  },
  {
    name: "rotate_provider_key",
    title: "Replace a provider connection's key",
    description:
      "Opens replacing a provider connection's key and answers a URL. A person opens it in their browser, enters the new key there and approves; the key never passes through you. Send the connection's id and the revision list_providers returned. Call get_operation with the answer's id until it completes.",
    operations: ["openProviderKeyHandoff"],
    input: z.object({ id: PATH_ARGUMENTS.id! }).extend(CATALOG.openProviderKeyHandoff.request.shape),
    annotations: writes({ destructive: false, idempotent: false }),
    cli: { command: "provider rotate-key", args: ["id"], requires: ["browser-step"] },
    next: {
      ...BROWSER_STEP_NEXT,
      conflict: "The connection changed since you read it. Call list_providers for its current revision and call rotate_provider_key again.",
    },
    request: ({ id, ...body }) => ({ operation: "openProviderKeyHandoff", params: { id: asText(id) }, body }),
    result: (body) => ({ ...(body as object), next: BROWSER_NEXT }),
    summary: openedSummary((input) => `replace the key of provider connection ${String(input.id)}`),
  },
  tool({
    name: "remove_provider",
    title: "Remove a provider connection",
    description:
      "Deletes a provider connection and its key, for good: apps that use it start failing within a minute. Only when the person asked for the deletion; update_provider with status \"disabled\" pauses one instead. Pass the connection's id twice, as id and as confirm; without confirm nothing is deleted.",
    operation: "deleteProvider",
    input: operationInput("deleteProvider").extend({ confirm: CONFIRM_ARGUMENT }),
    effect: { destructive: true, idempotent: true },
    cli: { command: "provider remove", args: ["id"], confirm: "id" },
    check: confirmed("id", "provider connection"),
    summary: (result) => `Provider connection ${result.provider_id} is deleted, with its key.`,
  }),
  {
    name: "add_app",
    title: "Create an app",
    description:
      "Creates an app from a document {name, config, status?}, the same one validate_app judges: call validate_app first. Two calls: without handle it checks the document and reserves the creation, creating nothing; with the same document and the answer's handle it creates the app, once. Repeating that call answers the same app again rather than creating another. The gateway assigns the app's id. An app-key app's first key is never in the answer: reveal_url names the page where a person signed in as an owner or admin sees it once.",
    operations: ["createReservedApp"],
    input: z.object({
      config: CATALOG.createApp.request.meta({
        description: "The app document: {name, config, status?}, exactly the body validate_app takes for a new app.",
      }),
      handle: RESERVATION_ARGUMENT,
    }),
    annotations: writes({ destructive: false, idempotent: true }),
    keyMetadataAt: [["api_key"]],
    cli: { command: "app add", requires: ["reservation"] },
    next: reservationNext("add_app"),
    // The document is exactly the body `createApp` takes, read strictly, so a
    // `handle` inside it can never pass for the tool's own.
    check: (input) => {
      const parsed = CATALOG.createApp.request.safeParse(input.config);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = ["config", ...(issue?.path ?? []).map(String)].join(".");
        throw new GatewayError(400, "invalid_request", `${where}: ${issue?.message ?? "is invalid"}`);
      }
    },
    request: (input) => ({
      operation: "createReservedApp",
      body: { ...(input.config as object), ...(input.handle === undefined ? {} : { handle: input.handle }) },
    }),
    summary: reservedSummary(
      "add_app",
      (input) => `creating the app "${String((input.config as { name?: unknown } | undefined)?.name)}"`,
      (result) => {
        const app = result.app as { id?: string; name?: string } | undefined;
        return `Created app "${app?.name}" (${app?.id}).`;
      },
    ),
  },
  {
    name: "update_app",
    title: "Update an app",
    description:
      "Replaces an app's whole document {name, config, status?, revision} with the one given: copy name, config and status from the app get_app returns, change them, check them with validate_app, then send them with the revision get_app returned. id, created_at, updated_at and warnings are refused. To change a few settings, patch_app is shorter and cannot touch anything else. A document read before someone else changed the app is refused with app_revision_conflict rather than overwriting their change. Setting status to \"disabled\" pauses an app.",
    operations: ["updateApp"],
    input: z.object({
      app: PATH_ARGUMENTS.app!,
      config: APP_UPDATE.meta({ description: "The whole app document {name, config, status?, revision}: name, config and status as get_app returns them, plus its revision. Not id, created_at, updated_at or warnings." }),
    }),
    annotations: writes({ destructive: false, idempotent: true }),
    cli: { command: "app replace", summary: "Replace an app's whole document", args: ["app"], view: { record: "app", columns: ["name", "id", "status", "revision"] } },
    next: {
      app_revision_conflict: "Someone changed the app since you read it. Call get_app for its current document and revision, reapply your change and call update_app again.",
      app_revision_required: "Send the revision get_app returned inside config.",
    },
    request: (input) => ({ operation: "updateApp", params: pathOnly("updateApp", input), body: input.config }),
    summary: appSaved,
  },
  {
    name: "patch_app",
    title: "Change part of an app",
    description:
      "Changes only the settings named, leaving the rest of the app as it is: the way to make a small edit. Either send operations, or shortcut arguments, not both. Operations are RFC 6902 add, replace or remove, applied in order, each at a JSON Pointer into get_app's app document: /name, /status, or under /config, such as /config/limits/per_app/requests/per_minute. A value is written as given, so null means unlimited for a limit; only remove deletes. Operations need the revision get_app returned. The common settings have shortcut arguments (name, status, team_id, bundle_id, attest_environments, verify_on), which may be sent without a revision: they apply to the app as it is now. The result is judged exactly as update_app would judge the whole document, and nothing is saved unless every change applies and the result is accepted.",
    operations: ["patchApp", "getApp"],
    input: z
      .object({
        app: PATH_ARGUMENTS.app!,
        revision: APP_PATCH.shape.revision.meta({ description: "The revision get_app returned. Needed with operations; shortcuts alone apply to the app as it is now." }),
        operations: APP_PATCH.shape.operations.optional().meta({
          description: "RFC 6902 add, replace or remove operations at JSON Pointers into get_app's app document, applied in order. Not with shortcuts.",
        }),
      })
      .extend(shortcutInput()),
    annotations: writes({ destructive: false, idempotent: false }),
    cli: { command: "app update", args: ["app"], view: { record: "app", columns: ["name", "id", "status", "revision"] } },
    check: (input) => {
      refuseCredentialTargets(input);
      const shortcuts = usedShortcuts(input).length > 0;
      // One way or the other, as `agw app update` takes its flags.
      if (shortcuts && input.operations !== undefined) {
        throw new GatewayError(400, "invalid_request", "Send operations or shortcuts, not both; nothing was saved");
      }
      if (input.operations !== undefined && (!Array.isArray(input.operations) || input.operations.length === 0)) {
        throw new GatewayError(400, "invalid_request", "operations must be a non-empty list of patch operations, or left out; nothing was saved");
      }
      if (input.revision !== undefined && !APP_PATCH.shape.revision.safeParse(input.revision).success) {
        throw new GatewayError(400, "invalid_request", "revision must be the whole number get_app returned; nothing was saved");
      }
      if (!shortcuts && input.operations === undefined) {
        throw new GatewayError(400, "invalid_request", "Name what to change: a shortcut such as name or status, or operations with the revision; nothing was saved");
      }
      if (input.operations !== undefined && input.revision === undefined) {
        throw new GatewayError(400, "app_revision_required", "Operations need the revision get_app returned; nothing was saved");
      }
      checkShortcuts(input);
    },
    // Shortcuts are turned into operations against the app as it is now.
    before: (input) => (usedShortcuts(input).length === 0 ? null : { operation: "getApp", params: pathOnly("getApp", input) }),
    // Only a call with no revision of its own took it from the read; one that named a revision keeps it, conflict and all.
    retryAfter: (input) => (input.revision === undefined && usedShortcuts(input).length > 0 ? "app_revision_conflict" : null),
    next: {
      app_revision_conflict: "Someone changed the app since you read it. Call get_app for its current revision and settings, check your change still makes sense, and call patch_app again.",
      app_revision_required: "Send the revision get_app returned, or make the change with shortcut arguments alone.",
      invalid_request: "The message names the operation by index, the shortcut, or the setting the result got wrong. Call get_app to see what is at each path, fix it and send the patch again; nothing was saved.",
    },
    request: (input, read) => {
      const current = (read as { app?: ShortcutApp & { revision?: number } } | undefined)?.app;
      const operations = current === undefined ? (input.operations as AppPatchOperation[]) : shortcutOperations(input, current);
      // The caller's revision, when it sent one, is used as it is; the save judges it.
      const revision = input.revision ?? current?.revision;
      return {
        operation: "patchApp",
        params: pathOnly("patchApp", { app: input.app }),
        body: { ...(revision === undefined ? {} : { revision }), operations },
      };
    },
    summary: appSaved,
  },
  tool({
    name: "remove_app",
    title: "Remove an app",
    description:
      "Deletes an app for good, with its keys, end users and App Attest keys; its usage history is kept. Only when the person asked for the deletion; patch_app with status \"disabled\" pauses one instead. Pass the app's id twice, as app and as confirm; without confirm nothing is deleted.",
    operation: "deleteApp",
    input: operationInput("deleteApp").extend({ confirm: CONFIRM_ARGUMENT }),
    effect: { destructive: true, idempotent: true },
    cli: { command: "app remove", args: ["app"], confirm: "app" },
    check: confirmed("app", "app"),
    next: { invalid_request: "Pass the app's id as confirm, exactly as app; nothing was deleted." },
    summary: (result) => `App ${result.app_id} is deleted. Its usage history is kept.`,
  }),
  {
    name: "add_app_key",
    title: "Create an app key",
    description:
      "Creates another key for an app-key app. Two calls: without handle it reserves the key, creating nothing; with the same arguments and the answer's handle it creates it, once. Repeating that call answers the same key again rather than creating another. The key's value is never in the answer: reveal_url names the page where a person signed in as an owner or admin sees it once.",
    operations: ["createReservedAppKey"],
    input: z.object({
      app: PATH_ARGUMENTS.app!,
      name: CATALOG.createReservedAppKey.request.shape.name.meta({ description: "A name to tell the key apart by in list_app_keys." }),
      handle: RESERVATION_ARGUMENT,
    }),
    annotations: writes({ destructive: false, idempotent: true }),
    keyMetadataAt: [["api_key"]],
    cli: { command: "app key add", args: ["app"], requires: ["reservation"] },
    next: reservationNext("add_app_key"),
    request: ({ app, ...rest }) => ({ operation: "createReservedAppKey", params: { app: asText(app) }, body: withHandle(rest) }),
    summary: reservedSummary(
      "add_app_key",
      (input) => `a key named "${String(input.name)}" for ${String(input.app)}`,
      (result) => {
        const key = result.api_key as { id?: string; name?: string } | undefined;
        return `Created key "${key?.name}" (${key?.id}) for ${String(result.app_id)}.`;
      },
    ),
  },
  tool({
    name: "revoke_app_key",
    title: "Revoke an app key",
    description:
      "Revokes one of an app-key app's keys: requests sending it are refused within a minute, and it cannot be restored. Revoking a key that already is answers the same.",
    operation: "revokeAppKey",
    effect: { destructive: true, idempotent: true },
    cli: { command: "app key revoke", args: ["app", "key"], view: { record: "key", columns: ["id", "name", "status"] } },
    summary: (result) => `Key ${result.key.name} (${result.key.id}) of ${result.app_id} is ${result.key.status}.`,
  }),
  tool({
    name: "block_app_user",
    title: "Block an app user",
    description:
      "Blocks one end user of an app: the gateway refuses their sign-in and requests until they are unblocked, within ten seconds everywhere. Blocking a user who already is answers the same. A user list_app_users marks is_virtual cannot be blocked.",
    operation: "blockAppUser",
    effect: { destructive: true, idempotent: true },
    cli: { command: "app user block", args: ["app", "user"] },
    summary: (result) => `User ${result.user_id} of ${result.app_id} is ${result.blocked ? "blocked" : "not blocked"}.`,
  }),
  tool({
    name: "unblock_app_user",
    title: "Unblock an app user",
    description: "Lifts a block on one end user of an app, so their requests are served again.",
    operation: "unblockAppUser",
    effect: { destructive: false, idempotent: true },
    cli: { command: "app user unblock", args: ["app", "user"] },
    summary: (result) => `User ${result.user_id} of ${result.app_id} is ${result.blocked ? "blocked" : "not blocked"}.`,
  }),
];

// ---------------------------------------------------------------------------
// Refusals

/**
 * What an agent should do after a refusal, naming a tool where one helps. The
 * gateway's message says what is wrong; this says what to do about it.
 */
const NEXT_ACTIONS: Partial<Record<ErrorCode, string>> = {
  app_not_found: "Call list_apps for the ids of your apps.",
  provider_not_found: "Call list_providers for the ids and slugs of your provider connections.",
  key_not_found: "Call list_app_keys for the app's key ids.",
  not_found: "Check the id and call the matching list tool.",
  invalid_request: "Correct the arguments as the message says and call the tool again.",
  pricing_not_configured: "Call list_models for the priced models, and allow only those.",
  grant_insufficient: "This credential has the read grant. A change needs a management key with the manage grant, or a connection a person allowed with the manage grant.",
  forbidden: "Your role in this account does not allow this. Ask an owner or admin of the account.",
  session_required: "This needs a person signed in to the console. Ask them to do it there, in a browser.",
  auth_required: "Reconnect with a valid management key or sign in again.",
  rate_limited: "Wait a minute and call the tool again.",
  service_unavailable: "The gateway's infrastructure failed for a moment; nothing about the call was wrong. Wait a few seconds and call the tool again. For a change, first read it back with the matching get or list tool: it may have landed.",
  billing_unavailable: "Billing could not be reached, so nothing was saved. Wait a few seconds and call the tool again.",
  conflict: "Something changed while the call ran. Read it again with the matching get or list tool and retry with what it returns.",
  app_revision_conflict: "Call get_app for the current document and revision, reapply your change and call the tool again.",
  app_revision_required: "Send the revision get_app returned.",
  billing_plan_limit_reached: "The account cannot hold more of these. Remove one it no longer needs, or ask the person.",
  tool_not_found: "Call tools/list for the tools this gateway offers.",
};

export function nextAction(code: ErrorCode): string {
  return NEXT_ACTIONS[code] ?? "Read the message; call get_account to check the account and credential if it is unclear.";
}
