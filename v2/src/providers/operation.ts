/**
 * The format of a provider description (plan section 4.1, D2).
 *
 * A provider is a list of operations. Each operation is a typed constant that
 * says how to recognise a request, where its model is, how it runs and how it
 * is measured. Routing and simple extraction are data. Measuring uses a short
 * list of meter kinds, each implemented once in ordinary code. There is no
 * rule or formula language.
 *
 * Paths are templates, relative to the provider's gateway path
 * (`/v2/apps/{app}/proxy/{provider}/`):
 *
 * - A literal segment matches itself exactly.
 * - `{name}` matches one segment, never a `/`. A segment can also have a
 *   literal prefix or suffix, as in `{model}:generateContent`.
 * - `{name...}` matches one or more whole segments, but only a value from a
 *   closed list, such as the models priced for the operation. It exists for
 *   model ids with slashes (fal's `fal-ai/flux/dev`). A template has at most
 *   one.
 *
 * `defineOperation` checks some of these rules at compile time: a model in
 * the path must name a part of the template, every `{name...}` part needs its
 * closed list, a template has at most one, and an upstream template may use
 * only the parts the match template has. The rest (empty segments, two parts
 * in one segment, a name used twice) are checked when the provider's matcher
 * is built, which a test does for every provider.
 */

import type { ServiceModeField, ServiceRegion } from "../usage/service-modes.ts";
import type { Modality } from "../usage/observation.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** How a request runs, with its own way of charging (plan section 4.3). */
export type Lifecycle = "call" | "job" | "session";

export type Transport =
  /** JSON in, JSON out. */
  | "http"
  /** A streamed response, such as server-sent events. */
  | "stream"
  /** A binary response body, such as audio. */
  | "binary"
  /** A multipart form request. */
  | "upload"
  | "websocket"
  | "webrtc";

/**
 * The API styles that have a usage reader. Fallback chains link only
 * operations of the same style.
 *
 * - `openai-chat`: Chat Completions, on OpenAI and every service that speaks it.
 * - `openai-completions`: legacy and fill-in-the-middle completions. Their
 *   usage has the Chat Completions shape.
 * - `openai-responses`: the Responses API, and the APIs shaped like it.
 * - `anthropic-messages`: the Messages API, on Anthropic and the services
 *   that offer it.
 * - `gemini-generate`: Gemini's own `generateContent`.
 * - `openai-transcription`: speech to text, an upload whose answer reports
 *   tokens, a duration, or both (`usage.seconds`, `duration`). The model's
 *   price decides which one bills.
 * - `openai-images`: image generation and edits. Usage in the OpenAI shape,
 *   with image tokens apart, or the number of images made
 *   (`generated_images`) for a model priced per image.
 * - `openai-embeddings`: embeddings, billed on their input tokens.
 * - `gemini-embed`: Gemini's own `embedContent`, usage in `usageMetadata`.
 * - `elevenlabs-transcription`: ElevenLabs' speech to text, whose answer
 *   names the audio's length in `audio_duration_secs`.
 * - `deepgram-listen`: Deepgram's prerecorded speech to text, whose answer
 *   names the audio's length (`metadata.duration`) and its channels
 *   (`metadata.channels`). Deepgram bills the total across channels.
 * - `openai-speech`: text to speech. Usage in the OpenAI shape when the answer
 *   is a stream of events. A plain audio answer reports none, so its cost is
 *   unknown, as in v1, until step 4 measures the request.
 */
export const API_STYLES = [
  "openai-chat",
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "gemini-generate",
  "openai-transcription",
  "openai-images",
  "openai-embeddings",
  "gemini-embed",
  "openai-speech",
  "elevenlabs-transcription",
  "deepgram-listen",
] as const;
export type ApiStyle = (typeof API_STYLES)[number];

/**
 * A provider's own report of what a request cost, read from its response
 * (plan section 4.2, `price_source: provider_usd`). The readers are in
 * `../usage/cost-reports.ts`. An operation that has one can be served without
 * a price of ours.
 */
export const PROVIDER_COST_REPORTS = ["openrouter", "xai"] as const;
export type ProviderCostReport = (typeof PROVIDER_COST_REPORTS)[number];

/**
 * A provider's own cost in dollars, sent as a response header (read in
 * `src/proxy/meter.ts`). `currency`, when given, is a header that must name
 * US dollars: a figure in another currency is no report.
 */
export interface HeaderCostReport {
  readonly header: string;
  readonly currency?: { readonly header: string; readonly value: string };
}

/** Billed units. Fractional units are stored at a fixed scale (plan section 4.2, Money). */
export const UNITS = [
  "tokens",
  "characters",
  "credits",
  /** Stored in milliseconds (`MILLI_SCALE`), so a fractional second stays a whole number. */
  "audio_seconds",
  "session_seconds",
  "text_messages",
  "images",
  "megapixels",
  "video_seconds",
  "requests",
  /** A model's own billed unit, such as fal's `x-fal-billable-units`. Named per model in the price file. */
  "model_units",
] as const;
export type Unit = (typeof UNITS)[number];

/** Measures the gateway can take from the request itself. */
export type RequestMeasure =
  /** The characters of a text field, such as text-to-speech input. */
  | { readonly measure: "characters"; readonly field: string }
  /** A length the request asks for, in seconds. */
  | { readonly measure: "requested_seconds"; readonly field: string; readonly default?: number }
  /** How many images the request asks for. */
  | { readonly measure: "image_count"; readonly field: string; readonly default?: number }
  /**
   * The megapixels of the images the request asks for, as fal bills them:
   * per image, width × height in units of 1024 × 1024 pixels, rounded up,
   * times the count in `field`. `size` names the size field, either
   * `{ width, height }` or a name listed in `sizes`. With no size, or a name
   * not listed, each image counts as one.
   */
  | {
      readonly measure: "image_megapixels";
      readonly field: string;
      readonly default?: number;
      readonly size: string;
      readonly sizes?: Readonly<Record<string, readonly [width: number, height: number]>>;
    };

/**
 * How an operation is measured. One of a short list of kinds, each
 * implemented once in ordinary code.
 */
export type Meter =
  /**
   * Usage in the response body or stream, read by the API style's usage
   * reader. `providerCost` names the provider's own cost report, read from the
   * same response, which wins over our price. `requestMeasure` bills an answer
   * that reports no usage at all from the request instead (OpenAI's speech
   * answered as plain audio: the characters of its input), for a model priced
   * in that unit.
   */
  | {
      readonly kind: "response_json";
      readonly style: ApiStyle;
      readonly providerCost?: ProviderCostReport;
      readonly requestMeasure?: RequestMeasure & { readonly unit: Unit };
      /**
       * The units other than tokens its reader reports, which a price may bill
       * instead: a transcription's `audio_seconds`, an image API's `images`.
       */
      readonly units?: readonly Unit[];
      /**
       * Token counts the provider reports in a response header rather than its
       * body, each a share of a bucket (`../usage/token-rates.ts`): Kimi's Chat
       * Completions sends its one-hour cache writes this way. Read only from an
       * answer that does not stream.
       */
      readonly usageHeaders?: readonly UsageHeader[];
      /**
       * Its answers may report only the provider's own cost (`providerCost`),
       * with no usage at all: xAI's images. A path that bills at the customer's
       * rates cannot meter it (`../providers/custom.ts`).
       */
      readonly costOnly?: true;
      /**
       * A flag that has the provider bill the audio once per channel
       * (Deepgram's `multichannel`): then the reported length is multiplied
       * by the channels the answer names (`audioChannels`). Otherwise it is
       * billed once.
       */
      readonly perChannelWhen?: FieldRef;
    }
  /**
   * A response header with the billed amount, such as ElevenLabs'
   * `character-cost`. `estimate` measures the request first, for budgets
   * before the answer and when the header is missing: one measure, or
   * several in different units (fal's megapixels beside its image count), so
   * a price in any of them can bill. `providerCost` names a
   * header with the provider's own cost in dollars (ElevenLabs' speech to text
   * sends `fiat-cost-before-overages`), which wins over our price as a JSON
   * report does.
   */
  | ({
      readonly kind: "response_header";
      readonly header: string;
      readonly unit: Unit;
      readonly providerCost?: HeaderCostReport;
    } & (
      | {
          readonly estimate?: HeaderEstimate;
          /**
           * A reader of the answer's body, whose measures are kept beside the
           * header's: ElevenLabs' speech to text reports its audio's length. `units`
           * are the units the reader reports.
           */
          readonly body?: { readonly style: ApiStyle; readonly units: readonly Unit[] };
          readonly headerRole?: undefined;
          readonly inDoubtWhen?: undefined;
        }
      | {
          readonly estimate: HeaderEstimate;
          readonly body?: undefined;
          /**
           * `cross_check`: the request's measure (`estimate`) is what the provider
           * bills, exactly, and the header is only recorded beside it, as a
           * secondary measure. ElevenLabs bills text to speech per character of
           * the request in dollars; its `character-cost` header counts credits,
           * which are not the billed amount (T27). A price in the header's unit
           * still bills it, when that is the only rate a price has. It needs an
           * `estimate`, and does not take `body`.
           */
          readonly headerRole: "cross_check";
          /**
           * A request field that may make the provider bill more than the
           * request's measure: ElevenLabs' pronunciation dictionaries can
           * change the billed characters. When it is on, the measure and the
           * header's amount are both estimates, and the dearer at the price
           * bills, so an alias that expands the text is not underbilled.
           */
          readonly inDoubtWhen?: SwitchRef;
        }
    ))
  /** For providers that report no usage: measured from the request. */
  | ({ readonly kind: "request_measure"; readonly unit: Unit } & RequestMeasure)
  /** One unit per request, at a flat price. */
  | { readonly kind: "request_count" }
  /** Connection time, for a provider we do not know (the generic WebSocket adapter, D4). */
  | { readonly kind: "wall_clock" }
  /** Usage events the provider sends during a session, read by a protocol adapter. */
  | { readonly kind: "provider_event"; readonly adapter: string };

/** A token count a response header carries: the header (lowercase), and the bucket share it is. */
export interface UsageHeader {
  readonly header: string;
  readonly bucket: "cached_input" | "cache_write";
  readonly name: "audio" | "1h" | "12h";
}

/**
 * Where an app's output cap (`max_output_tokens`) is enforced, by the field
 * each API reads it from. A request asking for more is refused; one asking for
 * nothing gets the cap written in (v1's clamp styles).
 *
 * - `chat`: `max_tokens` and `max_completion_tokens` are both judged, and the
 *   cap is written to `max_tokens`.
 * - `chat-completion-tokens`: the same, but the cap is written to
 *   `max_completion_tokens`, which OpenAI's own Chat Completions reads.
 * - `responses`: `max_output_tokens`.
 * - `anthropic`: `max_tokens`.
 * - `gemini`: `generationConfig.maxOutputTokens`.
 */
export const OUTPUT_CAPS = ["chat", "chat-completion-tokens", "responses", "anthropic", "gemini"] as const;
export type OutputCap = (typeof OUTPUT_CAPS)[number];

/**
 * Changes the gateway makes to a request body. It can only remove, add or
 * lock fields. There is no list of allowed fields, so a new provider
 * parameter works without a gateway release. Field names are dot paths.
 */
export interface RequestPolicy {
  /** Removed if present. */
  readonly remove?: readonly string[];
  /** Set if absent. */
  readonly add?: Readonly<Record<string, unknown>>;
  /** Fields the app's settings can lock to a value, such as `model`. */
  readonly lockable?: readonly string[];
  /** Where the app's output cap goes. Without it, the operation has no output to cap. */
  readonly outputCap?: OutputCap;
  /**
   * Adds `stream_options.include_usage` to a request that streams, so a Chat
   * Completions stream ends with its usage. Only when the request streams:
   * OpenAI refuses `stream_options` on a request that does not.
   */
  readonly streamUsage?: boolean;
}

/** A field of the request: a body field (a dot path), a form field or a query parameter. */
export interface FieldRef {
  readonly in: "body" | "form" | "query";
  readonly field: string;
}

/**
 * Fields that make the provider call or fetch a URL (plan section 4.1).
 * Webhook fields are always removed: a webhook could grow a bill the budget
 * never sees. A fetch field is removed too, unless the operation needs it,
 * such as `audio_url` for speech-to-text, which is then listed in
 * `fetchKept` instead. The gateway removes them before the request is sent
 * (`src/proxy/request-fields.ts`).
 */
export interface OutboundFields {
  readonly webhooks?: readonly FieldRef[];
  /** Fetch fields the operation does not need: removed. */
  readonly fetches?: readonly FieldRef[];
  /** Fetch fields the operation needs: kept. Listed so a reader sees they were judged. */
  readonly fetchKept?: readonly FieldRef[];
  /**
   * Fields a provider would take as a credential instead of the key, such as
   * ElevenLabs' single-use `token`: removed, so a request reaches the
   * provider with the gateway's key alone.
   */
  readonly credentials?: readonly FieldRef[];
}

/** A request option that turns a call into background work. */
export interface BackgroundOption {
  readonly field: FieldRef;
  /** Refused, or handled as a job. */
  readonly action: "refuse" | "job";
}

/**
 * How a request field that turns on a charge is read. Each is reduced to one
 * decision, on or off, before it is priced or stored:
 *
 * - `flag`: a switch. On when present, unless its value is false (`false`,
 *   `"false"`, null or empty). `redact=pii` is on; `redact=false` is off.
 * - `text`: free text that may repeat, such as Deepgram's `keyterm`. On when
 *   present with any value, even the text `false`. Its text is never stored.
 * - `list`: a list, such as ElevenLabs' `pronunciation_dictionary_locators`.
 *   On when it has at least one item.
 */
export type SwitchKind = "flag" | "text" | "list";

/** A request field that turns on a charge, and how it is read. */
export type SwitchRef = FieldRef & { readonly kind: SwitchKind };

/**
 * A rate that depends on a request field, such as image size or video
 * resolution. The price names its rates per value under `by.<name>`
 * (`src/pricing/prices.ts`). `default` is the value the provider uses when
 * the request names none.
 *
 * With `kind`, the field is a switch (`SwitchKind`), and its value is `true`
 * or `false`, never the request's own text: an add-on the price adds on top
 * (`by.redact.true.add`).
 *
 * `answeredWhen` names a flag that lets the provider choose the value itself
 * (Deepgram's `detect_language`). Then the value the answer reports is billed
 * (the reader's `reportedPriceKeys`), or, when it reports none, the dearest
 * value as an estimate, logged.
 */
export interface PriceKey {
  readonly name: string;
  readonly from: FieldRef;
  readonly default?: string;
  readonly kind?: SwitchKind;
  readonly answeredWhen?: FieldRef;
}

/** Where the model is in the request. `Part` is a part name of the match template. */
export type ModelLocation<Part extends string = string> =
  | { readonly in: "body"; readonly field: string; readonly default?: string }
  | { readonly in: "form"; readonly field: string; readonly default?: string }
  /**
   * In the query. `answeredWhen` names a flag that lets the provider serve
   * another model than the one asked for (Deepgram's `detect_language` falls
   * back to an older model for a language the asked one lacks). `servedAs`
   * then says which priced models each name the answer reports (the reader's
   * `reportedModels`) stands for. An answer that names none of the billed
   * model's, or a name `servedAs` does not list, is a fallback: the charge is
   * an estimate, logged.
   */
  | {
      readonly in: "query";
      readonly name: string;
      readonly default?: string;
      readonly answeredWhen?: FieldRef;
      readonly servedAs?: Readonly<Record<string, readonly string[]>>;
    }
  | { readonly in: "path"; readonly part: Part }
  /** The operation has one model, or none the request names. */
  | { readonly in: "fixed"; readonly model: string };

/** The upstream request, when it differs from the gateway path or the provider's main host. */
export interface Upstream<Path extends string = string> {
  /** A key of the provider's `hosts`. */
  readonly host?: string;
  /** A template using only the match template's parts. The gateway path is used when absent. */
  readonly path?: Path;
}

/**
 * A job's follow-up requests (plan D9). The client polls the gateway, never
 * the provider. Upstream URLs are built from the signed job id, never from the
 * client's path. Templates can use `{request_id}`, `{model}` and
 * `{model_base}` (the first two segments of the model id).
 */
export interface JobSpec {
  /** Where the provider's request id is in the submit response. */
  readonly requestIdField: string;
  readonly status: JobRequest;
  readonly result: JobRequest;
  readonly cancel?: JobRequest;
  /** Response fields with provider links. The gateway rewrites them to point at itself. */
  readonly linkFields?: readonly string[];
  /** Response header with the final billed units, read on the result call. */
  readonly unitsHeader?: string;
}

export interface JobRequest {
  readonly method: HttpMethod;
  readonly host?: string;
  readonly path: string;
}

/** A live session (plan section 5). */
export interface SessionSpec {
  /** Conversational sessions and streams have separate slots (D15). */
  readonly slot: "conversational" | "streaming";
  /** What the gateway does with the connection (D4). */
  readonly mode: "relayed" | "observed";
}

/** A closed list of values: the models priced for the operation, or a fixed list. */
export type ClosedList = "priced_models" | readonly string[];

/** One operation, as the gateway reads it at run time. Declare it with `defineOperation`. */
export interface OperationDescription {
  /** Unique across all providers, such as `elevenlabs.tts`. Stored on every charge. */
  readonly name: string;
  readonly match: { readonly method: HttpMethod; readonly path: string };
  /** The closed list for each `{name...}` part. */
  readonly multiSegment?: Readonly<Record<string, ClosedList>>;
  readonly upstream?: Upstream;
  readonly lifecycle: Lifecycle;
  readonly transport: Transport;
  readonly model: ModelLocation;
  readonly style?: ApiStyle;
  readonly policy?: RequestPolicy;
  readonly outbound?: OutboundFields;
  readonly background?: readonly BackgroundOption[];
  readonly meter: Meter;
  readonly priceKeys?: readonly PriceKey[];
  /**
   * The price list's kinds of model it serves, such as `speech`. A model the
   * list names with another kind (a transcription model beside it on the same
   * connection) is not one it is saved against. A model with no kind is judged
   * by its price alone.
   */
  readonly modelKinds?: readonly string[];
  /**
   * The request body may be raw bytes, such as audio, sent as they are with
   * their own content type, never read or copied. A JSON body is still read
   * (Deepgram takes either audio or `{ "url": ... }`). Without it, a body
   * is JSON or a multipart form.
   */
  readonly rawBody?: true;
  /**
   * Request options the provider bills on top, at a price of their own that
   * the gateway does not have yet, such as Deepgram's redaction. A request
   * naming one is served, billed at the model's price as an estimate and
   * logged (AGENTS.md: estimate, never bill as free).
   */
  readonly unpricedOptions?: readonly SwitchRef[];
  /**
   * How long the provider may take to send its response headers, in
   * milliseconds, for an operation whose provider works longer before it
   * answers (Deepgram's prerecorded transcription). The proxy's 120 s when
   * left out. A fallback chain shares its first target's.
   */
  readonly responseDeadlineMs?: number;
  readonly job?: JobSpec;
  readonly session?: SessionSpec;
  /**
   * How this operation's requests and answers are read, over its provider's
   * (`readingRules`): a custom provider's path of an API style carries the
   * rules of the built-in provider its definition comes from (`./custom.ts`),
   * so one connection may list styles of different providers.
   */
  readonly rules?: ReadingRules;
  /**
   * Its request may also be a multipart upload, as an image edit is; it is
   * JSON otherwise. A preset reads an upload only for such an operation.
   */
  readonly uploads?: true;
  /**
   * Any model's answer may come with no usage (a plain audio answer, an
   * answer that reports only a cost), beside the way it reports: each of its
   * ways holds that answer too (`meterCases`), so a price must bill it as
   * well, at save and at serve. A custom provider's path, which has no list
   * price or provider report to fall back on (`../providers/custom.ts`).
   */
  readonly pricedEveryWay?: true;
}

/**
 * The rules a provider states once for reading its operations' requests and
 * answers: its service modes, the modes its answers name, the transcription
 * formats that carry a measure, the input modalities its usage counts, the
 * other models a request may name and which provider each model's tables
 * are read with.
 */
export type ReadingRules = Pick<
  ProviderDescription,
  "serviceModes" | "servedModes" | "transcriptionFormats" | "countedInputModalities" | "alternativeModels" | "modelNamespaces"
>;

/**
 * The reading rules for `operation` of `description`: its own when it carries
 * them, else its provider's. The one place they are chosen, so every reader
 * of modes, formats and counted modalities agrees.
 */
export function readingRules(description: ProviderDescription, operation: OperationDescription | undefined): ReadingRules {
  return operation?.rules ?? description;
}

/** A refused path for some methods only. */
export interface RefusedPath {
  readonly path: string;
  readonly methods: readonly HttpMethod[];
}

/**
 * How long a minted live-session secret may start a call, in seconds (plan
 * D4): the shortest window for starting one, not the session's length.
 */
export const LIVE_TOKEN_WINDOW_SECONDS = 60;

/**
 * The value the gateway writes into one forced field of a mint's body.
 * - `{ window: "seconds" }`: the window, as a number of seconds.
 * - `{ window: "expires_after" }`: `{ seconds }` holding the window, with
 *   `anchor: "created_at"` when `anchor` is set.
 * - `{ window: "time" }`: an RFC 3339 time, the window from now.
 * - `{ fixed }`: that value as it is, such as `uses: 1`.
 */
export type LiveTokenValue =
  | { readonly window: "seconds" }
  | { readonly window: "expires_after"; readonly anchor?: true }
  | { readonly window: "time" }
  | { readonly fixed: number | string | boolean };

/**
 * One field of a mint's JSON body that the gateway sets, whatever the client
 * sent. `names` holds every spelling the provider reads, the one the gateway
 * writes first: each is removed, and only the first is written. A name with
 * dots is a nested field, such as `client_secret.expires_after`; its parent
 * objects are created when the body has none.
 */
export interface LiveTokenField {
  readonly names: readonly [string, ...string[]];
  readonly value: LiveTokenValue;
}

/** One query parameter of a mint that the gateway sets: every value the client sent is replaced by this one. */
export interface LiveTokenQueryParam {
  readonly name: string;
  readonly value: string;
}

/**
 * What the gateway forces in a mint request so its secret can start a call
 * only within `LIVE_TOKEN_WINDOW_SECONDS`, or only once (plan D4): the
 * window, and any field that would let one secret start more calls, where
 * the provider lets the request set them.
 */
export interface LiveTokenForced {
  /** Body fields; a mint that forces any needs a JSON object body. */
  readonly fields?: readonly [LiveTokenField, ...LiveTokenField[]];
  readonly query?: readonly [LiveTokenQueryParam, ...LiveTokenQueryParam[]];
}

/**
 * A path that mints a short-lived secret for one live session (plan D4).
 * Every request under `path` is refused like a refused path. A listed path
 * that opts in (`liveToken` on the listing) reaches only the mint itself:
 * `method` on exactly `path`, without its trailing `*`. Anything else under
 * it, such as cancelling a session, stays refused even with the opt-in.
 */
export interface LiveTokenPath {
  /** A template, read as refused paths are: a trailing `*` refuses the rest too. */
  readonly path: string;
  /** The one method that mints. */
  readonly method: HttpMethod;
  /** What the gateway sets in the mint, where the provider lets the request set it. */
  readonly forced?: LiveTokenForced;
}

/** How the provider's key is sent. */

export interface ProviderAuth {
  readonly header: string;
  /** `{key}` is replaced with the key, such as `Bearer {key}`. */
  readonly format: string;
}

export interface ProviderDescription {
  /** Stored as the provider type on connections and charges. */
  readonly type: string;
  /** What the console and the CLI call it. */
  readonly label: string;
  /**
   * Upstream hosts by key. `main` is used when an operation names none. A
   * host may end with a path prefix, such as `openrouter.ai/api`, which every
   * upstream path is sent under.
   */
  readonly hosts: { readonly main: string } & Readonly<Record<string, string>>;
  /**
   * Every other host name the provider serves the same API on: regional,
   * data-residency or older names. With `hosts`, the one declared list of
   * the provider's hosts, apart from what any of them costs
   * (`regionalOrigins`). A base URL on any of them is this provider's, and
   * gets its refused paths (`./custom.ts`). `*.` names every host under
   * one, as `*.api.openai.com` does OpenAI's data residency hosts.
   */
  readonly otherHosts?: readonly string[];
  readonly auth: ProviderAuth;
  /**
   * The request fields this provider reads a service mode from, such as a
   * tier (`service_tier`) or a region, and what each value means (plan
   * section 9, "Service modes, as today"). Values are forwarded unchanged;
   * this only tells the gateway what to price. Required, so a new provider
   * has to say: one with no tiers uses `NO_SERVICE_TIERS`.
   */
  readonly serviceModes: readonly ServiceModeField[];
  /**
   * What the provider's responses say about the mode that served a request,
   * where that differs from `serviceModes`. `header:<name>` reads a response
   * header. Without it, `serviceModes` is read against the response too.
   */
  readonly servedModes?: readonly ServiceModeField[];
  /**
   * Hosts that serve one region at a price of their own, for a connection
   * whose base URL points at one. Keyed by origin with a trailing `/`.
   */
  readonly regionalOrigins?: Readonly<Record<string, ServiceRegion>>;
  /**
   * The `response_format` values of a transcription whose answer carries what
   * it is billed by, usage or a duration (v1's `transcriptionFormats`). A
   * request in a format without one is sent in the format that extends it
   * (`upgrades`), or refused: its answer could not be priced. Without this,
   * any format is sent as asked.
   */
  readonly transcriptionFormats?: {
    readonly metered: readonly string[];
    /** What the provider answers in when the request names no format. */
    readonly default: string;
    /** A format with no measure, and the metered format that extends it. */
    readonly upgrades?: Readonly<Record<string, string>>;
  };
  /**
   * Input modalities this provider always counts in its usage details, as
   * `<modality>_tokens`. A prompt with no count for one has none of it, and
   * the rest is text. Only the OpenAI usage shape reads it.
   */
  readonly countedInputModalities?: readonly Modality[];
  /**
   * Client headers a listed passthrough path forwards besides the usual
   * allowlist (`../proxy/headers.ts`), by exact lowercase name or by a prefix
   * ending in `-`, such as Gemini's resumable upload headers. A name that
   * could carry a credential is never forwarded this way.
   */
  readonly passthroughHeaders?: readonly string[];
  /**
   * Paths that are always refused, even if a customer lists them: key
   * creation, admin, account and billing paths. Checked before anything else,
   * ignoring case. A trailing `*` segment matches the rest of the path,
   * including nothing, so `v1/organization/*` also refuses `v1/organization`.
   * An entry may name methods (`RefusedPath`): only those are refused there,
   * such as deleting a voice while reading one stays allowed.
   */
  readonly refused: readonly (string | RefusedPath)[];
  /**
   * Paths that mint a short-lived secret for one live session (plan D4).
   * Refused as refused paths are, unless the customer lists the path and
   * opts in to it. Key creation, admin and account paths belong in
   * `refused`, never here: those stay refused whatever is listed.
   */
  readonly liveTokens?: readonly LiveTokenPath[];
  /**
   * This provider can be reached through Cloudflare AI Gateway (D13): the
   * provider's name in Cloudflare's URL space, and a path prefix Cloudflare's
   * name already implies, which is taken off the request's path. Cloudflare
   * returns the provider's own response, so metering and prices are the
   * provider's. Without this, a connection of this type cannot use it.
   */
  readonly cloudflareGateway?: {
    readonly slug: string;
    readonly stripPathPrefix?: string;
    /**
     * How the provider's key is sent through Cloudflare for an API style whose
     * endpoint takes it differently from `auth`, as Cloudflare documents it:
     * Anthropic's Messages takes `x-api-key`, its Chat Completions a bearer token.
     */
    readonly authByStyle?: Partial<Readonly<Record<ApiStyle, ProviderAuth>>>;
  };
  /**
   * For a gateway that serves other providers' models (Vercel AI Gateway):
   * its model ids are `<namespace>/<model>`, and each namespace names the
   * provider type whose entries in our price list, and whose service-mode
   * tables, the model is read with. `openai/gpt-4o` is priced as OpenAI's
   * `gpt-4o`. A namespace not listed has no price of ours.
   */
  readonly modelNamespaces?: Readonly<Record<string, string>>;
  /**
   * A request field listing more models the provider may serve the request
   * with when the first cannot (Vercel's `providerOptions.gateway.models`).
   * Each one is judged as the request's own model is: the app's model list,
   * and a price (`src/proxy/alternatives.ts`). The charge is priced at the
   * model the answer says served it.
   */
  readonly alternativeModels?: { readonly field: string };
  /**
   * A request field that limits which providers serve the request (Vercel's
   * `providerOptions.gateway.only`). A connection may pin it
   * (`servingProviders`): the gateway then sets it on every request, over the
   * app's own value (v1's `providerOnly`).
   */
  readonly servingProvidersField?: string;
  /**
   * Headers the gateway sets on every request to this provider for its own
   * reporting, such as Vercel's spend attribution. A client can never send
   * them: client headers are an allowlist (`src/proxy/headers.ts`).
   */
  readonly attributionHeaders?: (context: { readonly appId: string; readonly userId: string | null }) => Readonly<Record<string, string>>;
  /**
   * Its operations are paths a customer listed (a custom provider,
   * `./custom.ts`), not paths the gateway declares: refused paths are judged
   * on every way the connection's base URL may be read, as they are for a
   * listed passthrough path.
   */
  readonly customerPaths?: true;
  /** Checked in this order. The first match wins, so declare the more specific first. */
  readonly operations: readonly OperationDescription[];
  /**
   * A cheap, free `GET` on the main host that needs a valid key, used to test
   * a key before it is saved. Without one, a test answers `no_probe`.
   */
  readonly probe?: {
    readonly path: string;
    /** Headers the provider refuses the probe without, such as Anthropic's API version. */
    readonly headers?: Readonly<Record<string, string>>;
  };
}

// ---------------------------------------------------------------------------
// Compile-time checks on templates

/** Every `{...}` part of a template, with `...` kept on multi-segment ones. */
type RawParts<T extends string> = T extends `${string}{${infer Part}}${infer Rest}`
  ? Part | RawParts<Rest>
  : never;

/** The part names of a template. */
export type PartName<T extends string> =
  RawParts<T> extends infer Part extends string ? (Part extends `${infer Name}...` ? Name : Part) : never;

/** The names of a template's `{name...}` parts. */
export type MultiPartName<T extends string> =
  RawParts<T> extends infer Part extends string ? (Part extends `${infer Name}...` ? Name : never) : never;

type IsUnion<T, All = T> = T extends unknown ? ([All] extends [T] ? false : true) : never;

/** `{name...}` parts need their closed list, and a template has at most one. */
type MultiSegmentField<P extends string> = [MultiPartName<P>] extends [never]
  ? { readonly multiSegment?: never }
  : true extends IsUnion<MultiPartName<P>>
    ? { readonly multiSegment: "a template can have only one {name...} part" }
    : { readonly multiSegment: { readonly [Name in MultiPartName<P>]: ClosedList } };

/** An upstream template may use only the match template's parts. */
type UpstreamField<P extends string, U extends string> = [Exclude<PartName<U>, PartName<P>>] extends [never]
  ? { readonly upstream?: Upstream<U> }
  : { readonly upstream: { readonly path: `unknown part: ${Exclude<PartName<U>, PartName<P>> & string}` } };

/** What `defineOperation` accepts: the run-time shape, with the template checks. */
export type OperationInput<P extends string, U extends string> = Omit<
  OperationDescription,
  "match" | "model" | "multiSegment" | "upstream"
> & {
  readonly match: { readonly method: HttpMethod; readonly path: P };
  readonly model: ModelLocation<PartName<P>>;
} & MultiSegmentField<P> &
  UpstreamField<P, U>;

/**
 * Declares one operation, with the template checks applied. Use it for every
 * operation, so a mistake in a template is a compile error. The run-time
 * parser (`./path.ts`) checks the same rules again, for paths a customer lists.
 */
/**
 * The model a request is sent and billed as: the app's rewrite of the model
 * it named, if any (v1). A fixed model is never rewritten. The one rule, for
 * serving and for the app save's checks alike.
 */
export function rewrittenModel(
  operation: Pick<OperationDescription, "model">,
  model: string,
  rewrites: Readonly<Record<string, string>> | undefined,
): string {
  if (operation.model.in === "fixed" || rewrites === undefined) return model;
  return Object.hasOwn(rewrites, model) ? rewrites[model]! : model;
}

export function defineOperation<const P extends string, const U extends string = P>(
  operation: OperationInput<P, U>,
): OperationDescription {
  return operation as OperationDescription;
}

/** Declares a provider. */
export function defineProvider<const D extends ProviderDescription>(provider: D): D {
  return provider;
}

/** A header meter's request measure: one, or several in different units. */
type HeaderEstimate = (RequestMeasure & { readonly unit: Unit }) | readonly (RequestMeasure & { readonly unit: Unit })[];

/** The request measures a meter takes: none, one, or several in different units (a header meter's `estimate`). */
export function requestMeasuresOf(meter: Meter): readonly (RequestMeasure & { readonly unit: Unit })[] {
  if (meter.kind === "request_measure") return [meter];
  if (meter.kind === "response_header") {
    const { estimate } = meter;
    if (estimate === undefined) return [];
    return Array.isArray(estimate) ? (estimate as readonly (RequestMeasure & { readonly unit: Unit })[]) : [estimate as RequestMeasure & { readonly unit: Unit }];
  }
  if (meter.kind === "response_json") return meter.requestMeasure === undefined ? [] : [meter.requestMeasure];
  return [];
}
