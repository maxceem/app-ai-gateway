/**
 * Custom providers (plan section 4.5, D10): a provider the gateway does not
 * know. The customer sets its base URL, how its key is sent, and the paths
 * it lists. Each listed path is a passthrough path, served by the same code
 * as a built-in provider's (`./passthrough.ts`), unless it names a built-in
 * API style: then it is an operation of that style, metered by the style's
 * usage reader and priced at the connection's own rates.
 *
 * A connection's description is built here from what it stores, so every
 * part of the gateway (matching, routing, pricing, saving) reads a custom
 * provider exactly as it reads a built-in one.
 *
 * - **Its host.** The base URL is its only host. It passed the origin guard
 *   when saved (`../core/origin-guard.ts`). Cloudflare AI Gateway's host is
 *   refused when saved: a built-in connection's own setting goes there.
 * - **Its paths.** Only the paths the customer lists are served, nothing
 *   else (plan section 4.5).
 * - **Its styles.** An API-style path is a built-in provider's own operation
 *   of that style, at the listed path, with that provider's rules for reading
 *   it (`rules`: service modes, metered transcription formats): the base URL's
 *   own provider where it declares the style, else the style's home provider.
 */
import type { CUSTOM_PATH_STYLES } from "../contracts/admin.ts";
import { GATEWAY_IDENTITY_HEADERS } from "../contracts/app-config.ts";
import { BUILT_IN_PROVIDERS } from "./index.ts";
import { chat, completions, embeddings, images, messages, responses, speech, transcription } from "./llm.ts";
import { readingRules, type ApiStyle, type OperationDescription, type ProviderAuth, type ProviderDescription, type ReadingRules } from "./operation.ts";
import type { PassthroughPath } from "./matcher.ts";
import { meterCases } from "../pricing/units.ts";
import { hasMeasure } from "../usage/observation.ts";
import { NO_SERVICE_TIERS } from "../usage/service-modes.ts";


/**
 * The provider type every custom provider connection has. Kept here, off the
 * management schemas, since a provider request reads it; the contracts
 * re-export it.
 */
export const CUSTOM_PROVIDER_TYPE = "custom";

/** What the console and the CLI call a custom provider. */
export const CUSTOM_LABEL = "Custom provider";

/**
 * The API styles a custom path may name: the styles whose model is in the
 * body or a form field. A style that reads its model from the path
 * (Gemini's) is not offered. Each builder is the shared one built-in
 * providers use (`./llm.ts`), for a style its source provider does not
 * declare itself.
 */
const STYLE_BUILDERS: Readonly<Record<(typeof CUSTOM_PATH_STYLES)[number], (name: string, path: string) => OperationDescription>> = {
  "openai-chat": (name: string, path: string) => chat(name, path),
  "openai-completions": (name: string, path: string) => completions(name, path),
  "openai-responses": (name: string, path: string) => responses(name, path),
  "anthropic-messages": (name: string, path: string) => messages(name, path),
  "openai-embeddings": (name: string, path: string) => embeddings(name, path),
  "openai-images": (name: string, path: string) => images(name, path),
  "openai-transcription": (name: string, path: string) => transcription(name, path),
  "openai-speech": (name: string, path: string) => speech(name, path),
};

/** A style a custom path may name. Each is a built-in API style: a compile error otherwise. */
export type CustomStyle = (typeof CUSTOM_PATH_STYLES)[number];
const EVERY_STYLE_IS_AN_API_STYLE: readonly ApiStyle[] = [] as CustomStyle[];
void EVERY_STYLE_IS_AN_API_STYLE;

/**
 * The built-in provider whose API defines each style: its operation of the
 * style, and its rules for reading it (service modes, metered transcription
 * formats), are what a custom path of the style is, on a host the gateway
 * does not know.
 */
const STYLE_HOME: Readonly<Record<CustomStyle, string>> = {
  "openai-chat": "openai",
  "openai-completions": "openai",
  "openai-responses": "openai",
  "anthropic-messages": "anthropic",
  "openai-embeddings": "openai",
  "openai-images": "openai",
  "openai-transcription": "openai",
  "openai-speech": "openai",
};

export const CUSTOM_STYLES = Object.keys(STYLE_BUILDERS) as readonly CustomStyle[];

export function isCustomStyle(value: string): value is CustomStyle {
  return Object.hasOwn(STYLE_BUILDERS, value);
}

/**
 * The operation name a custom path of `style` is enabled and charged as. One
 * path per style, so the name stays the same when other paths are listed or
 * removed.
 */
export function customOperationName(style: CustomStyle): string {
  return `${CUSTOM_PROVIDER_TYPE}.${style}`;
}

/**
 * How each field of a built-in definition is carried onto a custom path. A
 * new field of `OperationDescription` is a compile error here until it is
 * decided, so none is dropped without a word.
 *
 * - `kept`: the definition's request rules, as they are: its model, its
 *   policy, outbound and background fields, price keys, transport.
 * - `replaced`: its name and path are the custom path's; its meter bills at
 *   the connection's rates only, never at the provider's own dollar report;
 *   its reading rules are its provider's (`rules`).
 * - `refused`: a definition that has it cannot be a custom path (its path is
 *   rewritten upstream, or it is a job or a session): saving refuses the
 *   style there (`customStyleProblem`), rather than serving it without.
 */
export const CARRIED: { readonly [Field in keyof Required<OperationDescription>]: "kept" | "replaced" | "refused" } = {
  name: "replaced",
  match: "replaced",
  multiSegment: "refused",
  upstream: "refused",
  lifecycle: "kept",
  transport: "kept",
  model: "kept",
  style: "kept",
  // A custom path is the customer's own, never one v1 served by its shape.
  v1Layout: "replaced",
  policy: "kept",
  outbound: "kept",
  background: "kept",
  meter: "replaced",
  priceKeys: "kept",
  modelKinds: "kept",
  // A custom path is the customer's own: it serves whatever model ids they send.
  modelIds: "replaced",
  unservedModels: "replaced",
  rawBody: "kept",
  unpricedOptions: "kept",
  responseDeadlineMs: "kept",
  job: "refused",
  session: "refused",
  rules: "replaced",
  uploads: "replaced",
  pricedEveryWay: "replaced",
  storedAudio: "kept",
  rawAudio: "kept",
  rawAudioResponse: "kept",
  audioFormFields: "kept",
  imageFormFields: "kept",
  responseJsonLines: "kept",
};

/**
 * A provider's own operation of `style`: a POST with its model in the body or
 * a form field. The one declared at `path`, the path on the provider's host
 * the custom path sends to, when there is one (Perplexity's
 * `orchestrator/v1/responses` is not its Agent API, though both speak
 * Responses); else the first of the style.
 */
function definitionOf(provider: ProviderDescription, style: CustomStyle, path: string | null): OperationDescription | null {
  const usable = provider.operations.filter(
    (operation) => operation.style === style && operation.match.method === "POST" && (operation.model.in === "body" || operation.model.in === "form"),
  );
  return usable.find((operation) => operation.match.path === path) ?? usable[0] ?? null;
}

/** The path on the base URL's host a custom path sends to: the base URL's own path, then the listed one, without a leading slash. */
export function hostPath(baseUrl: string, path: string): string | null {
  try {
    const prefix = new URL(baseUrl).pathname.replace(/^\/+|\/+$/gu, "");
    const listed = path.replace(/^\/+/u, "");
    return prefix === "" ? listed : `${prefix}/${listed}`;
  } catch {
    return null;
  }
}

/**
 * Where a custom path of `style` takes its definition and rules from: the
 * base URL's own provider where it declares the style (its operation at
 * `path` on its host, where it declares one), else the style's home provider.
 */
export function styleSource(
  style: CustomStyle,
  owner: ProviderDescription | null,
  path: string | null = null,
): { readonly provider: ProviderDescription; readonly definition: OperationDescription | null } {
  const own = owner === null ? null : definitionOf(owner, style, path);
  if (own !== null) return { provider: owner!, definition: own };
  const home = BUILT_IN_PROVIDERS[STYLE_HOME[style]]!;
  return { provider: home, definition: definitionOf(home, style, null) };
}

/**
 * Why a custom path of `style` on `baseUrl` cannot be served as its provider
 * defines it, or null:
 *
 * - its definition has a field a listed path cannot carry (`CARRIED`);
 * - some answer it can return carries no measure a rate can price
 *   (`meterCases`): with no provider dollar report, such an answer could
 *   never be charged, as xAI's images, which report only their cost.
 */
export function customStyleProblem(style: CustomStyle, baseUrl: string, path: string): string | null {
  const owner = knownHostOwner(baseUrl);
  const at = hostPath(baseUrl, path);
  const { provider, definition } = styleSource(style, owner, at);
  if (definition !== null) {
    const refused = (Object.keys(CARRIED) as (keyof OperationDescription)[]).find((field) => CARRIED[field] === "refused" && definition[field] !== undefined);
    if (refused !== undefined) return `${provider.label} serves ${style} in a way a listed path cannot (${refused}); use its built-in connection instead`;
  }
  const unmetered = meterCases(customOperation(style, style, owner, at)).some((way) => way.some((usage) => !hasMeasure(usage)));
  if (unmetered) return `${provider.label}'s ${style} answers can report only their cost, which a custom path does not bill; use its built-in connection instead`;
  return null;
}

/**
 * The operation a custom path of `style` is served as: a built-in
 * provider's own definition of the style (`styleSource`), carried field by
 * field (`CARRIED`), at the listed path, with that provider's rules for
 * reading it (`rules`). Its meter bills at the connection's rates only.
 */
export function customOperation(style: CustomStyle, path: string, owner: ProviderDescription | null = null, at: string | null = null): OperationDescription {
  const name = customOperationName(style);
  const { provider: source, definition: found } = styleSource(style, owner, at);
  const definition = found ?? STYLE_BUILDERS[style](name, path);
  const carried: Record<string, unknown> = {};
  for (const field of Object.keys(CARRIED) as (keyof OperationDescription)[]) {
    if (CARRIED[field] === "kept" && definition[field] !== undefined) carried[field] = definition[field];
  }
  const { meter } = definition;
  // Never the provider's own dollar report: a custom path bills at the connection's rates.
  const billedMeter =
    meter.kind === "response_json" || meter.kind === "response_header" ? (({ providerCost: _report, ...rest }) => rest)(meter as typeof meter & { providerCost?: unknown }) : meter;
  return {
    ...(carried as Omit<OperationDescription, "name" | "match" | "meter">),
    name,
    match: { method: "POST", path },
    meter: billedMeter as OperationDescription["meter"],
    // A listed path of an image style may be a generation or an edit.
    ...(style === "openai-images" ? { uploads: true as const } : {}),
    // No list price or provider report to fall back on: every way its answers come out needs a rate.
    pricedEveryWay: true,
    rules: rulesOf(withOwnModelFields(readingRules(source, definition), owner, source)),
  };
}

/**
 * The style's rules, with the fields where the base URL's own provider takes
 * a model name over them, when the style comes from another provider: a
 * Messages path to OpenRouter reads Anthropic's request, but OpenRouter's
 * `fallbacks` and routers, so every model it may serve is judged.
 */
function withOwnModelFields(rules: ReadingRules, owner: ProviderDescription | null, source: ProviderDescription): ReadingRules {
  if (owner === null || owner === source) return rules;
  return {
    ...rules,
    ...(owner.alternativeModels !== undefined ? { alternativeModels: owner.alternativeModels } : {}),
    ...(owner.choosingModels !== undefined ? { choosingModels: owner.choosingModels } : {}),
  };
}

/** The reading rules a custom path carries: its definition's, field by field. */
function rulesOf(rules: ReadingRules): ReadingRules {
  return {
    serviceModes: rules.serviceModes,
    ...(rules.servedModes !== undefined ? { servedModes: rules.servedModes } : {}),
    ...(rules.transcriptionFormats !== undefined ? { transcriptionFormats: rules.transcriptionFormats } : {}),
    ...(rules.countedInputModalities !== undefined ? { countedInputModalities: rules.countedInputModalities } : {}),
    ...(rules.alternativeModels !== undefined ? { alternativeModels: rules.alternativeModels } : {}),
    ...(rules.choosingModels !== undefined ? { choosingModels: rules.choosingModels } : {}),
    ...(rules.modelNamespaces !== undefined ? { modelNamespaces: rules.modelNamespaces } : {}),
  };
}

/**
 * Every custom operation, at a stand-in path: what an operation of each name
 * is, wherever a connection lists it. For checks that read an operation by
 * name alone (a preset's style, a rewrite's target).
 */
export const CUSTOM_OPERATIONS: readonly OperationDescription[] = CUSTOM_STYLES.map((style) => customOperation(style, style));

/** The host name of a base URL, lower-cased, or null when it does not read. */
function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** A provider's declared host names, lower-cased: its `hosts` and its `otherHosts`. */
export function declaredHostNames(description: ProviderDescription): readonly string[] {
  return [
    ...Object.values(description.hosts).map((value) => value.split("/")[0]!.toLowerCase()),
    ...(description.otherHosts ?? []).map((value) => value.split("/")[0]!.toLowerCase()),
  ];
}

/** Whether `host` is the declared `name`, or under it for a `*.` name. */
export function hostMatches(name: string, host: string): boolean {
  return name.startsWith("*.") ? host.endsWith(name.slice(1)) : host === name;
}

/**
 * The built-in provider whose declared host a base URL is on, or null: whose
 * API a custom path's style is read as there (`styleSource`).
 */
export function knownHostOwner(baseUrl: string): ProviderDescription | null {
  const host = hostOf(baseUrl);
  if (host === null) return null;
  return Object.values(BUILT_IN_PROVIDERS).find((description) => declaredHostNames(description).some((name) => hostMatches(name, host))) ?? null;
}

/** What a custom provider connection stores, as its description is built from. */
export interface CustomSetting {
  readonly baseUrl: string;
  readonly auth: ProviderAuth;
  readonly paths: readonly PassthroughPath[];
}

/**
 * A custom connection's description: its API-style paths as operations, and
 * its base URL's host. Its plain listed paths are passthrough paths, which
 * the description does not hold, as for a built-in provider.
 */
export function customDescription(setting: CustomSetting): ProviderDescription {
  const owner = knownHostOwner(setting.baseUrl);
  const host = hostOf(setting.baseUrl) ?? "";
  const operations = setting.paths.flatMap((listed) =>
    listed.style !== undefined && isCustomStyle(listed.style) && listed.method === "POST"
      ? [customOperation(listed.style, listed.path, owner, hostPath(setting.baseUrl, listed.path))]
      : [],
  );
  return {
    type: CUSTOM_PROVIDER_TYPE,
    label: CUSTOM_LABEL,
    hosts: { main: host },
    auth: setting.auth,
    serviceModes: NO_SERVICE_TIERS,
    operations,
  };
}

/**
 * Header names a custom provider's key may not be sent in: ones the request
 * itself, its body or its connection depend on, the gateway's own, and
 * Cloudflare's. Compared lower-cased.
 */
const RESERVED_KEY_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "cookie",
  "accept",
  "accept-encoding",
  "user-agent",
  "origin",
  "referer",
]);

/** An HTTP header name: RFC 9110 `token`. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/u;

/**
 * Why a custom provider's key header and format cannot be used, or null.
 * The format holds `{key}` exactly once, and only printable ASCII besides,
 * so the header can always be sent.
 */
export function customAuthProblem(auth: ProviderAuth): string | null {
  const header = auth.header;
  if (!HEADER_NAME.test(header)) return "auth.header: must be a header name in lowercase letters, digits and - _ .";
  if (RESERVED_KEY_HEADERS.has(header) || header.startsWith("cf-") || header.startsWith("x-agw-") || header.startsWith("sec-")) {
    return `auth.header: ${header} cannot carry the key`;
  }
  // A header the gateway reads who is calling from would carry the key and a user id at once.
  if (GATEWAY_IDENTITY_HEADERS.has(header)) return `auth.header: ${header} cannot carry the key: the gateway reads who is calling from it`;
  const format = auth.format;
  if (format.split("{key}").length !== 2) return "auth.format: must hold {key} exactly once";
  if (!/^[\x20-\x7e]*$/u.test(format)) return "auth.format: may hold only printable ASCII characters";
  return null;
}
