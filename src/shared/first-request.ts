/**
 * The first request an application can send, as data and as code.
 *
 * One source for the console's example card and the CLI's `app snippet`, so the
 * two cannot show different examples. It imports only from `src/shared`, and
 * types from `src/contracts`, for the reason `./capabilities.ts` gives: the
 * console bundles it, so nothing from the Worker modules may reach it.
 *
 * The example is always produced. An application created a minute ago has no
 * provider, no catalogued model, and sometimes a policy that allows no path
 * this module knows the request shape of — and a reader in that position is
 * exactly the one who needs to see what a call looks like. What cannot be
 * resolved becomes a named placeholder and a note saying why, so nothing here
 * ever invents a provider slug or a model ID that would fail on arrival while
 * looking like configuration.
 */

import {
  endpointKind,
  providerPolicyFor,
  reachableProviders,
  type AuthenticationConfig,
  type EndpointConfig,
  type ProviderPolicy,
  type RoutingConfig,
} from "./app-config.ts";
import { API_STYLE_PATHS, ENDPOINT_API_STYLES, type ApiStyle } from "./capabilities.ts";
import { modelKind, type ModelKind } from "./model-kinds.ts";
import { classifyPath, PROTOCOLS } from "./protocols.ts";
import { providerDescriptor, type ProviderType } from "./providers.ts";
import type { ProviderSummary } from "../contracts/responses.ts";

export const PROVIDER_PLACEHOLDER = "PROVIDER_SLUG";
export const MODEL_PLACEHOLDER = "MODEL";
export const BODY_PLACEHOLDER = "REQUEST_BODY";

/** What in an example stands in for configuration that does not exist yet. */
export type ExampleGap = "provider" | "model" | "body";

export const EXAMPLE_GAP_NOTES: Record<ExampleGap, string> = {
  provider: `No provider is configured yet, so ${PROVIDER_PLACEHOLDER} stands in for one. Add a provider key, then use its slug.`,
  model: `No priced model this request can use was found for this provider, so ${MODEL_PLACEHOLDER} stands in for one. Use a model the provider serves.`,
  body: `This app allows no path whose request shape is known here, so ${BODY_PLACEHOLDER} stands in for the body the provider documents.`,
};

/** One entry of an app's proxy policy, as the configuration carries it. */
export type ExamplePolicy = ProviderPolicy;

/**
 * Which providers an app may reach, and under what policy: the application's
 * own routing block, not a projection of it. There is one shape for this and
 * this module reads it directly.
 */
export type ExampleRouting = RoutingConfig;

/** As much of a provider as an example needs: where it sits and what it prices. */
export type ExampleProvider = Pick<
  ProviderSummary,
  "slug" | "type" | "status" | "providerGatewayId" | "pricing"
>;

/** The price catalog, by provider type and model. Only each model's kind is read. */
export type ExamplePrices = Record<string, Record<string, { kind: ModelKind }>>;

/** Where a request goes: a provider path through the proxy, or a custom endpoint. */
export type ExampleTarget =
  | { provider: string; path: string }
  | { endpoint: string };

export interface RequestExample {
  target: ExampleTarget;
  /**
   * Null when no shape is known for the path, which is what the `body` gap
   * means, and for a multipart upload, which `form` describes instead.
   */
  body: Record<string, unknown> | null;
  /** The fields of a multipart upload, a file one as `@<name>`, where the API takes one. */
  form?: Record<string, string>;
  /** Whether the request needs Anthropic's client API version header. */
  anthropic: boolean;
  gaps: ExampleGap[];
}

/**
 * The path a provider type's first call goes to.
 *
 * The provider descriptor carries the type's own answer — OpenAI and Anthropic
 * name their current surfaces, the OpenAI-compatible hosts name whichever
 * prefix they serve one under, and the default is the plain
 * `v1/chat/completions` most of them use. What is decided here is the two
 * things a descriptor cannot answer alone: a type whose native generation path
 * carries the model in the URL has no example without one, and a gateway in
 * front of an OpenAI-compatible host republishes it under the standard path, so
 * the host's own prefix is normalized away. A type whose example is its own
 * Responses or Messages API keeps it either way — every gateway here serves
 * those too.
 */
export function examplePath(
  type: ProviderType,
  { gatewayRouted = false, model }: { gatewayRouted?: boolean; model?: string } = {},
): string | undefined {
  const own = providerDescriptor(type).examplePath ?? API_STYLE_PATHS.chat_completions;
  if (own.includes("{model}")) return model ? own.replace("{model}", model) : undefined;
  return gatewayRouted && own.endsWith("chat/completions")
    ? API_STYLE_PATHS.chat_completions
    : own;
}

/** What an example asks a model of each kind for. */
const PROMPTS: Record<ModelKind, string> = {
  text: "Say hello.",
  image: "A lighthouse at dawn.",
  speech: "Say hello.",
  embedding: "Hello.",
  transcription: "Say hello.",
  realtime: "Say hello.",
};

const hello = (kind: ModelKind) => [{ role: "user", content: PROMPTS[kind] }];

/**
 * The example request each API style takes, for a model of one kind, which only
 * an API carrying several kinds reads. `model` is absent where the gateway sets
 * it — a custom endpoint names its own — and an API that names its model in the
 * URL never takes it in the body. A style with no entry has no example.
 */
const EXAMPLE_BODIES: Partial<Record<ApiStyle, (model: string | undefined, kind: ModelKind) => Record<string, unknown>>> = {
  responses: (model, kind) => ({ model, input: PROMPTS[kind] }),
  chat_completions: (model, kind) => ({ model, messages: hello(kind) }),
  anthropic_messages: (model, kind) => ({ model, max_tokens: 128, messages: hello(kind) }),
  gemini_native: (_model, kind) => ({
    contents: [{ parts: [{ text: PROMPTS[kind] }] }],
    // A speech model answers in audio only when it is asked to.
    ...(kind === "speech" && { generationConfig: { responseModalities: ["AUDIO"] } }),
  }),
  image_generation: (model, kind) => ({ model, prompt: PROMPTS[kind] }),
  embeddings: (model, kind) => ({ model, input: PROMPTS[kind] }),
  gemini_embedding: (_model, kind) => ({ content: { parts: [{ text: PROMPTS[kind] }] } }),
};

/** The multipart upload a transcription takes. */
const TRANSCRIPTION_FORM = { file: "@recording.m4a" };

/**
 * What one style's request looks like for a model of one kind: its body, or
 * its upload, and whether it is Anthropic's API. Null where this module knows
 * no shape for the style.
 */
function exampleRequest(
  style: ApiStyle,
  model: string | undefined,
  kind: ModelKind,
): Pick<RequestExample, "body" | "form" | "anthropic"> | null {
  if (style === "audio_transcription") {
    return { body: null, form: model ? { ...TRANSCRIPTION_FORM, model } : TRANSCRIPTION_FORM, anthropic: false };
  }
  const body = EXAMPLE_BODIES[style]?.(model, kind);
  if (!body) return null;
  // `model: undefined` is a field nobody should see in an example.
  if (body.model === undefined) delete body.model;
  return { body, anthropic: style === "anthropic_messages" };
}

/**
 * The request a path takes, or null where this module knows of none. The
 * path is classified once, by the same classifier the proxy judges it with, so
 * an example never has a shape for a path the gateway would call something
 * else. A model of a kind the path's API does not carry is asked what that API
 * is for instead.
 */
function requestFor(
  path: string,
  model: string,
  kind: ModelKind,
): Pick<RequestExample, "body" | "form" | "anthropic"> | null {
  const { protocol } = classifyPath(path);
  const asked = protocol.kinds.includes(kind) ? kind : protocol.kinds[0] ?? kind;
  return exampleRequest(protocol.style, model, asked);
}

interface ExampleModel {
  model: string;
  kind: ModelKind;
}

/**
 * The models an app may name on a provider, text first: a first request is a
 * text one wherever the app can make one. A model only the instance prices is
 * text by definition, and the catalog's realtime models are left out, because
 * no HTTP request carries one.
 */
function modelsFor(
  provider: ExampleProvider,
  policy: ExamplePolicy | undefined,
  prices: ExamplePrices,
): ExampleModel[] {
  const kindOf = (model: string): ModelKind =>
    modelKind(prices, provider.type, model, provider.pricing) ?? "text";
  const models = policy?.allowed_models?.length
    ? policy.allowed_models
    : [
      ...Object.keys(provider.pricing ?? {}),
      ...Object.entries(prices[provider.type] ?? {})
        .filter(([, price]) => price.kind !== "realtime")
        .map(([model]) => model),
    ];
  const candidates = models.map((model) => ({ model, kind: kindOf(model) }));
  return [
    ...candidates.filter((candidate) => candidate.kind === "text"),
    ...candidates.filter((candidate) => candidate.kind !== "text"),
  ];
}

/**
 * The first model a path's API carries, or none: an allowlist of embeddings
 * paths takes an embedding model even where the app's first model is a text
 * one. An API that names no kinds carries any model.
 */
function modelFor(path: string, models: readonly ExampleModel[]): ExampleModel | undefined {
  const { kinds } = classifyPath(path).protocol;
  return models.find((candidate) => kinds.length === 0 || kinds.includes(candidate.kind));
}

/**
 * The provider's own path for a model of a kind other than text: the one its
 * descriptor composes that kind through, or none.
 */
function kindPath(type: ProviderType, kind: ModelKind, model: string): string | undefined {
  const paths = providerDescriptor(type).endpointPaths ?? {};
  const style = ENDPOINT_API_STYLES.find((candidate) =>
    paths[candidate] !== undefined && PROTOCOLS[candidate].kinds.includes(kind));
  return style ? paths[style]?.replace("{model}", model) : undefined;
}

/**
 * The example this app would send today, using its own policy and catalog.
 *
 * Candidates are tried in configuration order and the first one whose path has
 * a known request shape wins, so a restricted app gets an example inside its
 * own allowlist rather than one the gateway would refuse. Wildcards are skipped
 * for the same reason: a pattern is not a path a client can call.
 */
export function firstRequest(
  routing: ExampleRouting | null | undefined,
  providers: ExampleProvider[],
  prices: ExamplePrices,
): RequestExample {
  let fallback: RequestExample | undefined;
  // With no routing known yet, every active instance is a candidate.
  const candidates = routing
    ? reachableProviders(routing, providers)
    : providers.filter((provider) => provider.status === "active");
  for (const provider of candidates) {
    // The app's own policy for the instance, where it names one; an all-mode
    // app has none of its own and takes the catalog's models and paths.
    const policy = routing?.providers.mode === "selected"
      ? providerPolicyFor(routing, provider.slug)
      : undefined;
    const models = modelsFor(provider, policy, prices);
    const { model, kind } = models[0] ?? { model: MODEL_PLACEHOLDER, kind: "text" };
    const gatewayRouted = Boolean(provider.providerGatewayId);
    // A gateway publishes text APIs alone, so only a direct row has another
    // kind's path to offer.
    const fallbackPath = (kind !== "text" && !gatewayRouted ? kindPath(provider.type, kind, model) : undefined)
      ?? examplePath(provider.type, { gatewayRouted, model });
    const paths = policy?.allowed_paths?.length
      ? policy.allowed_paths
      : fallbackPath
        ? [fallbackPath]
        : [];
    for (const entry of paths) {
      const path = typeof entry === "string" ? entry : entry.path;
      if (path.includes("*")) continue;
      const fixed = typeof entry !== "string" ? entry.fixed_model : undefined;
      // A fixed model is the app's own, so it is never a gap.
      const chosen = fixed
        ? { model: fixed, kind: modelKind(prices, provider.type, fixed, provider.pricing) ?? "text" }
        : modelFor(path, models);
      const request = requestFor(path, chosen?.model ?? MODEL_PLACEHOLDER, chosen?.kind ?? "text");
      const example: RequestExample = {
        target: { provider: provider.slug, path },
        body: request?.body ?? null,
        ...(request?.form && { form: request.form }),
        anthropic: request?.anthropic ?? false,
        gaps: chosen ? [] : ["model"],
      };
      if (request) return example;
      fallback ??= { ...example, gaps: [...example.gaps, "body"] };
    }
  }
  return (
    fallback ?? {
      target: { provider: PROVIDER_PLACEHOLDER, path: "v1/chat/completions" },
      body: requestFor("v1/chat/completions", MODEL_PLACEHOLDER, "text")?.body ?? null,
      anthropic: false,
      gaps: ["provider", "model"],
    }
  );
}

/**
 * The first request to a custom endpoint, which holds its provider, model and
 * parameters: the client sends only what its style and kind document.
 */
export function endpointRequest(slug: string, endpoint: Pick<EndpointConfig, "api_style" | "kind">): RequestExample {
  const request = exampleRequest(endpoint.api_style, undefined, endpointKind(endpoint));
  return {
    target: { endpoint: slug },
    body: request?.body ?? null,
    ...(request?.form && { form: request.form }),
    anthropic: request?.anthropic ?? false,
    gaps: request ? [] : ["body"],
  };
}

/** The notes an example's gaps call for, in the order a reader meets them. */
export function exampleNotes(example: RequestExample): string[] {
  return example.gaps.map((gap) => EXAMPLE_GAP_NOTES[gap]);
}

/** The URL a target is called at, under one gateway and one application. */
export function exampleUrl(baseUrl: string, appId: string, target: ExampleTarget): string {
  const origin = baseUrl.replace(/\/+$/, "");
  const app = `${origin}/v1/apps/${encodeURIComponent(appId)}`;
  return "endpoint" in target
    ? `${app}/endpoints/${encodeURIComponent(target.endpoint)}`
    : `${app}/proxy/${encodeURIComponent(target.provider)}/${target.path}`;
}

/** One shell word, safe to paste: single-quoted, with any quote of its own closed and reopened. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface SnippetOptions {
  baseUrl: string;
  appId: string;
  example: RequestExample;
  /** Lines to explain the example before it, as that language's comments. */
  notes?: string[];
}

function commented(notes: string[] | undefined, marker: string): string {
  return (notes ?? []).map((note) => `${marker} ${note}\n`).join("");
}

/**
 * The same request as a shell command, for a server application.
 *
 * `keyExpression` is what follows `Bearer `, in double quotes so that a shell
 * variable naming the key expands. It is never the key itself: no caller has
 * one to pass, and the CLI, which has just written one to disk, passes the
 * expression that reads it back.
 */
export function curlSnippet(
  options: SnippetOptions & { keyExpression?: string },
): string {
  const { baseUrl, appId, example, notes, keyExpression = "$APP_AI_GATEWAY_KEY" } = options;
  const head =
    commented(notes, "#") +
    `curl --fail-with-body ${shellQuote(exampleUrl(baseUrl, appId, example.target))} \\\n` +
    `  -H "Authorization: Bearer ${keyExpression}" \\\n`;
  if (example.form) {
    // curl writes the multipart content type, boundary included, itself.
    const fields = Object.entries(example.form).map(([name, value]) => `-F ${shellQuote(`${name}=${value}`)}`);
    return `${head}  ${fields.join(" \\\n  ")}\n`;
  }
  const body = example.body ? JSON.stringify(example.body) : BODY_PLACEHOLDER;
  return (
    head +
    `  -H 'Content-Type: application/json' \\\n` +
    (example.anthropic ? "  -H 'anthropic-version: 2023-06-01' \\\n" : "") +
    `  -d ${shellQuote(body)}\n`
  );
}

/**
 * A multipart upload built in Swift: a `@<name>` field is the file of that
 * name, read from disk, and any other field is its value.
 */
function swiftForm(form: Record<string, string>): string {
  const parts = Object.entries(form).map(([name, value]) => {
    if (!value.startsWith("@")) {
      return `form.append(Data("--\\(boundary)\\r\\nContent-Disposition: form-data; name=\\"${name}\\"\\r\\n\\r\\n${value}\\r\\n".utf8))`;
    }
    const file = value.slice(1);
    return `form.append(Data("--\\(boundary)\\r\\nContent-Disposition: form-data; name=\\"${name}\\"; filename=\\"${file}\\"\\r\\n\\r\\n".utf8))
form.append(try Data(contentsOf: URL(fileURLWithPath: ${JSON.stringify(file)})))
form.append(Data("\\r\\n".utf8))`;
  });
  return `
let boundary = UUID().uuidString
var form = Data()
${parts.join("\n")}
form.append(Data("--\\(boundary)--\\r\\n".utf8))
`;
}

/** The note an issuer-signed-in iOS app's example carries, where its token provider is a stand-in. */
export const ISSUER_TOKEN_NOTE =
  "Replace yourIdentitySDK.currentIDToken(forceRefresh: forceRefresh) with your configured issuer integration.";

/**
 * Whether an iOS application's users sign in with an issuer, which is what
 * decides how the Swift client authenticates: an App Attest install alone, or
 * App Attest plus the user's own signed token.
 */
export function swiftSignsInUsers(authentication: AuthenticationConfig | undefined): boolean {
  return authentication?.type === "apple_app_attest" && authentication.end_user.source === "issuer";
}

/** The Swift client's `authMode` argument for an application, from its own configuration. */
function swiftAuthMode(authentication: AuthenticationConfig | undefined): string {
  return swiftSignsInUsers(authentication)
    ? ".appAttest(issuerTokenProvider: { forceRefresh in\n        // Return a fresh signed token from your configured identity SDK.\n        try await yourIdentitySDK.currentIDToken(forceRefresh: forceRefresh)\n    })"
    : ".appAttestInstall";
}

/**
 * The same request through the Swift package, for an iOS application.
 *
 * The client's `authMode` follows from the application's authentication, so
 * every caller writes the same one: an app whose users come from an issuer gets
 * a token provider, one that identifies installs gets the install mode. A
 * caller that cannot read the configuration passes none and gets the latter.
 */
export function swiftSnippet(
  options: SnippetOptions & { authentication?: AuthenticationConfig },
): string {
  const { baseUrl, appId, example, notes, authentication } = options;
  const authMode = swiftAuthMode(authentication);
  const target =
    "endpoint" in example.target
      ? `endpointSlug: ${JSON.stringify(example.target.endpoint)}`
      : `provider: ${JSON.stringify(example.target.provider)},\n    providerPath: ${JSON.stringify(example.target.path)}`;
  // The body goes in through `withAuthorizedRequest`, which signs the request
  // over it where the app verifies App Attest on every request: a body set
  // afterwards is one the proof does not cover, and the gateway refuses it.
  // The closure sends the request, and is called once more on a 401 with a
  // request built afresh; a header the provider needs is added inside it.
  const send = example.anthropic
    ? `{ request in
    var request = request
    request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
    return try await URLSession.shared.data(for: request)
}`
    : "{ try await URLSession.shared.data(for: $0) }";
  const body = example.form
    ? "body: form"
    : example.body
      ? `body: Data(${JSON.stringify(JSON.stringify(example.body))}.utf8)`
      : `// Supply the provider-native JSON body.\n    body: Data(${JSON.stringify(BODY_PLACEHOLDER)}.utf8)`;
  const contentType = example.form
    ? `"multipart/form-data; boundary=\\(boundary)"`
    : `"application/json"`;
  return (
    commented(notes, "//") +
    `import Foundation
import AppAIGateway

let gateway = AppAIGatewayClient(
    appID: ${JSON.stringify(appId)},
    baseURL: URL(string: ${JSON.stringify(baseUrl.replace(/\/+$/, ""))})!,
    authMode: ${authMode}
)
${example.form ? swiftForm(example.form) : ""}
let (data, _) = try await gateway.withAuthorizedRequest(
    ${target},
    ${body},
    contentType: ${contentType}
) ${send}
print(String(decoding: data, as: UTF8.self))
`
  );
}
