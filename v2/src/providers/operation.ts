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

/** The API styles that have a usage reader. Fallback chains link only operations of the same style. */
export const API_STYLES = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "gemini-generate",
] as const;
export type ApiStyle = (typeof API_STYLES)[number];

/** Billed units. Fractional units are stored at a fixed scale (plan section 4.2, Money). */
export const UNITS = [
  "tokens",
  "characters",
  "credits",
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
  | { readonly measure: "image_count"; readonly field: string; readonly default?: number };

/**
 * How an operation is measured. One of a short list of kinds, each
 * implemented once in ordinary code.
 */
export type Meter =
  /** Usage in the response body or stream, read by the API style's usage reader. */
  | { readonly kind: "response_json"; readonly style: ApiStyle }
  /**
   * A response header with the billed amount, such as ElevenLabs'
   * `character-cost`. `estimate` measures the request first, for budgets
   * before the answer and when the header is missing.
   */
  | {
      readonly kind: "response_header";
      readonly header: string;
      readonly unit: Unit;
      readonly estimate?: RequestMeasure & { readonly unit: Unit };
    }
  /** For providers that report no usage: measured from the request. */
  | ({ readonly kind: "request_measure"; readonly unit: Unit } & RequestMeasure)
  /** One unit per request, at a flat price. */
  | { readonly kind: "request_count" }
  /** Connection time, for a provider we do not know (the generic WebSocket adapter, D4). */
  | { readonly kind: "wall_clock" }
  /** Usage events the provider sends during a session, read by a protocol adapter. */
  | { readonly kind: "provider_event"; readonly adapter: string };

/**
 * Changes the gateway makes to a request body. It can only remove, add or
 * lock fields. There is no list of allowed fields, so a new provider
 * parameter works without a gateway release. Field names are dot paths.
 */
export interface RequestPolicy {
  /** Removed if present. */
  readonly remove?: readonly string[];
  /** Set if absent, such as `stream_options.include_usage`. */
  readonly add?: Readonly<Record<string, unknown>>;
  /** Fields the app's settings can lock to a value, such as `model`. */
  readonly lockable?: readonly string[];
}

/** A field of the request: a body field (a dot path), a form field or a query parameter. */
export interface FieldRef {
  readonly in: "body" | "form" | "query";
  readonly field: string;
}

/**
 * Fields that make the provider call or fetch a URL. Webhook fields are always
 * removed: a webhook could grow a bill the budget never sees. Fetch fields
 * are kept only where the operation needs them, such as `audio_url` for
 * speech-to-text. Any other fetch field is removed.
 */
export interface OutboundFields {
  readonly webhooks?: readonly FieldRef[];
  readonly fetchKept?: readonly FieldRef[];
}

/** A request option that turns a call into background work. */
export interface BackgroundOption {
  readonly field: FieldRef;
  /** Refused, or handled as a job. */
  readonly action: "refuse" | "job";
}

/** A rate that depends on a request field, such as image size or video resolution. */
export interface PriceKey {
  readonly name: string;
  readonly from: FieldRef;
}

/** Where the model is in the request. `Part` is a part name of the match template. */
export type ModelLocation<Part extends string = string> =
  | { readonly in: "body"; readonly field: string; readonly default?: string }
  | { readonly in: "form"; readonly field: string; readonly default?: string }
  | { readonly in: "query"; readonly name: string; readonly default?: string }
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
  readonly job?: JobSpec;
  readonly session?: SessionSpec;
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
  /** Upstream hosts by key. `main` is used when an operation names none. */
  readonly hosts: { readonly main: string } & Readonly<Record<string, string>>;
  readonly auth: ProviderAuth;
  /**
   * Paths that are always refused, even if a customer lists them: key
   * creation, admin, account and billing paths. Checked before anything else,
   * ignoring case. A trailing `*` segment matches the rest of the path,
   * including nothing, so `v1/organization/*` also refuses `v1/organization`.
   */
  readonly refused: readonly string[];
  /** Checked in this order. The first match wins, so declare the more specific first. */
  readonly operations: readonly OperationDescription[];
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
export function defineOperation<const P extends string, const U extends string = P>(
  operation: OperationInput<P, U>,
): OperationDescription {
  return operation as OperationDescription;
}

/** Declares a provider. */
export function defineProvider<const D extends ProviderDescription>(provider: D): D {
  return provider;
}
