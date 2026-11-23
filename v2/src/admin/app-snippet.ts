/**
 * First requests for an app (v1's app snippet, rebuilt on v2's operation
 * descriptions): what the app can send today, written from its own routes
 * and presets, so a new app is never left to compose its first call from the
 * reference. The console's app page and `agw app snippet` both show this
 * answer, so they never differ.
 *
 * - One example per API style each provider route serves (or per operation,
 *   for one with no style but a known request shape: an upload or a raw
 *   recording): the first operation the route lists of it, at its path.
 * - Its model is the first that serving would admit (`resolveCall`: the
 *   route's model list, the app's rewrites, the connection's own prices and
 *   our price list), of the kind the operation serves. With none, the example
 *   is left out, and a note says why.
 * - The body follows the proxy's own rule for the operation (`requestBodyKind`,
 *   `modelBodyField`): JSON, a form with the file, or the raw recording.
 * - One example per preset, which names its own model.
 * - An app called with a key gets curl that reads the credential from an
 *   environment variable and hands it to curl on stdin (`./snippet-request.ts`).
 *   An iOS app gets each request described in full: the Swift SDK sends it.
 */
import type { Context } from "hono";
import { parseServedAppConfig, type AppConfig, type ProviderRouting } from "../contracts/app-config.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { describeConnection } from "../providers/connections.ts";
import { modelBodyField, requestBodyKind, type ApiStyle, type OperationDescription } from "../providers/operation.ts";
import { readCustomAuth, readPassthrough } from "../providers/passthrough.ts";
import { declaredOperation } from "../providers/presets.ts";
import { priceSources, resolveCall, servedNow } from "../pricing/billability.ts";
import { PRICE_FILE } from "../pricing/price-file.ts";
import type { AdminVariables } from "./actor.ts";
import { appRow } from "./apps.ts";
import type { ConnectionRow } from "./providers.ts";
import { curlCommand, exchangeCommand, requestText, type SnippetCredential, type SnippetRequest } from "./snippet-request.ts";

export { shellWord } from "./snippet-request.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;
type Snippet = OperationResponse<"getAppSnippet">;
type Example = Snippet["examples"][number];

const PROMPT = "Hello!";

/** The environment variable a curl example reads the app key from. */
export const APP_KEY_VARIABLE = "APP_AI_GATEWAY_KEY";
/** The one a gateway token is read from, for an app whose users sign in with an issuer. */
export const GATEWAY_TOKEN_VARIABLE = "APP_AI_GATEWAY_TOKEN";
/** The one the user's issuer token is read from, for the exchange. */
export const ISSUER_TOKEN_VARIABLE = "ISSUER_TOKEN";

const SWIFT_SDK = "https://github.com/maxceem/app-ai-gateway-swift";

/** Each style's smallest useful JSON body, without its model. A form or raw style sends the file alone. */
const JSON_BODIES: Partial<Readonly<Record<ApiStyle, Readonly<Record<string, unknown>>>>> = {
  "openai-chat": { messages: [{ role: "user", content: PROMPT }] },
  "openai-completions": { prompt: PROMPT, max_tokens: 64 },
  "openai-responses": { input: PROMPT },
  "anthropic-messages": { max_tokens: 256, messages: [{ role: "user", content: PROMPT }] },
  "gemini-generate": { contents: [{ role: "user", parts: [{ text: PROMPT }] }] },
  "gemini-embed": { content: { parts: [{ text: PROMPT }] } },
  "openai-embeddings": { input: PROMPT },
  "openai-images": { prompt: "A lighthouse at dawn" },
  "openai-speech": { input: PROMPT, voice: "alloy" },
};

/** Headers a style's API needs that a client may not know to send, as the preset path adds them. */
const STYLE_HEADERS: Partial<Readonly<Record<ApiStyle, Readonly<Record<string, string>>>>> = {
  "anthropic-messages": { "anthropic-version": "2023-06-01" },
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

/** The kind of model an operation serves: its own list's first, else its style's. */
function kindOf(operation: OperationDescription): string | undefined {
  return operation.modelKinds?.[0] ?? (operation.style === undefined ? undefined : STYLE_KINDS[operation.style]);
}

/** The kind our price list gives a model of this type, or undefined. */
function listedKind(type: string, model: string): string | undefined {
  const prices = Object.hasOwn(PRICE_FILE, type) ? PRICE_FILE[type]! : undefined;
  const entry = prices !== undefined && Object.hasOwn(prices, model) ? prices[model]! : undefined;
  return typeof entry?.kind === "string" ? entry.kind : undefined;
}

/**
 * A few sample models, by provider type and API style, each one the provider
 * lists today with no retirement date in our price list. Kept small on
 * purpose: an example names a model the app names itself, or one of these,
 * never one picked from the whole price list. Each is still tried through
 * `resolveCall`, as any candidate is.
 */
export const SAMPLE_MODELS: Readonly<Record<string, Partial<Readonly<Record<ApiStyle, string>>>>> = {
  openai: {
    "openai-chat": "gpt-5.4-mini",
    "openai-responses": "gpt-5.4-mini",
    "openai-embeddings": "text-embedding-3-small",
    "openai-images": "gpt-image-2.6-flare",
    "openai-transcription": "gpt-transcribe",
  },
  anthropic: { "anthropic-messages": "claude-haiku-4-5" },
  gemini: { "gemini-generate": "gemini-3.5-flash" },
  deepseek: { "openai-chat": "deepseek-v4-flash" },
  // OpenRouter reports each request's cost itself.
  openrouter: { "openai-chat": "openai/gpt-5.4-mini" },
};

/**
 * The model an example names: the first serving admits (`resolveCall`, as the
 * proxy calls it) whose billed model is of the operation's kind. With a model
 * list, only its models; else the connection's own prices, the app's
 * rewrites, and the sample for this provider and style. `refused` when the
 * route's own list has none that is admitted; `unknown` when nothing else
 * offers one.
 */
function exampleModel(
  connection: ConnectionRow,
  route: ProviderRouting,
  rewrites: AppConfig["routing"]["model_rewrites"],
  operation: OperationDescription,
): { readonly model: string } | { readonly none: "unknown" | "refused" } {
  const location = operation.model;
  const kind = kindOf(operation);
  const sources = priceSources(connection);
  const sample = operation.style === undefined ? undefined : SAMPLE_MODELS[connection.type]?.[operation.style];
  const candidates =
    location.in === "fixed"
      ? [location.model]
      : route.models ?? [
          ...(connection.rates_json === null ? [] : Object.keys(JSON.parse(connection.rates_json) as Record<string, unknown>)),
          ...Object.keys(rewrites ?? {}),
          ...(sample === undefined ? [] : [sample]),
        ];
  for (const candidate of new Set(candidates)) {
    const call = resolveCall(route, rewrites, sources, operation, candidate);
    if (call.kind !== "admitted") continue;
    const billed = listedKind(connection.type, call.model);
    if (kind === undefined || billed === undefined || billed === kind) return { model: candidate };
  }
  return { none: route.models !== undefined && location.in !== "fixed" ? "refused" : "unknown" };
}

/**
 * Why an operation needs an input an example cannot include, or null: an
 * image edit needs the image it edits. A custom provider's image path is
 * judged by its name, since its description cannot tell an edit apart.
 */
function missingInput(operation: OperationDescription): string | null {
  const editsImages =
    (operation.imageFormFields ?? []).length > 0 || (operation.style === "openai-images" && /(?:^|\/)edits?(?:\/|$)/u.test(operation.match.path));
  return editsImages ? "it needs an image to edit, which an example cannot include" : null;
}

/** The operation's path with its model filled in, or null where the path has another part an example cannot fill. */
function filledPath(operation: OperationDescription, model: string): string | null {
  const location = operation.model;
  let path = operation.match.path.replace(/^\/+/u, "");
  for (const [whole, name] of path.matchAll(/\{(\w+)(?:\.\.\.)?\}/gu)) {
    if (location.in !== "path" || location.part !== name) return null;
    path = path.replace(whole!, encodeURIComponent(model));
  }
  return path;
}

/**
 * The request to `operation` at `url`, by the proxy's own rule for its body
 * (`requestBodyKind`) and its model (`modelBodyField`); `model` is null for a
 * preset, which sends none. Null for an operation whose JSON body this
 * gateway has no example of (one with no style).
 */
function requestFor(
  url: string,
  operation: OperationDescription,
  model: string | null,
  endUser: Readonly<Record<string, string>>,
  outputCap: number | undefined,
): SnippetRequest | null {
  const kind = requestBodyKind(operation);
  const field = model === null ? null : modelBodyField(operation);
  const location = operation.model;
  const query = model !== null && location.in === "query" ? `?${new URLSearchParams({ [location.name]: model })}` : "";
  const style = operation.style;
  const styleHeaders = style === undefined ? {} : (STYLE_HEADERS[style] ?? {});
  const base = { method: operation.match.method, url: `${url}${query}` };
  if (kind === "form") {
    return {
      ...base,
      headers: { ...endUser, ...styleHeaders },
      ...(field === null ? {} : { form: { [field]: model! } }),
      // The form field the operation reads its recording from.
      file: { field: operation.audioFormFields?.[0] ?? "file", name: "audio.mp3" },
    };
  }
  if (kind === "raw") {
    return { ...base, headers: { ...endUser, "Content-Type": "audio/wav" }, file: { name: "audio.wav", type: "audio/wav" } };
  }
  const found = style === undefined ? undefined : JSON_BODIES[style];
  if (found === undefined) return null;
  // A sample's output cap never asks for more than the route or preset allows.
  const shape = outputCap !== undefined && typeof found.max_tokens === "number" ? { ...found, max_tokens: Math.min(found.max_tokens, outputCap) } : found;
  return {
    ...base,
    headers: { ...endUser, ...styleHeaders, "Content-Type": "application/json" },
    body: field === null ? { ...shape } : { [field]: model, ...shape },
    ...(style === "openai-speech" ? { output: "speech.mp3" } : {}),
  };
}

/** How this app's requests prove who calls: a credential curl sends, or a line for a person; and what to know about it. */
function callerOf(
  config: AppConfig,
  base: string,
  appId: string,
): { credential: SnippetCredential | null; line: string; endUser: Record<string, string>; notes: string[]; exchange?: string } {
  const authentication = config.authentication;
  if (authentication.type === "apple_app_attest") {
    return {
      credential: null,
      line: "(The Swift SDK adds the gateway token and the App Attest proof.)",
      endUser: {},
      notes: [
        `This iOS app signs every request with App Attest, which curl cannot do. Send these requests from the app with the Swift SDK, which comes with Swift examples: ${SWIFT_SDK}`,
      ],
    };
  }
  const endUser = authentication.end_user;
  if (endUser.source === "issuer") {
    const exchange = exchangeCommand(`${base}/v2/apps/${appId}/auth/token`, APP_KEY_VARIABLE, ISSUER_TOKEN_VARIABLE);
    return {
      credential: { header: "Authorization", scheme: "Bearer", variable: GATEWAY_TOKEN_VARIABLE },
      line: `Authorization: Bearer <a gateway token, from ${GATEWAY_TOKEN_VARIABLE}>`,
      endUser: {},
      notes: [
        `This app's users sign in with their own issuer. Set ${APP_KEY_VARIABLE} to an app key and ${ISSUER_TOKEN_VARIABLE} to the user's token, exchange them for a gateway token, valid for an hour, with the exchange command, and set ${GATEWAY_TOKEN_VARIABLE} to its access_token.`,
      ],
      exchange,
    };
  }
  const notes = [`Set ${APP_KEY_VARIABLE} to one of this app's keys. Keep the key on your server: anyone who has it can call the app.`];
  const headers: Record<string, string> = {};
  if (endUser.source === "header") {
    headers[endUser.header] = "user-123";
    notes.push(`Each request names its end user in ${endUser.header}; user-123 stands for yours.`);
  }
  return {
    credential: { header: "Authorization", scheme: "Bearer", variable: APP_KEY_VARIABLE },
    line: `Authorization: Bearer <an app key, from ${APP_KEY_VARIABLE}>`,
    endUser: headers,
    notes,
  };
}

export async function getAppSnippet(c: AdminContext): Promise<Response> {
  const accountId = c.get("actor").accountId;
  const row = await appRow(c.env.DB, accountId, c.req.param("app")!);
  const origin = new URL(c.req.url).origin;
  const answer = (examples: Example[], notes: string[], exchange?: string) =>
    c.json({ app_id: row.id, base_url: origin, examples, notes, ...(exchange === undefined ? {} : { exchange }) } satisfies Snippet);
  // A disabled app's requests are all refused: nothing to run until it is turned on.
  if (row.status !== "active") {
    return answer([], ["This app is disabled: every request to it is refused. Turn it on in the console, or with agw app update --status active, to get examples."]);
  }
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
  const add = (example: Pick<Example, "provider" | "preset" | "operation" | "style" | "model">, request: SnippetRequest) => {
    const curl = caller.credential === null ? undefined : curlCommand(request, caller.credential);
    examples.push({
      ...example,
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.form === undefined ? {} : { form: { ...request.form } }),
      ...(request.file === undefined ? {} : { file: { ...request.file } }),
      ...(curl === undefined ? {} : { curl }),
      text: curl ?? requestText(request, caller.line),
    });
  };

  for (const [slug, route] of Object.entries(config.routing.providers)) {
    const connection = connections.get(slug);
    if (connection === undefined) {
      notes.push(`The route ${slug} names no provider connection of yours, so it has no example.`);
      continue;
    }
    if (connection.status !== "active") notes.push(`The provider connection ${slug} is disabled: its requests are refused until it is turned on.`);
    const description = describeConnection({
      type: connection.type,
      baseUrl: connection.base_url,
      passthrough: readPassthrough(connection.passthrough_json),
      customAuth: readCustomAuth(connection.passthrough_json),
    });
    const seen = new Set<string>();
    const without: string[] = [];
    const unpriced: string[] = [];
    const unknown: string[] = [];
    const needs: string[] = [];
    for (const name of route.operations) {
      const operation = description?.operations.find((candidate) => candidate.name === name);
      if (operation === undefined) {
        without.push(name);
        continue;
      }
      // Before the style is counted as shown: an image edit says why it has no example wherever the route lists it.
      const missing = missingInput(operation);
      if (missing !== null) {
        needs.push(`${name}: ${missing}`);
        continue;
      }
      const key = operation.style ?? operation.name;
      if (seen.has(key)) continue;
      // Not served yet (a live session), or a JSON body this gateway has no example of.
      if (!servedNow(operation) || (requestBodyKind(operation) === "json" && (operation.style === undefined || JSON_BODIES[operation.style] === undefined))) {
        without.push(name);
        continue;
      }
      const picked = exampleModel(connection, route, config.routing.model_rewrites, operation);
      if ("none" in picked) {
        (picked.none === "unknown" ? unknown : unpriced).push(name);
        continue;
      }
      const { model } = picked;
      const path = filledPath(operation, model);
      const request =
        path === null ? null : requestFor(`${origin}/v2/apps/${row.id}/proxy/${slug}/${path}`, operation, model, caller.endUser, route.max_output_tokens);
      if (request === null) {
        without.push(name);
        continue;
      }
      seen.add(key);
      add({ provider: slug, operation: name, ...(operation.style === undefined ? {} : { style: operation.style }), model }, request);
    }
    for (const line of needs) notes.push(`${slug}: ${line}, so it has no example.`);
    if (unknown.length > 0) {
      notes.push(
        `${slug}: ${unknown.join(", ")} ${unknown.length === 1 ? "has" : "have"} no example: no sample model is known for it on ${connection.type}. Pick one: list it in the route, and the example names it.`,
      );
    }
    if (unpriced.length > 0) {
      notes.push(`${slug}: ${unpriced.join(", ")} ${unpriced.length === 1 ? "has" : "have"} no example: no model this route allows can be billed there.`);
    }
    if (without.length > 0) {
      notes.push(`${slug}: ${without.join(", ")} ${without.length === 1 ? "has" : "have"} no example here; send ${without.length === 1 ? "it" : "them"} as the provider's own API reference says, at ${origin}/v2/apps/${row.id}/proxy/${slug}/.`);
    }
  }

  for (const [slug, preset] of Object.entries(config.presets ?? {})) {
    const operation = declaredOperation(preset.operation);
    const request =
      operation === null || missingInput(operation) !== null
        ? null
        : requestFor(`${origin}/v2/apps/${row.id}/presets/${slug}`, { ...operation, match: { ...operation.match, method: "POST" } }, null, caller.endUser, preset.max_output_tokens);
    if (operation === null || request === null) {
      notes.push(`The preset ${slug} has no example: its operation ${preset.operation} has no request shape this gateway can write.`);
      continue;
    }
    add({ preset: slug, operation: preset.operation, ...(operation.style === undefined ? {} : { style: operation.style }), model: null }, request);
  }

  if (examples.length === 0 && Object.keys(config.routing.providers).length === 0) {
    notes.push("This app has no provider routes yet. Add one in the console, or with agw app update, to get an example.");
  }
  return answer(examples, notes, caller.exchange);
}
