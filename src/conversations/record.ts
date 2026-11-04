/**
 * One served request as one stored record: a single line of JSON, plus the
 * images it carried, which are kept as objects of their own.
 *
 * What is kept is what was said: text, JSON, form fields. What is not is any
 * recording — an audio upload, base64 audio in a JSON body, synthesized speech
 * — which leaves only its type and size behind. Images are kept, once each by
 * content and day, and a body names them by `agw-image:<name>` where the data was.
 *
 * Built inside `ConversationLog`, never on the request path: parsing a body,
 * decoding its images and hashing them is work the served request must not
 * spend its CPU on.
 */

import { imageName, IMAGE_EXTENSIONS, recordDay } from "./storage";

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
  request: CapturedBytes;
  response: CapturedBytes & { aborted: boolean };
}

export interface CapturedBytes {
  contentType: string;
  /** Null where the body was larger than what is captured, or absent. */
  bytes: Uint8Array<ArrayBuffer> | null;
  totalBytes: number;
}

export interface StoredImage {
  /** Relative to the app's folder: `<YYYY-MM-DD>/images/<sha256>.<ext>`. */
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
/** Prefix of an image kept beside the record: `agw-image:<name>`. */
const IMAGE = "agw-image:";

type StoredBody =
  | { kind: "json"; content_type: string; value: unknown }
  | { kind: "form"; content_type: string; fields: Record<string, unknown> }
  | { kind: "text"; content_type: string; text: string }
  | { kind: "omitted"; content_type: string; reason: OmittedReason; bytes: number };

type OmittedReason = "empty" | "binary" | "audio" | "too_large" | "unreadable";

/** Keys whose value is a recording, wherever they appear under these parents. */
const AUDIO_PARENTS = new Set(["input_audio", "audio"]);

function mediaType(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

function isJson(type: string): boolean {
  return type === "application/json" || type.endsWith("+json");
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

/** Collects a record's images, each once, whatever number of places name it. */
class ImageShelf {
  readonly images: StoredImage[] = [];
  private readonly names = new Set<string>();

  /** The UTC day of the record, whose folder the images are kept in. */
  constructor(private readonly day: string) {}

  /** Keeps an image and answers the reference that replaces it, or null if it is no image this keeps. */
  async keep(bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<string | null> {
    const type = mime.toLowerCase();
    if (IMAGE_EXTENSIONS[type] === undefined) return null;
    const name = imageName(this.day, await sha256Hex(bytes), type);
    if (name === null) return null;
    if (!this.names.has(name)) {
      this.names.add(name);
      this.images.push({ name, mime: type, bytes });
    }
    return `${IMAGE}${name}`;
  }
}

const DATA_URL = /^data:([^;,]+)(?:;[^,]*)?;base64,/i;

/** One string of a JSON body: an image becomes a reference, a recording or an oversized string a note. */
async function keptString(value: string, parent: string | undefined, key: string | undefined, shelf: ImageShelf): Promise<string> {
  const dataUrl = DATA_URL.exec(value);
  if (dataUrl) {
    const mime = dataUrl[1]!.toLowerCase();
    const payload = value.slice(dataUrl[0].length);
    if (mime.startsWith("image/")) {
      const bytes = decodeBase64(payload);
      const reference = bytes ? await shelf.keep(bytes, mime) : null;
      if (reference) return reference;
    }
    return `${OMITTED}${mime};${Math.floor((payload.length * 3) / 4)}`;
  }
  // Generated images arrive as bare base64 under `b64_json`.
  if (key === "b64_json") {
    const bytes = decodeBase64(value);
    const reference = bytes ? await shelf.keep(bytes, "image/png") : null;
    if (reference) return reference;
  }
  // `input_audio.data` and `audio.data` are recordings in bare base64.
  if (key === "data" && parent !== undefined && AUDIO_PARENTS.has(parent)) {
    return `${OMITTED}audio;${Math.floor((value.length * 3) / 4)}`;
  }
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

async function keptJson(value: unknown, shelf: ImageShelf, parent?: string, key?: string): Promise<unknown> {
  if (typeof value === "string") return keptString(value, parent, key, shelf);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await keptJson(item, shelf, parent, key));
    return out;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const audioEvent = isAudioEvent(value as Record<string, unknown>);
    for (const [name, item] of Object.entries(value)) {
      out[name] = audioEvent && name === "delta" && typeof item === "string"
        ? `${OMITTED}audio;${Math.floor((item.length * 3) / 4)}`
        : await keptJson(item, shelf, key, name);
    }
    return out;
  }
  return value;
}

/**
 * A streamed answer, each event's JSON kept the way a JSON body is, so streamed
 * audio and images are treated as they are in one whole response.
 */
async function keptEventStream(text: string, shelf: ImageShelf): Promise<string> {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const data = /^data: ?(.*)$/s.exec(line);
    let value: unknown;
    try {
      value = data === null ? undefined : JSON.parse(data[1]!);
    } catch {
      // `[DONE]` and other plain text.
    }
    lines.push(value === undefined ? line : `data: ${JSON.stringify(await keptJson(value, shelf))}`);
  }
  return lines.join("\n");
}

async function storedBody(body: CapturedBytes, shelf: ImageShelf): Promise<StoredBody> {
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
          const fileType = file.type.toLowerCase();
          const reference = fileType.startsWith("image/")
            ? await shelf.keep(new Uint8Array(await file.arrayBuffer()), fileType)
            : null;
          kept = reference ?? {
            file: file.name,
            type: file.type,
            bytes: file.size,
            omitted: fileType.startsWith("audio/") || fileType === "" ? "audio" : "binary",
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
  if (type.startsWith("audio/")) {
    return { kind: "omitted", content_type: contentType, reason: "audio", bytes: body.totalBytes };
  }
  if (type.startsWith("image/")) {
    const reference = await shelf.keep(body.bytes, type);
    return reference
      ? { kind: "text", content_type: contentType, text: reference }
      : { kind: "omitted", content_type: contentType, reason: "binary", bytes: body.totalBytes };
  }
  let text = new TextDecoder().decode(body.bytes);
  if (type === "text/event-stream") text = await keptEventStream(text, shelf);
  if (isJson(type) || type === "") {
    try {
      return { kind: "json", content_type: contentType, value: await keptJson(JSON.parse(text), shelf) };
    } catch {
      if (type !== "") return { kind: "omitted", content_type: contentType, reason: "unreadable", bytes: body.totalBytes };
    }
  }
  if (type === "" || type.startsWith("text/")) {
    return text.length > MAX_RECORD_BYTES
      ? { kind: "omitted", content_type: contentType, reason: "too_large", bytes: body.totalBytes }
      : { kind: "text", content_type: contentType, text };
  }
  return { kind: "omitted", content_type: contentType, reason: "binary", bytes: body.totalBytes };
}

function tooLarge(body: StoredBody, totalBytes: number): StoredBody {
  return { kind: "omitted", content_type: body.content_type, reason: "too_large", bytes: totalBytes };
}

/** Builds the record line for one capture, and the images it keeps beside it. */
export async function conversationRecord(
  capture: ConversationCapture,
): Promise<{ line: string; images: StoredImage[] }> {
  const shelf = new ImageShelf(recordDay(capture.createdAt));
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
  return { line, images: shelf.images };
}
