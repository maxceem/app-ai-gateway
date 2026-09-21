/**
 * A provider type, in one object.
 *
 * Everything this deployment knows about a provider type — where it lives, how
 * it authenticates, what its own request shape clamps, what a probe may call,
 * what a first example request looks like, which named endpoints it composes,
 * how it reports cost — is one entry in {@link PROVIDER_DESCRIPTORS}. Adding a
 * type is that entry plus its prices, and nothing else: the tables below are
 * derived, and the behaviour that reads them lives in `src/core`.
 *
 * It used to be spread over six tables in five files — a type list, an auth
 * map, a registry, a clamp map, a probe-path map, a capability exception table
 * — and each of them could be the one somebody forgot. A type missing from the
 * clamp map was a type error; a type missing from the probe map was silently
 * unprobed, which reads exactly like "this provider has no cheap call".
 *
 * Shared with the console, which bundles this module directly: it imports only
 * `./capabilities.ts`, `./cost-report.ts` and `./records.ts`, all of which are
 * plain tables and pure functions for the same reason.
 */

import {
  API_STYLES,
  type ApiStyle,
  type EndpointApiStyle,
  type OutputClampStyle,
  type RouteCapability,
} from "./capabilities.ts";
import { type CostReport, OPENROUTER_COST_REPORT } from "./cost-report.ts";

/**
 * How a provider authenticates a direct call. The header name and the scheme
 * prefix are free-form: providers name their key header whatever they like
 * (`x-api-key`, `x-goog-api-key`, `DeepL-Auth-Key`), and the sanitizer derives
 * its strip list from these declarations rather than repeating them.
 */
export interface ProviderAuth {
  header: string;
  scheme?: string;
}

export interface ProviderDescriptor {
  /** The provider's own origin, which a row's operator-supplied one replaces. */
  directBaseUrl: string;
  auth: ProviderAuth;
  /**
   * The output-cap field this provider's own request shape uses, for a
   * provider-native path with no cross-provider style of its own.
   */
  nativeClampStyle: OutputClampStyle;
  /**
   * The cheapest authenticated GET under {@link directBaseUrl}. Absent only
   * when the provider has no such call, and its credentials are then accepted
   * unvalidated and flagged in the console — never because a plausible path was
   * untested. An entry that answers 200 to an invalid key would be worse than
   * no entry at all: it would report every key as good.
   */
  probePath?: string;
  /**
   * The path a first example request goes to, for the console's example card,
   * the CLI's `app snippet` and the published capabilities. Absent where the
   * provider's own surface needs the model in the path, which is no path a
   * client could call as it stands — see {@link modelInPath}.
   *
   * Absent also means the OpenAI-compatible default (`v1/chat/completions`),
   * which is what most of these types serve; only a type whose prefix or whose
   * current surface differs says so.
   */
  examplePath?: string;
  /**
   * This type's native generation paths carry the model in the URL rather than
   * in the request body, so a request on one has its model captured from — and
   * rewritten into — the path.
   */
  modelInPath?: true;
  /**
   * The chat-completions output cap this type reads, where it is not the
   * `max_tokens` every other OpenAI-compatible service takes.
   */
  chatCompletionsCapField?: "max_completion_tokens";
  /**
   * Native paths the gateway composes named endpoints against, and so the
   * endpoint styles this type supports: the gateway writes those request
   * bodies itself, and nothing has been verified against a type with no entry
   * here. The key set *is* the capability — see {@link providerCapability}.
   */
  endpointPaths?: Partial<Record<EndpointApiStyle, string>>;
  /**
   * The only client API styles this type serves. Absent means every style,
   * which is the pass-through default: the raw proxy forwards whatever was
   * asked for and the provider itself answers for the paths it does not have.
   */
  apiStyles?: readonly ApiStyle[];
  /**
   * How this provider reports what a request cost, per request, in its own
   * response — the parsing, the headers that ask for it, and any request rewrite
   * it needs, all owned by the declaration. Absent means it reports nothing,
   * which is the fail-closed default: such traffic is only billable when the
   * canonical model has a local price.
   *
   * There is deliberately no boolean here. A flag would have to be paired with
   * parsing somewhere else, and the day a second reporting provider set it, it
   * would bypass the local-price gate while the shared parser read fields that
   * provider never sends — every request billable and every one unresolved.
   */
  costReport?: CostReport;
  /**
   * Who makes the models this provider type serves, when one answer is right
   * for all of them. Absent for aggregators, which serve many authors' models
   * and resolve authorship per model instead.
   */
  modelAuthor?: string;
  /**
   * Whether this type's model IDs namespace the model's author, so authorship
   * can be read off the slug itself (`MODEL_AUTHOR_NAMESPACES` in
   * `src/core/providers.ts`). Set for aggregators, whose catalogs span every lab
   * and bypass the price catalog that carries authorship for everyone else.
   */
  authorNamespacedModels?: boolean;
  /**
   * Headers the gateway sets on every direct call beyond authentication,
   * because the provider only volunteers something it is asked for. Injected
   * server-side and stripped off client requests, exactly like {@link auth}.
   */
  requestHeaders?: Readonly<Record<string, string>>;
  /**
   * Headers the *credential probe* needs beyond authentication, where the
   * provider refuses a bare authenticated GET without them. Kept apart from
   * {@link requestHeaders} because those are injected into live traffic and
   * stripped off client requests, which is wrong for a header a client is
   * entitled to choose. Declared so `provider-probe.ts` never has to name a
   * provider type.
   */
  probeHeaders?: Readonly<Record<string, string>>;
}

/**
 * Gateway routing is deliberately absent: which gateway reaches which provider
 * type is the gateway adapter's business (`src/core/gateways.ts`), so adding a
 * provider type never means editing an adapter.
 */
export const PROVIDER_DESCRIPTORS = {
  openai: {
    directBaseUrl: "https://api.openai.com/",
    auth: { header: "authorization", scheme: "Bearer " },
    nativeClampStyle: "responses",
    probePath: "v1/models",
    examplePath: "v1/responses",
    // OpenAI's chat-completions surface deprecated `max_tokens` in favour of
    // `max_completion_tokens`; every other OpenAI-compatible service still
    // reads the older field.
    chatCompletionsCapField: "max_completion_tokens",
    // The two types whose Responses and transcription request shapes the
    // gateway composes itself for named endpoints.
    endpointPaths: { responses: "v1/responses", transcription: "v1/audio/transcriptions" },
    modelAuthor: "OpenAI",
  },
  anthropic: {
    directBaseUrl: "https://api.anthropic.com/",
    auth: { header: "x-api-key" },
    nativeClampStyle: "anthropic",
    probePath: "v1/models",
    examplePath: "v1/messages",
    modelAuthor: "Anthropic",
    // Anthropic refuses any request without a version header, probe included —
    // and a probe has no client to send one for it. Deliberately not a
    // `requestHeaders` entry: on live traffic this is the *client's* API version,
    // set by every Anthropic SDK, and pinning it server-side would strip that
    // choice and silently downgrade every request to the oldest version.
    probeHeaders: { "anthropic-version": "2023-06-01" },
  },
  xai: {
    directBaseUrl: "https://api.x.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
    nativeClampStyle: "responses",
    probePath: "v1/models",
    // Native provider paths: xAI transcribes at `v1/stt`, where OpenAI serves
    // `v1/audio/transcriptions`.
    endpointPaths: { responses: "v1/responses", transcription: "v1/stt" },
    modelAuthor: "xAI",
  },
  gemini: {
    directBaseUrl: "https://generativelanguage.googleapis.com/",
    auth: { header: "x-goog-api-key" },
    nativeClampStyle: "gemini_native",
    probePath: "v1beta/models",
    // Native Gemini generation requests carry the model in the URL rather than
    // in the JSON body, so there is no example path without a model and a
    // request on one has its model captured from the path.
    modelInPath: true,
    modelAuthor: "Google",
  },
  perplexity: {
    directBaseUrl: "https://api.perplexity.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
    nativeClampStyle: "responses",
    // No `probePath`: Perplexity has no unmetered authenticated endpoint.
    examplePath: "chat/completions",
    modelAuthor: "Perplexity",
  },

  // OpenAI-compatible chat-completions services. `modelAuthor` is set only
  // where one answer is right for every model the type serves; the hosts below
  // that carry no author serve other labs' open-weight models, and authorship
  // comes from the catalog entry per model instead.

  deepseek: {
    // No `v1` segment: DeepSeek documents the bare origin as its OpenAI base
    // URL, and `https://api.deepseek.com/anthropic` for the Anthropic format.
    directBaseUrl: "https://api.deepseek.com/",
    auth: { header: "authorization", scheme: "Bearer " },
    nativeClampStyle: "chat_completions",
    // DeepSeek's OpenAI base URL carries no `v1` segment.
    probePath: "models",
    examplePath: "chat/completions",
    modelAuthor: "DeepSeek",
  },
  groq: {
    // Groq's OpenAI-compatible surface lives under `openai/v1/`, so the client
    // path is `openai/v1/chat/completions` rather than `v1/chat/completions`.
    directBaseUrl: "https://api.groq.com/",
    auth: { header: "authorization", scheme: "Bearer " },
    nativeClampStyle: "chat_completions",
    // Groq's OpenAI-compatible surface is namespaced under `openai/`.
    probePath: "openai/v1/models",
    examplePath: "openai/v1/chat/completions",
  },
  mistral: {
    directBaseUrl: "https://api.mistral.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
    nativeClampStyle: "chat_completions",
    probePath: "v1/models",
    modelAuthor: "Mistral",
  },
  together: {
    // `api.together.ai`, not the `.xyz` host older SDKs default to: the current
    // OpenAI-compatibility guide names this one and warns against the other.
    directBaseUrl: "https://api.together.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
    nativeClampStyle: "chat_completions",
    probePath: "v1/models",
  },
  fireworks: {
    // The inference plane is `/inference/v1`; `/v1` on the same host is the
    // control plane, so the client path is `inference/v1/chat/completions`.
    directBaseUrl: "https://api.fireworks.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
    nativeClampStyle: "chat_completions",
    // No `probePath`: its list-models call is `v1/accounts/{account}/models`,
    // and the account id cannot be derived from the key. Nothing under
    // `inference/v1/` is documented as a GET.
    examplePath: "inference/v1/chat/completions",
  },
  cerebras: {
    directBaseUrl: "https://api.cerebras.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
    nativeClampStyle: "chat_completions",
    probePath: "v1/models",
  },
  moonshot: {
    // The international host. `api.moonshot.cn` is the separate China platform
    // and is not reachable with a key issued for this one.
    directBaseUrl: "https://api.moonshot.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
    nativeClampStyle: "chat_completions",
    probePath: "v1/models",
    modelAuthor: "Moonshot AI",
  },
  huggingface: {
    // The Inference Providers router: one OpenAI-compatible surface in front of
    // many upstreams, so it has no author of its own and no stable per-model
    // price — the router picks the upstream, and the same model ID costs an
    // order of magnitude more on some of them than others. It ships with no
    // catalog section for that reason; see `catalogPrice` in usage.ts.
    directBaseUrl: "https://router.huggingface.co/",
    auth: { header: "authorization", scheme: "Bearer " },
    nativeClampStyle: "chat_completions",
    // No `probePath`: `router.huggingface.co/v1/models` is public — it answers
    // 200 to a garbage token, so probing it would validate every key. The
    // endpoint that does check a token lives on a different origin
    // (`huggingface.co`), which a path under this base URL cannot express.
  },
  baseten: {
    // The Model APIs inference host. `api.baseten.co` is the management plane
    // for dedicated deployments and answers to different paths entirely.
    directBaseUrl: "https://inference.baseten.co/",
    auth: { header: "authorization", scheme: "Bearer " },
    nativeClampStyle: "chat_completions",
    probePath: "v1/models",
  },
  bytedance: {
    // BytePlus ModelArk, the international edition: `/api/v3` is its version
    // segment, so client paths carry no `v1`. `ark.cn-beijing.volces.com` is
    // the separate China platform, and `ark.eu-west.bytepluses.com` is a second
    // region — keys and catalogs are region-isolated, so reaching either needs
    // the per-row base URL override that Stage 6 introduces.
    directBaseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3/",
    auth: { header: "authorization", scheme: "Bearer " },
    nativeClampStyle: "chat_completions",
    // No `probePath`: ModelArk publishes no list-models call, and its own SDK
    // has no models resource. It also authenticates before it routes, so every
    // path answers the same 401 and a probe would prove nothing about the key.
    examplePath: "chat/completions",
  },

  openrouter: {
    // An aggregator treated as a provider type: it is the counterparty that
    // bills the organization, and its slugs (`google/gemini-3.6-flash`) are the
    // canonical model IDs here — there is no underlying ID to translate to.
    // `/api/v1` is its documented server URL, so the client path is
    // `v1/chat/completions` under this origin.
    directBaseUrl: "https://openrouter.ai/api/",
    auth: { header: "authorization", scheme: "Bearer " },
    nativeClampStyle: "chat_completions",
    // OpenRouter's key-status call, not its model list: `v1/models` is public
    // and answers 200 to any token, exactly the trap `huggingface` has no
    // probe for. `v1/key` answers 401 to a key that does not exist.
    probePath: "v1/key",
    // The one narrowed API surface, and it is a metering constraint rather than
    // a missing one: OpenRouter also serves `/responses` and `/messages`, but
    // only its chat-completions response carries `usage.cost`, and its slugs
    // have no local price. Any other style would proxy traffic nothing could
    // bill — exactly the silent $0 the fail-closed gate exists to prevent — so
    // it is refused at the edge instead.
    apiStyles: ["chat_completions"],
    // Every chat-completions response carries `usage.cost`: what OpenRouter
    // actually charged for that request, which beats any local estimate of a
    // catalog this deployment does not track. It is also the only way to bill
    // the type at all, since no static price list covers 400 models across
    // every lab. The declaration owns the parsing and the header that asks for
    // the routing metadata — see `src/shared/cost-report.ts`.
    costReport: OPENROUTER_COST_REPORT,
    // No `modelAuthor`: an aggregator serves everyone's models, and the slug
    // namespace answers per model instead.
    authorNamespacedModels: true,
  },
} as const satisfies Record<string, ProviderDescriptor>;

/** Every provider type this deployment can reach, and the only ones. */
export type ProviderType = keyof typeof PROVIDER_DESCRIPTORS;

/**
 * The descriptor keys as a list, in declaration order. It is what the contracts
 * publish as the creatable `type` enum, so there is no second list to keep in
 * step with the table.
 */
export const PROVIDER_TYPES = Object.keys(PROVIDER_DESCRIPTORS) as [
  ProviderType,
  ...ProviderType[],
];

/**
 * The table entry widened to {@link ProviderDescriptor}. The table itself is
 * `as const` so `auth.scheme` narrows per entry; reading an optional field off
 * that literal type needs the declared shape back.
 */
export function providerDescriptor(type: ProviderType): ProviderDescriptor {
  return PROVIDER_DESCRIPTORS[type];
}

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === "string" && Object.hasOwn(PROVIDER_DESCRIPTORS, value);
}

/**
 * Every header a provider authenticates with, deduplicated. Derived, so a type
 * that names its key header something new is refused in an application
 * configuration the moment its descriptor lands.
 */
export const PROVIDER_CREDENTIAL_HEADERS: readonly string[] = [
  ...new Set(
    PROVIDER_TYPES.map((type) => providerDescriptor(type).auth.header.toLowerCase()),
  ),
];

/**
 * What a provider type can do on its own API. The raw proxy is a pass-through,
 * so every style reaches every provider unless the descriptor narrows them, and
 * the provider itself answers for the paths it does not have; named endpoints
 * are exactly the ones the descriptor gives a path to compose against, because
 * the gateway writes those request bodies itself.
 */
export function providerCapability(provider: ProviderType): RouteCapability {
  const descriptor = providerDescriptor(provider);
  return {
    apiStyles: descriptor.apiStyles ?? API_STYLES,
    endpointStyles: Object.keys(descriptor.endpointPaths ?? {}) as EndpointApiStyle[],
  };
}

/**
 * Provider types with a named-endpoint surface. Derived from the descriptors
 * that declare paths to compose against, which is sound by construction: a type
 * that composes one has to say where it posts it.
 */
export type EndpointProvider = {
  [Type in ProviderType]: (typeof PROVIDER_DESCRIPTORS)[Type] extends { endpointPaths: object }
    ? Type
    : never;
}[ProviderType];

export const ENDPOINT_PROVIDER_TYPES = PROVIDER_TYPES.filter(
  (type): type is EndpointProvider => providerCapability(type).endpointStyles.length > 0,
) as [EndpointProvider, ...EndpointProvider[]];

/** Provider types eligible for a named endpoint style on their own API. */
export function providersForEndpointStyle(style: EndpointApiStyle): EndpointProvider[] {
  return ENDPOINT_PROVIDER_TYPES.filter((type) =>
    providerCapability(type).endpointStyles.includes(style),
  );
}

/**
 * Whether this provider type's own responses carry a per-request cost, which is
 * exactly whether it declared how to read one. Billability derives from the
 * declaration rather than sitting beside it, so the two cannot disagree.
 *
 * Takes a plain string because a stored row's type reaches it from the console
 * as well as from the Worker.
 */
export function reportsCost(type: string): boolean {
  return isProviderType(type) && providerDescriptor(type).costReport !== undefined;
}

/**
 * Provider types whose own responses carry a per-request cost, so their models
 * proxy with no local price at all and the recorded cost is the upstream's own
 * figure.
 */
export const COST_REPORTING_PROVIDER_TYPES: readonly ProviderType[] =
  PROVIDER_TYPES.filter(reportsCost);
