/**
 * One served request as one stored record: a single line of JSON, plus the
 * media it carried — images, recordings, other files — kept as objects of
 * their own, once each by content and day. A body names them by
 * `agw-media:<name>` where their data was.
 *
 * Which media is kept is the app's `conversations.keep`; a kind it leaves out
 * is recorded as `agw-omitted:<type>;<bytes>` instead. A streamed spoken reply
 * arrives as many small pieces of audio, which stay in the record as they came,
 * or are each recorded by their size where audio is not kept.
 *
 * Built inside `ConversationLog`, never on the request path: parsing a body,
 * decoding its media and hashing it is work the served request must not spend
 * its CPU on.
 */

import { mediaName, recordDay, typeForExtension } from "./storage";

/** Which kinds of media a record keeps; see `conversations.keep`. */
export interface KeptMedia {
  images: boolean;
  audio: boolean;
  files: boolean;
}

/** What the gateway hands the log about one served request. */
export interface ConversationCapture {
  /** The usage event's own id, so the two always name the same request. */
  eventId: string;
  createdAt: string;
  appId: string;
  userId: string | null;
  installId: string | null;
  appVersion: string | null;
  clientTraceId: string | null;
  endpointSlug: string | null;
  route: string;
  provider: string;
  model: string;
  status: "ok" | "provider_error";
  httpStatus: number;
  latencyMs: number;
  keep: KeptMedia;
  request: CapturedBytes;
  response: CapturedBytes & { aborted: boolean };
}

export interface CapturedBytes {
  contentType: string;
  /** Null where the body was larger than what is captured, or absent. */
  bytes: Uint8Array<ArrayBuffer> | null;
  totalBytes: number;
}

export interface StoredMedia {
  /** Relative to the app's folder: `<YYYY-MM-DD>/media/<sha256>.<ext>`. */
  name: string;
  mime: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * A record line past this many UTF-8 bytes gives up its bodies, largest first:
 * the log keeps a line as one SQLite value, which may not pass 2 MB.
 */
export const MAX_RECORD_BYTES = 1_500_000;
/** A single string past this many characters is not kept. */
const MAX_STRING_CHARS = 256 * 1024;
/** Prefix of a value that was not kept: `agw-omitted:<what>;<bytes>`. */
const OMITTED = "agw-omitted:";
/** Prefix of media kept beside the record: `agw-media:<name>`. */
const MEDIA = "agw-media:";

type StoredBody =
  | { kind: "json"; content_type: string; value: unknown }
  | { kind: "form"; content_type: string; fields: Record<string, unknown> }
  | { kind: "text"; content_type: string; text: string }
  | { kind: "media"; content_type: string; bytes: number; content: string }
  | { kind: "omitted"; content_type: string; reason: OmittedReason; bytes: number };

type OmittedReason = "empty" | "too_large" | "unreadable";

/** Objects holding a recording in bare base64 under `data`: OpenAI's `input_audio` and `audio`. */
const AUDIO_PARENTS = new Set(["input_audio", "audio"]);

function mediaType(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

function isJson(type: string): boolean {
  return type === "application/json" || type.endsWith("+json");
}

/** Audio whose format the body does not say, such as a chat reply's `audio.data`. */
const UNKNOWN_AUDIO = "audio";

function mediaKind(mime: string): keyof KeptMedia {
  if (mime.startsWith("image/")) return "images";
  if (mime === UNKNOWN_AUDIO || mime.startsWith("audio/")) return "audio";
  return "files";
}

/** The bytes base64 text stands for, without decoding it: padding and whitespace carry none. */
function base64Bytes(text: string): number {
  const digits = text.replace(/[\s=]/g, "").length;
  return Math.floor((digits * 3) / 4);
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Collects a record's media, each once, whatever number of places name it. */
class MediaShelf {
  readonly media: StoredMedia[] = [];
  private readonly names = new Set<string>();

  /** `day` is the record's UTC day, whose folder its media is kept in. */
  constructor(private readonly day: string, private readonly keep: KeptMedia) {}

  /** What replaces media in the record: its reference where it is kept, else its type and size. */
  async place(bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<string> {
    if (!this.keep[mediaKind(mime)]) return `${OMITTED}${mime};${bytes.byteLength}`;
    const name = mediaName(this.day, await sha256Hex(bytes), mime);
    if (!this.names.has(name)) {
      this.names.add(name);
      // Stored with a real media type: one the body did not say is just bytes.
      this.media.push({ name, mime: mime.includes("/") ? mime : "application/octet-stream", bytes });
    }
    return `${MEDIA}${name}`;
  }

  /** The same, for media in base64, which is decoded only where it is kept. */
  async placeBase64(text: string, mime: string): Promise<string> {
    const bytes = this.keep[mediaKind(mime)] ? decodeBase64(text) : null;
    return bytes === null ? `${OMITTED}${mime};${base64Bytes(text)}` : this.place(bytes, mime);
  }

  /** A piece of a streamed recording, in base64: left as it came where audio is kept. */
  piece(text: string, mime: string = UNKNOWN_AUDIO): string {
    return this.keep.audio && text.length <= MAX_STRING_CHARS ? text : `${OMITTED}${mime};${base64Bytes(text)}`;
  }
}

/** How a JSON body is walked: where its media goes, and whether it is one event of a stream. */
interface Walk {
  shelf: MediaShelf;
  streamed: boolean;
}

const DATA_URL = /^data:([^;,]+)(?:;[^,]*)?;base64,/i;

/** One string of a JSON body: media becomes a reference or a note, an oversized string a note. */
async function keptString(value: string, key: string | undefined, walk: Walk): Promise<string> {
  const dataUrl = DATA_URL.exec(value);
  if (dataUrl) return walk.shelf.placeBase64(value.slice(dataUrl[0].length), dataUrl[1]!.toLowerCase());
  // Generated images arrive as bare base64 under `b64_json`.
  if (key === "b64_json") return walk.shelf.placeBase64(value, "image/png");
  if (value.length > MAX_STRING_CHARS) return `${OMITTED}text;${value.length}`;
  return value;
}

/**
 * A streamed audio event, such as `response.output_audio.delta`, whose `delta`
 * is a piece of recording in bare base64. Its transcript events are text.
 */
function isAudioEvent(value: Record<string, unknown>): boolean {
  return typeof value.type === "string" && value.type.includes("audio") && !value.type.includes("transcript");
}

/** The bare base64 `data` of one object, and its media type, where the object says it is media. */
function bareMedia(value: Record<string, unknown>, key: string | undefined): { mime: string; audio: boolean } | null {
  if (typeof value.data !== "string") return null;
  // Gemini's `inlineData` / `inline_data`, and Anthropic's base64 `source`:
  // any media, typed. (An Anthropic `text` source holds plain text, not media.)
  const declared = typeof value.mimeType === "string" ? value.mimeType
    : typeof value.mime_type === "string" ? value.mime_type
    : value.type === "base64" ? value.media_type : undefined;
  if (typeof declared === "string") {
    const mime = declared.toLowerCase();
    return { mime, audio: mime.startsWith("audio/") };
  }
  // OpenAI's `input_audio` and `audio`: a recording, typed by `format` where
  // given. A reply's `audio` does not repeat the format its request chose.
  if (key !== undefined && AUDIO_PARENTS.has(key)) {
    const format = typeof value.format === "string" && /^[a-z0-9]+$/.test(value.format) ? value.format : null;
    return { mime: format === null ? UNKNOWN_AUDIO : `audio/${format === "mp3" ? "mpeg" : format}`, audio: true };
  }
  return null;
}

async function keptJson(value: unknown, walk: Walk, key?: string): Promise<unknown> {
  if (typeof value === "string") return keptString(value, key, walk);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await keptJson(item, walk, key));
    return out;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const media = bareMedia(object, key);
    const audioEvent = isAudioEvent(object);
    for (const [name, item] of Object.entries(object)) {
      if (media !== null && name === "data") {
        // In a stream, audio arrives a piece at a time; anything else whole.
        out[name] = walk.streamed && media.audio
          ? walk.shelf.piece(item as string, media.mime)
          : await walk.shelf.placeBase64(item as string, media.mime);
      } else if (audioEvent && name === "delta" && typeof item === "string") {
        out[name] = walk.shelf.piece(item);
      } else {
        out[name] = await keptJson(item, walk, name);
      }
    }
    return out;
  }
  return value;
}

/**
 * A streamed answer, each event's JSON kept the way a JSON body is, so media
 * in a stream is treated as it is in one whole response.
 */
async function keptEventStream(text: string, shelf: MediaShelf): Promise<string> {
  const walk: Walk = { shelf, streamed: true };
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const data = /^data: ?(.*)$/s.exec(line);
    let value: unknown;
    try {
      value = data === null ? undefined : JSON.parse(data[1]!);
    } catch {
      // `[DONE]` and other plain text.
    }
    lines.push(value === undefined ? line : `data: ${JSON.stringify(await keptJson(value, walk))}`);
  }
  return lines.join("\n");
}

/** An uploaded file's type, from its name where the upload did not say. */
function fileType(file: File): string {
  const declared = file.type.toLowerCase();
  if (declared !== "" && declared !== "application/octet-stream") return declared;
  return typeForExtension(file.name) ?? "application/octet-stream";
}

async function storedBody(body: CapturedBytes, shelf: MediaShelf): Promise<StoredBody> {
  const contentType = body.contentType;
  const type = mediaType(contentType);
  if (body.bytes === null) {
    return { kind: "omitted", content_type: contentType, reason: body.totalBytes === 0 ? "empty" : "too_large", bytes: body.totalBytes };
  }
  if (body.bytes.byteLength === 0) {
    return { kind: "omitted", content_type: contentType, reason: "empty", bytes: 0 };
  }
  if (type.startsWith("multipart/form-data")) {
    try {
      const form = await new Response(body.bytes, { headers: { "content-type": contentType } }).formData();
      const fields: Record<string, unknown> = {};
      for (const [name, entry] of form.entries()) {
        let kept: unknown;
        if (typeof entry === "string") {
          kept = entry.length > MAX_STRING_CHARS ? `${OMITTED}text;${entry.length}` : entry;
        } else {
          const file = entry as File;
          const mime = fileType(file);
          kept = {
            file: file.name,
            type: mime,
            bytes: file.size,
            content: await shelf.place(new Uint8Array(await file.arrayBuffer()), mime),
          };
        }
        // A repeated field keeps every value, in order.
        if (Object.hasOwn(fields, name)) {
          const previous = fields[name];
          fields[name] = Array.isArray(previous) ? [...previous, kept] : [previous, kept];
        } else {
          fields[name] = kept;
        }
      }
      return { kind: "form", content_type: contentType, fields };
    } catch {
      return { kind: "omitted", content_type: contentType, reason: "unreadable", bytes: body.totalBytes };
    }
  }
  if (type !== "" && !type.startsWith("text/") && !isJson(type)) {
    return { kind: "media", content_type: contentType, bytes: body.totalBytes, content: await shelf.place(body.bytes, type) };
  }
  let text = new TextDecoder().decode(body.bytes);
  if (type === "text/event-stream") text = await keptEventStream(text, shelf);
  if (isJson(type) || type === "") {
    try {
      return {
        kind: "json",
        content_type: contentType,
        value: await keptJson(JSON.parse(text), { shelf, streamed: false }),
      };
    } catch {
      if (type !== "") return { kind: "omitted", content_type: contentType, reason: "unreadable", bytes: body.totalBytes };
    }
  }
  return text.length > MAX_RECORD_BYTES
    ? { kind: "omitted", content_type: contentType, reason: "too_large", bytes: body.totalBytes }
    : { kind: "text", content_type: contentType, text };
}

function tooLarge(body: StoredBody, totalBytes: number): StoredBody {
  return { kind: "omitted", content_type: body.content_type, reason: "too_large", bytes: totalBytes };
}

/** Builds the record line for one capture, and the media it keeps beside it. */
export async function conversationRecord(
  capture: ConversationCapture,
): Promise<{ line: string; media: StoredMedia[] }> {
  const shelf = new MediaShelf(recordDay(capture.createdAt), capture.keep);
  let request = await storedBody(capture.request, shelf);
  let response = await storedBody(capture.response, shelf);
  const render = () => JSON.stringify({
    v: 1,
    event_id: capture.eventId,
    created_at: capture.createdAt,
    app_id: capture.appId,
    user_id: capture.userId,
    install_id: capture.installId,
    app_version: capture.appVersion,
    trace_id: capture.clientTraceId,
    endpoint: capture.endpointSlug,
    route: capture.route,
    provider: capture.provider,
    model: capture.model,
    status: capture.status,
    http_status: capture.httpStatus,
    latency_ms: capture.latencyMs,
    client_aborted: capture.response.aborted,
    request,
    response,
  });
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
  let line = render();
  // Give up the larger body first, then the other, until the line fits the
  // log's row: a record that says what was dropped beats no record at all.
  if (bytes(line) > MAX_RECORD_BYTES) {
    if (bytes(JSON.stringify(response)) >= bytes(JSON.stringify(request))) {
      response = tooLarge(response, capture.response.totalBytes);
    } else {
      request = tooLarge(request, capture.request.totalBytes);
    }
    line = render();
    if (bytes(line) > MAX_RECORD_BYTES) {
      request = tooLarge(request, capture.request.totalBytes);
      response = tooLarge(response, capture.response.totalBytes);
      line = render();
    }
  }
  return { line, media: shelf.media };
}
