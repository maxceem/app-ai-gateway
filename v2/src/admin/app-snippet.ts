/**
 * First requests for an app (v1's app snippet, rebuilt on v2's operation
 * descriptions): what the app can send today, written from its own routes
 * and presets, so a new app is never left to compose its first call from the
 * reference. The console's app page and `agw app snippet` both show this
 * answer, so they never differ.
 *
 * - One example per API style each provider route serves: the first
 *   operation the route lists of that style, at its path, with a model the
 *   route allows or our price list has for that kind of request.
 * - One example per preset, which names its own model.
 * - An app called with an app key gets each as a curl command that reads the
 *   key from `$APP_AI_GATEWAY_KEY`. Nothing here ever holds a key.
 * - An iOS app signs every request with App Attest, which curl cannot do: it
 *   gets the requests without curl, and the Swift SDK has Swift examples.
 */
import type { Context } from "hono";
import { parseServedAppConfig, type AppConfig } from "../contracts/app-config.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { describeConnection } from "../providers/connections.ts";
import type { ApiStyle, OperationDescription, ProviderDescription } from "../providers/operation.ts";
import { readCustomAuth, readPassthrough } from "../providers/passthrough.ts";
import { declaredOperation } from "../providers/presets.ts";
import { PRICE_FILE } from "../pricing/price-file.ts";
import type { AdminVariables } from "./actor.ts";
import { appRow } from "./apps.ts";
import type { ConnectionRow } from "./providers.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;
type Snippet = OperationResponse<"getAppSnippet">;
type Example = Snippet["examples"][number];

const PROMPT = "Hello!";

/** The environment variable every curl example reads the app key from. */
export const APP_KEY_VARIABLE = "APP_AI_GATEWAY_KEY";
/** The one a gateway token is read from, for an app whose users sign in with an issuer. */
export const GATEWAY_TOKEN_VARIABLE = "APP_AI_GATEWAY_TOKEN";

const SWIFT_SDK = "https://github.com/maxceem/app-ai-gateway-swift";

/** How a style's request is sent: a JSON body, a form with a file, or the raw bytes of a file. */
type Shape =
  | { readonly as: "json"; readonly body: Readonly<Record<string, unknown>>; readonly output?: string; readonly headers?: Readonly<Record<string, string>> }
  | { readonly as: "form"; readonly file: { readonly field: string; readonly name: string } }
  | { readonly as: "raw"; readonly file: string; readonly type: string };

/** Each style's smallest useful request, without its model. */
const SHAPES: Readonly<Record<ApiStyle, Shape>> = {
  "openai-chat": { as: "json", body: { messages: [{ role: "user", content: PROMPT }] } },
  "openai-completions": { as: "json", body: { prompt: PROMPT, max_tokens: 64 } },
  "openai-responses": { as: "json", body: { input: PROMPT } },
  "anthropic-messages": {
    as: "json",
    body: { max_tokens: 256, messages: [{ role: "user", content: PROMPT }] },
    headers: { "anthropic-version": "2023-06-01" },
  },
  "gemini-generate": { as: "json", body: { contents: [{ role: "user", parts: [{ text: PROMPT }] }] } },
  "gemini-embed": { as: "json", body: { content: { parts: [{ text: PROMPT }] } } },
  "openai-embeddings": { as: "json", body: { input: PROMPT } },
  "openai-images": { as: "json", body: { prompt: "A lighthouse at dawn" } },
  "openai-speech": { as: "json", body: { input: PROMPT, voice: "alloy" }, output: "speech.mp3" },
  "openai-transcription": { as: "form", file: { field: "file", name: "audio.mp3" } },
  "elevenlabs-transcription": { as: "form", file: { field: "file", name: "audio.mp3" } },
  "deepgram-listen": { as: "raw", file: "audio.wav", type: "audio/wav" },
};

/** The kind of model in our price list each style serves. */
const STYLE_KINDS: Readonly<Record<ApiStyle, string>> = {
  "openai-chat": "text",
  "openai-completions": "text",
  "openai-responses": "text",
  "anthropic-messages": "text",
  "gemini-generate": "text",
  "gemini-embed": "embedding",
  "openai-embeddings": "embedding",
  "openai-images": "image",
  "openai-speech": "speech",
  "openai-transcription": "transcription",
  "elevenlabs-transcription": "transcription",
  "deepgram-listen": "transcription",
};

/** Text as one shell word: single-quoted, with any single quote closed, escaped and reopened. */
export function shellWord(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The kind our price list gives a model of this type, or undefined. */
function listedKind(type: string, model: string): string | undefined {
  const prices = Object.hasOwn(PRICE_FILE, type) ? PRICE_FILE[type]! : undefined;
  const entry = prices !== undefined && Object.hasOwn(prices, model) ? prices[model]! : undefined;
  return typeof entry?.kind === "string" ? entry.kind : undefined;
}

/**
 * The model an example names: the first the route allows of the style's kind
 * (or the first it allows), else the connection's own first price, else the
 * first model our price list has of that kind and still lists. Null for a
 * placeholder.
 */
function exampleModel(connection: ConnectionRow, allowed: readonly string[] | undefined, style: ApiStyle): string | null {
  const kind = STYLE_KINDS[style];
  if (allowed !== undefined && allowed.length > 0) {
    return allowed.find((model) => {
      const listed = listedKind(connection.type, model);
      return listed === undefined || listed === kind;
    }) ?? allowed[0]!;
  }
  if (connection.rates_json !== null) {
    const own = Object.keys(JSON.parse(connection.rates_json) as Record<string, unknown>);
    if (own.length > 0) return own[0]!;
  }
  const prices = Object.hasOwn(PRICE_FILE, connection.type) ? PRICE_FILE[connection.type]! : {};
  const found = Object.entries(prices).find(([, entry]) => entry.kind === kind && entry.unlisted_since === undefined);
  return found?.[0] ?? null;
}

/** The operation's path with its model filled in, or null where the path has another part this example cannot fill. */
function filledPath(operation: OperationDescription, model: string): string | null {
  const location = operation.model;
  let path = operation.match.path.replace(/^\/+/u, "");
  for (const [whole, name] of path.matchAll(/\{(\w+)(?:\.\.\.)?\}/gu)) {
    if (location.in !== "path" || location.part !== name) return null;
    path = path.replace(whole!, encodeURIComponent(model));
  }
  return path;
}

interface Built {
  readonly url: string;
  readonly body?: Record<string, unknown>;
  readonly curl: string;
}

/**
 * One request, built for `operation` at `path` under `base`. `model` is null
 * for a preset, which sends none; a placeholder stands for a model to pick.
 */
function build(base: string, operation: OperationDescription, style: ApiStyle, model: string | null, auth: readonly string[]): Built {
  const shape = SHAPES[style];
  const named = model ?? "";
  const location = operation.model;
  const query = model !== null && location.in === "query" ? `?${new URLSearchParams({ [location.name]: named })}` : "";
  const url = `${base}${query}`;
  const lines = [`curl ${shellWord(url)}`, ...auth];
  let body: Record<string, unknown> | undefined;
  if (shape.as === "json") {
    body = model !== null && location.in === "body" ? { [location.field]: named, ...shape.body } : { ...shape.body };
    for (const [name, value] of Object.entries(shape.headers ?? {})) lines.push(`-H ${shellWord(`${name}: ${value}`)}`);
    lines.push(`-H 'Content-Type: application/json'`, `-d ${shellWord(JSON.stringify(body))}`);
    if (shape.output !== undefined) lines.push(`--output ${shape.output}`);
  } else if (shape.as === "form") {
    lines.push(`-F ${shellWord(`${shape.file.field}=@${shape.file.name}`)}`);
    // --form-string: a model name starting with @ or < is sent as text, never read as a file.
    if (model !== null && location.in === "form") lines.push(`--form-string ${shellWord(`${location.field}=${named}`)}`);
  } else {
    lines.push(`-H ${shellWord(`Content-Type: ${shape.type}`)}`, `--data-binary ${shellWord(`@${shape.file}`)}`);
  }
  return { url, ...(body === undefined ? {} : { body }), curl: lines.join(" \\\n  ") };
}

/** How this app's requests prove who calls, as curl arguments, and what to know about it. */
function callerOf(config: AppConfig, base: string, appId: string): { auth: string[] | null; notes: string[] } {
  const authentication = config.authentication;
  if (authentication.type === "apple_app_attest") {
    return {
      auth: null,
      notes: [
        `This iOS app signs every request with App Attest, which curl cannot do. Send these requests from the app with the Swift SDK, which comes with Swift examples: ${SWIFT_SDK}`,
      ],
    };
  }
  const endUser = authentication.end_user;
  if (endUser.source === "issuer") {
    // One line: a note is shown as one line wherever it is read.
    const exchange = [
      `curl ${shellWord(`${base}/v2/apps/${appId}/auth/token`)}`,
      `-H 'Content-Type: application/json'`,
      `-d '{"api_key":"'"$${APP_KEY_VARIABLE}"'","issuer_token":"<the user token>"}'`,
    ].join(" ");
    return {
      auth: [`-H "Authorization: Bearer $${GATEWAY_TOKEN_VARIABLE}"`],
      notes: [
        `This app's users sign in with their own issuer. First exchange the app key and the user's token for a gateway token, valid for an hour, and set ${GATEWAY_TOKEN_VARIABLE} to its access_token: ${exchange}`,
      ],
    };
  }
  const auth = [`-H "Authorization: Bearer $${APP_KEY_VARIABLE}"`];
  const notes = [`Set ${APP_KEY_VARIABLE} to one of this app's keys. Keep the key on your server: anyone who has it can call the app.`];
  if (endUser.source === "header") {
    auth.push(`-H ${shellWord(`${endUser.header}: user-123`)}`);
    notes.push(`Each request names its end user in ${endUser.header}; user-123 stands for yours.`);
  }
  return { auth, notes };
}

export async function getAppSnippet(c: AdminContext): Promise<Response> {
  const accountId = c.get("actor").accountId;
  const row = await appRow(c.env.DB, accountId, c.req.param("app")!);
  const origin = new URL(c.req.url).origin;
  const answer = (examples: Example[], notes: string[]) =>
    c.json({ app_id: row.id, base_url: origin, examples, notes } satisfies Snippet);
  let config: AppConfig;
  try {
    config = parseServedAppConfig(JSON.parse(row.config_json)).config;
  } catch {
    return answer([], ["This app's stored settings cannot be read, so no example is shown. Save the app again in the console to fix them."]);
  }
  const { results } = await c.env.DB.prepare("SELECT * FROM provider_connection WHERE account_id = ?").bind(accountId).all<ConnectionRow>();
  const connections = new Map(results.map((connection) => [connection.slug, connection]));
  const caller = callerOf(config, origin, row.id);
  const notes = [...caller.notes];
  const examples: Example[] = [];
  const add = (example: Omit<Example, "url" | "body" | "curl">, built: Built) =>
    examples.push({ ...example, url: built.url, ...(built.body === undefined ? {} : { body: built.body }), ...(caller.auth === null ? {} : { curl: built.curl }) });
  let placeholder = false;

  for (const [slug, route] of Object.entries(config.routing.providers)) {
    const connection = connections.get(slug);
    if (connection === undefined) {
      notes.push(`The route ${slug} names no provider connection of yours, so it has no example.`);
      continue;
    }
    if (connection.status !== "active") notes.push(`The provider connection ${slug} is disabled: its requests are refused until it is turned on.`);
    const description: ProviderDescription | null = describeConnection({
      type: connection.type,
      baseUrl: connection.base_url,
      passthrough: readPassthrough(connection.passthrough_json),
      customAuth: readCustomAuth(connection.passthrough_json),
    });
    const seen = new Set<ApiStyle>();
    const without: string[] = [];
    for (const name of route.operations) {
      const operation = description?.operations.find((candidate) => candidate.name === name);
      const style = operation?.style;
      if (operation === undefined || style === undefined) {
        without.push(name);
        continue;
      }
      if (seen.has(style)) continue;
      const model = exampleModel(connection, route.models, style);
      const shown = model ?? "<model>";
      const path = filledPath(operation, shown);
      if (path === null) {
        without.push(name);
        continue;
      }
      seen.add(style);
      if (model === null) placeholder = true;
      add(
        { provider: slug, operation: name, style, method: operation.match.method, model },
        build(`${origin}/v2/apps/${row.id}/proxy/${slug}/${path}`, operation, style, shown, caller.auth ?? []),
      );
    }
    if (without.length > 0) {
      notes.push(`${slug}: ${without.join(", ")} ${without.length === 1 ? "has" : "have"} no example here; send ${without.length === 1 ? "it" : "them"} as the provider's own API reference says, at ${origin}/v2/apps/${row.id}/proxy/${slug}/.`);
    }
  }

  for (const [slug, preset] of Object.entries(config.presets ?? {})) {
    const operation = declaredOperation(preset.operation);
    const style = operation?.style;
    if (operation === undefined || operation === null || style === undefined) {
      notes.push(`The preset ${slug} has no example: its operation ${preset.operation} is not one this gateway knows.`);
      continue;
    }
    add(
      { preset: slug, operation: preset.operation, style, method: "POST", model: null },
      build(`${origin}/v2/apps/${row.id}/presets/${slug}`, operation, style, null, caller.auth ?? []),
    );
  }

  if (placeholder) notes.push("<model> stands for a model to pick: neither the route nor our price list names one for that request.");
  if (examples.length === 0 && Object.keys(config.routing.providers).length === 0) {
    notes.push("This app has no provider routes yet. Add one in the console, or with agw app update, to get an example.");
  }
  return answer(examples, notes);
}
