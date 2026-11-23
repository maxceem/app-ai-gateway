/**
 * First requests for an app (v1's app snippet, rebuilt on v2's operation
 * descriptions): what the app can send today, so a new app is never left to
 * compose its first call from the reference. The console's app page and
 * `agw app snippet` both show this answer, so they never differ.
 *
 * It covers a fixed set of well-known requests on built-in providers, and
 * only those: chat completions in the OpenAI style, OpenAI responses,
 * Anthropic messages, Gemini generateContent, embeddings, image generation
 * and transcription (`COVERED_STYLES`). Anything else (fill-in-the-middle, an
 * image edit, a custom provider's path, an operation with no known body) gets
 * a short note pointing to the provider's own API reference, never a command
 * that the provider or the gateway would refuse.
 *
 * - An example appears only for an active app, on an enabled connection.
 * - Its model is one the app names (the route's model list, its rewrites, the
 *   connection's own prices), or else a curated sample for that exact
 *   operation (`SAMPLE_MODELS`); either only when serving admits it for that
 *   operation (`resolveCall`). With none, a note asks the person to pick one.
 * - A preset is resolved to the operation its connection actually runs, and
 *   judged the same way.
 * - An app called with a key gets curl that never prints a credential
 *   (`./snippet-request.ts`). An iOS app gets each request described in full:
 *   the Swift SDK sends it.
 */
import type { Context } from "hono";
import { parseServedAppConfig, type AppConfig, type ProviderRouting } from "../contracts/app-config.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { describeConnection } from "../providers/connections.ts";
import { CUSTOM_PROVIDER_TYPE } from "../providers/custom.ts";
import { modelBodyField, requestBodyKind, type ApiStyle, type OperationDescription, type ProviderDescription } from "../providers/operation.ts";
import { readCustomAuth, readPassthrough } from "../providers/passthrough.ts";
import { declaredOperation, presetOperation } from "../providers/presets.ts";
import { matcherFor } from "../proxy/serve.ts";
import { priceSources, resolveCall, servedNow } from "../pricing/billability.ts";
import { PRICE_FILE } from "../pricing/price-file.ts";
import type { AdminVariables } from "./actor.ts";
import { appRow } from "./apps.ts";
import type { ConnectionRow } from "./providers.ts";
import { curlCommand, requestText, type SnippetCredential, type SnippetRequest, type TokenExchange } from "./snippet-request.ts";

export { shellWord } from "./snippet-request.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;
type Snippet = OperationResponse<"getAppSnippet">;
type Example = Snippet["examples"][number];

const PROMPT = "Hello!";

/** The environment variable a curl example reads the app key from. */
export const APP_KEY_VARIABLE = "APP_AI_GATEWAY_KEY";
/** The one the user's issuer token is read from, for an app whose users sign in with an issuer. */
export const ISSUER_TOKEN_VARIABLE = "ISSUER_TOKEN";
/** The shell variable a gateway token is kept in, inside the example's own subshell. */
const GATEWAY_TOKEN_VARIABLE = "APP_AI_GATEWAY_TOKEN";

const SWIFT_SDK = "https://github.com/maxceem/app-ai-gateway-swift";

/** The well-known requests an example is written for, each with its smallest useful JSON body without the model (transcription is a form). */
const COVERED_STYLES: Partial<Readonly<Record<ApiStyle, Readonly<Record<string, unknown>> | "form">>> = {
  "openai-chat": { messages: [{ role: "user", content: PROMPT }] },
  "openai-responses": { input: PROMPT },
  "anthropic-messages": { max_tokens: 256, messages: [{ role: "user", content: PROMPT }] },
  "gemini-generate": { contents: [{ role: "user", parts: [{ text: PROMPT }] }] },
  "openai-embeddings": { input: PROMPT },
  "openai-images": { prompt: "A lighthouse at dawn" },
  "openai-transcription": "form",
};

/** Headers a style's API needs that a client may not know to send, as the preset path adds them. */
const STYLE_HEADERS: Partial<Readonly<Record<ApiStyle, Readonly<Record<string, string>>>>> = {
  "anthropic-messages": { "anthropic-version": "2023-06-01" },
};

/** The kind of model in our price list each covered style serves. */
const STYLE_KINDS: Partial<Readonly<Record<ApiStyle, string>>> = {
  "openai-chat": "text",
  "openai-responses": "text",
  "anthropic-messages": "text",
  "gemini-generate": "text",
  "openai-embeddings": "embedding",
  "openai-images": "image",
  "openai-transcription": "transcription",
};

/**
 * A curated sample model for each operation an example may name one for,
 * each one its provider lists today with no retirement date in our price
 * list. Kept small on purpose. Each is still tried through `resolveCall`.
 */
export const SAMPLE_MODELS: Readonly<Record<string, string>> = {
  "openai.chat": "gpt-5.4-mini",
  "openai.responses": "gpt-5.4-mini",
  "openai.embeddings": "text-embedding-3-small",
  "openai.images": "gpt-image-2.6-flare",
  "openai.transcription": "gpt-transcribe",
  "anthropic.messages": "claude-haiku-4-5",
  "gemini.generate.v1beta": "gemini-3.5-flash",
  "deepseek.chat": "deepseek-v4-flash",
  // OpenRouter reports each request's cost itself.
  "openrouter.chat": "openai/gpt-5.4-mini",
};

/** Whether an example is written for this operation: a built-in, served, well-known request that needs nothing an example cannot include. */
function covered(description: ProviderDescription, operation: OperationDescription): boolean {
  const style = operation.style;
  return (
    description.type !== CUSTOM_PROVIDER_TYPE &&
    style !== undefined &&
    COVERED_STYLES[style] !== undefined &&
    servedNow(operation) &&
    // An image edit needs the image it edits.
    (operation.imageFormFields ?? []).length === 0 &&
    // Only the model may be a part of its path.
    [...operation.match.path.matchAll(/\{(\w+)/gu)].every(([, part]) => operation.model.in === "path" && operation.model.part === part)
  );
}

/** The kind our price list gives a model of this type, or undefined. */
function listedKind(type: string, model: string): string | undefined {
  const prices = Object.hasOwn(PRICE_FILE, type) ? PRICE_FILE[type]! : undefined;
  const entry = prices !== undefined && Object.hasOwn(prices, model) ? prices[model]! : undefined;
  return typeof entry?.kind === "string" ? entry.kind : undefined;
}

/**
 * The model an example names, of those whose path the gateway accepts
 * (`pathAccepts`) and that serving admits for this exact operation
 * (`resolveCall`):
 *
 * - the operation's curated sample, known to work on it;
 * - only when the app's own settings exclude it, a model the app names (the
 *   route's model list, its rewrites, the connection's prices) whose billed
 *   model is of the operation's kind, marked `configured`: it works only if
 *   that model serves this endpoint.
 *
 * Null when none is.
 */
function exampleModel(
  connection: ConnectionRow,
  route: ProviderRouting,
  rewrites: AppConfig["routing"]["model_rewrites"],
  operation: OperationDescription,
  pathAccepts: (model: string) => boolean,
): { readonly model: string; readonly configured: boolean } | null {
  const kind = STYLE_KINDS[operation.style!];
  const sources = priceSources(connection);
  const admitted = (candidate: string): boolean => {
    if (!pathAccepts(candidate)) return false;
    const call = resolveCall(route, rewrites, sources, operation, candidate);
    if (call.kind !== "admitted") return false;
    const billed = listedKind(connection.type, call.model);
    return kind === undefined || billed === undefined || billed === kind;
  };
  const sample = SAMPLE_MODELS[operation.name];
  if (sample !== undefined && admitted(sample)) return { model: sample, configured: false };
  const own = [
    ...(route.models ?? []),
    ...Object.keys(rewrites ?? {}),
    ...(connection.rates_json === null ? [] : Object.keys(JSON.parse(connection.rates_json) as Record<string, unknown>)),
  ];
  const found = [...new Set(own)].find(admitted);
  return found === undefined ? null : { model: found, configured: true };
}

/**
 * Whether the gateway's own matcher reads `path` as `operation`, with `model`
 * where the operation reads it: a model whose path the gateway would refuse
 * (a `/` in a path part, say) never makes an example.
 */
function pathAccepts(description: ProviderDescription, operation: OperationDescription, path: string, model: string): boolean {
  const match = matcherFor(description).match(operation.match.method, path);
  if (match.kind !== "operation" || match.operation.name !== operation.name) return false;
  return operation.model.in !== "path" || match.parts[operation.model.part] === model;
}

/** The operation's path with its model filled in. */
function filledPath(operation: OperationDescription, model: string): string {
  const location = operation.model;
  const path = operation.match.path.replace(/^\/+/u, "");
  return location.in === "path" ? path.replace(`{${location.part}}`, encodeURIComponent(model)) : path;
}

/**
 * The request to a covered operation at `url`, by the proxy's own rule for its
 * body (`requestBodyKind`) and model (`modelBodyField`); `model` is null for a
 * preset, which sends none. A sample's output cap never asks for more than
 * the route or the preset allows.
 */
function requestFor(url: string, operation: OperationDescription, model: string | null, endUser: Readonly<Record<string, string>>, outputCap: number | undefined): SnippetRequest {
  const style = operation.style!;
  const field = model === null ? null : modelBodyField(operation);
  const styleHeaders = STYLE_HEADERS[style] ?? {};
  const base = { method: operation.match.method, url };
  if (requestBodyKind(operation) === "form") {
    return {
      ...base,
      headers: { ...endUser, ...styleHeaders },
      ...(field === null ? {} : { form: { [field]: model! } }),
      file: { field: operation.audioFormFields?.[0] ?? "file", name: "audio.mp3" },
    };
  }
  const found = COVERED_STYLES[style] as Readonly<Record<string, unknown>>;
  const shape = outputCap !== undefined && typeof found.max_tokens === "number" ? { ...found, max_tokens: Math.min(found.max_tokens, outputCap) } : found;
  return {
    ...base,
    headers: { ...endUser, ...styleHeaders, "Content-Type": "application/json" },
    body: field === null ? { ...shape } : { [field]: model, ...shape },
  };
}

/** How this app's requests prove who calls: a credential curl sends (after an exchange, for an issuer app), or a line for a person; and what to know about it. */
function callerOf(
  config: AppConfig,
  base: string,
  appId: string,
): { credential: SnippetCredential | null; exchange?: TokenExchange; line: string; endUser: Record<string, string>; notes: string[] } {
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
    return {
      credential: { header: "Authorization", scheme: "Bearer", variable: GATEWAY_TOKEN_VARIABLE },
      exchange: { url: `${base}/v2/apps/${appId}/auth/token`, keyVariable: APP_KEY_VARIABLE, tokenVariable: ISSUER_TOKEN_VARIABLE, into: GATEWAY_TOKEN_VARIABLE },
      line: "Authorization: Bearer <a gateway token, exchanged for an app key and the user's token>",
      endUser: {},
      notes: [
        `This app's users sign in with their own issuer. Set ${APP_KEY_VARIABLE} to an app key and ${ISSUER_TOKEN_VARIABLE} to the user's token: each example first exchanges them for a gateway token, which it never prints.`,
      ],
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

/** A connection's description, as the request path reads it. */
function describe(connection: ConnectionRow): ProviderDescription | null {
  return describeConnection({
    type: connection.type,
    baseUrl: connection.base_url,
    passthrough: readPassthrough(connection.passthrough_json),
    customAuth: readCustomAuth(connection.passthrough_json),
  });
}

/** "a, b and c": several names in a sentence. */
function names(list: readonly string[]): string {
  return list.length === 1 ? list[0]! : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

export async function getAppSnippet(c: AdminContext): Promise<Response> {
  const accountId = c.get("actor").accountId;
  const row = await appRow(c.env.DB, accountId, c.req.param("app")!);
  const origin = new URL(c.req.url).origin;
  const answer = (examples: Example[], notes: string[]) => c.json({ app_id: row.id, base_url: origin, examples, notes } satisfies Snippet);
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
  const add = (example: Pick<Example, "provider" | "preset" | "operation" | "style" | "model" | "caveat">, request: SnippetRequest) => {
    const curl = caller.credential === null ? undefined : curlCommand(request, caller.credential, caller.exchange);
    // A caveat leads the text as a comment, so it is read before the command is run.
    const lead = example.caveat === undefined ? "" : `# ${example.caveat}\n`;
    examples.push({
      ...example,
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.form === undefined ? {} : { form: { ...request.form } }),
      ...(request.file === undefined ? {} : { file: { ...request.file } }),
      ...(curl === undefined ? {} : { curl }),
      text: `${lead}${curl ?? requestText(request, caller.line)}`,
    });
  };
  /** The connection a route or preset names, when it can serve; otherwise a note says why. */
  const usable = (slug: string, what: string): ConnectionRow | null => {
    const connection = connections.get(slug);
    if (connection === undefined) notes.push(`${what} names ${slug}, which is none of your provider connections, so it has no example.`);
    else if (connection.status !== "active") notes.push(`${what} uses the provider connection ${slug}, which is disabled: turn it on to get an example.`);
    else return connection;
    return null;
  };

  for (const [slug, route] of Object.entries(config.routing.providers)) {
    const connection = usable(slug, `The route ${slug}`);
    const description = connection === null ? null : describe(connection);
    if (connection === null || description === null) continue;
    const seen = new Set<ApiStyle>();
    const elsewhere: string[] = [];
    const unpicked: string[] = [];
    for (const name of route.operations) {
      const operation = description.operations.find((candidate) => candidate.name === name);
      if (operation === undefined || !covered(description, operation)) {
        elsewhere.push(name);
        continue;
      }
      if (seen.has(operation.style!)) continue;
      const picked = exampleModel(connection, route, config.routing.model_rewrites, operation, (model) => pathAccepts(description, operation, filledPath(operation, model), model));
      if (picked === null) {
        unpicked.push(name);
        continue;
      }
      const { model, configured } = picked;
      seen.add(operation.style!);
      add(
        {
          provider: slug,
          operation: name,
          style: operation.style!,
          model,
          ...(configured ? { caveat: `Uses this app's configured model ${model}: it works if ${model} supports this endpoint.` } : {}),
        },
        requestFor(`${origin}/v2/apps/${row.id}/proxy/${slug}/${filledPath(operation, model)}`, operation, model, caller.endUser, route.max_output_tokens),
      );
    }
    if (unpicked.length > 0) {
      notes.push(`${slug}: ${names(unpicked)} ${unpicked.length === 1 ? "has" : "have"} no example: pick a model for ${unpicked.length === 1 ? "it" : "them"} and list it in the route.`);
    }
    if (elsewhere.length > 0) {
      notes.push(
        `${slug}: ${names(elsewhere)} ${elsewhere.length === 1 ? "has" : "have"} no example here. Send ${elsewhere.length === 1 ? "it" : "them"} as the provider's own API reference describes, to ${origin}/v2/apps/${row.id}/proxy/${slug}/.`,
      );
    }
  }

  for (const [slug, preset] of Object.entries(config.presets ?? {})) {
    const connection = usable(preset.provider, `The preset ${slug}`);
    const description = connection === null ? null : describe(connection);
    if (connection === null || description === null) continue;
    // Fixed parameters are merged into the body: what it becomes cannot be known safe.
    if (preset.params !== undefined && Object.keys(preset.params).length > 0) {
      notes.push(
        `The preset ${slug} sets fixed parameters, so it has no example here. Send its request as its provider's own API reference describes, without a model, to ${origin}/v2/apps/${row.id}/presets/${slug}.`,
      );
      continue;
    }
    // The operation the preset's connection actually runs.
    const style = declaredOperation(preset.operation)?.style;
    const operation = style === undefined ? null : presetOperation(description, style, preset.operation);
    if (operation === null || !covered(description, operation)) {
      notes.push(`The preset ${slug} has no example here. Send its request as its provider's own API reference describes, without a model, to ${origin}/v2/apps/${row.id}/presets/${slug}.`);
      continue;
    }
    add(
      { preset: slug, operation: operation.name, style: operation.style!, model: null },
      requestFor(`${origin}/v2/apps/${row.id}/presets/${slug}`, { ...operation, match: { ...operation.match, method: "POST" } }, null, caller.endUser, preset.max_output_tokens),
    );
  }

  if (Object.keys(config.routing.providers).length === 0 && Object.keys(config.presets ?? {}).length === 0) {
    notes.push("This app has no provider routes yet. Add one in the console, or with agw app update, to get an example.");
  }
  return answer(examples, notes);
}
