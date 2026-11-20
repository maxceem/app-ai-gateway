/**
 * Watching a provider's response on its way to the app, without holding it.
 *
 * The response is piped to the app as it arrives. On the side, only the first
 * 256 KB and the last 1 MB are kept, which is where every usage report is (at
 * the start or the end of a body or stream). Ported from v1's body observer.
 */

import type { ApiStyle } from "../providers/operation.ts";

export const OBSERVER_HEAD_BYTES = 256 * 1024;
export const OBSERVER_TAIL_BYTES = 1024 * 1024;

export interface ObservedText {
  readonly head: string;
  readonly tail: string;
  /** True when the middle was dropped; `head` then holds only the start. */
  readonly truncated: boolean;
}

export interface ObservedBody extends ObservedText {
  readonly totalBytes: number;
  /** The app went away before the end: the rest was never read from the provider. */
  readonly clientAborted: boolean;
  /** The provider's stream broke before the end. */
  readonly upstreamFailed: boolean;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Keeps the head and tail windows of a stream of chunks. */
export function bodyWindows(): { push(chunk: Uint8Array): void; read(): ObservedText & { totalBytes: number } } {
  const head: Uint8Array[] = [];
  const tail: Uint8Array[] = [];
  let headBytes = 0;
  let tailBytes = 0;
  let totalBytes = 0;
  return {
    push(chunk) {
      totalBytes += chunk.byteLength;
      if (headBytes < OBSERVER_HEAD_BYTES) {
        const take = Math.min(chunk.byteLength, OBSERVER_HEAD_BYTES - headBytes);
        head.push(chunk.slice(0, take));
        headBytes += take;
      }
      tail.push(chunk.slice());
      tailBytes += chunk.byteLength;
      while (tailBytes > OBSERVER_TAIL_BYTES) {
        const excess = tailBytes - OBSERVER_TAIL_BYTES;
        const first = tail[0]!;
        if (excess >= first.byteLength) {
          tail.shift();
          tailBytes -= first.byteLength;
        } else {
          tail[0] = first.slice(excess);
          tailBytes -= excess;
        }
      }
    },
    read() {
      const decoder = new TextDecoder();
      const tailBuffer = concat(tail, tailBytes);
      if (headBytes + tailBytes >= totalBytes) {
        // Head and tail overlap or meet: rebuild the whole body once.
        const whole = new Uint8Array(totalBytes);
        whole.set(concat(head, headBytes));
        whole.set(tailBuffer.subarray(headBytes + tailBytes - totalBytes), headBytes);
        return { head: decoder.decode(whole), tail: "", truncated: false, totalBytes };
      }
      return {
        head: decoder.decode(concat(head, headBytes)),
        tail: decoder.decode(tailBuffer),
        truncated: true,
        totalBytes,
      };
    },
  };
}

/** One whole SSE frame: its event name and its data, comment lines skipped. */
interface SseFrame {
  readonly event: string | null;
  readonly data: string;
}

/**
 * The last frame of a kept stream, or null when there is none. A frame ends
 * with a blank line, so text after the last blank line is a frame still
 * arriving, and is not one.
 */
function lastFrame(text: string, startsAtBoundary: boolean, skip: (frame: SseFrame) => boolean): SseFrame | null {
  const blocks = text.replace(/\r\n/gu, "\n").split("\n\n");
  // The last block is whatever follows the last blank line: an unfinished
  // frame, or nothing. The first is the rest of a frame cut by the kept
  // window, unless the text starts where the stream does.
  const first = startsAtBoundary ? 0 : 1;
  for (let index = blocks.length - 2; index >= first; index -= 1) {
    let event: string | null = null;
    const data: string[] = [];
    for (const line of blocks[index]!.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (event === null && data.length === 0) continue;
    const frame = { event, data: data.join("\n") };
    if (!skip(frame)) return frame;
  }
  return null;
}

/** The `type` of a frame's data, when the data is a whole JSON object. */
function dataType(frame: SseFrame): string | null {
  try {
    const value = JSON.parse(frame.data) as unknown;
    const type = typeof value === "object" && value !== null ? (value as { type?: unknown }).type : undefined;
    return typeof type === "string" ? type : null;
  } catch {
    return null;
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a frame is one of `names`, by its data's `type`, else by its event
 * name. Its data must be whole JSON either way: a cut payload never closes a
 * stream.
 */
function namedFrame(frame: SseFrame, names: readonly string[]): boolean {
  const type = dataType(frame);
  if (type !== null) return names.includes(type);
  return frame.event !== null && names.includes(frame.event) && isJson(frame.data);
}

/** Whether a frame is its style's closing event. Null for a style whose stream has none. */
const CLOSING: Readonly<Record<ApiStyle, ((frame: SseFrame) => boolean) | null>> = {
  "openai-chat": (frame) => frame.data === "[DONE]",
  "openai-completions": (frame) => frame.data === "[DONE]",
  "openai-responses": (frame) => namedFrame(frame, ["response.completed", "response.incomplete", "response.failed"]),
  "anthropic-messages": (frame) => namedFrame(frame, ["message_stop"]),
  // Gemini's stream has no closing event: it simply ends.
  "gemini-generate": null,
  // The media APIs' streams are judged by how they ended, as in v1: their
  // closing events differ from one provider to the next, and a stream booked
  // as cut that was not would say a successful call failed.
  "openai-transcription": null,
  "openai-images": null,
  "openai-embeddings": null,
  "gemini-embed": null,
  "openai-speech": null,
};

/** Whether a style's stream closes with `[DONE]` itself. */
function closesWithDone(style: ApiStyle): boolean {
  return style === "openai-chat" || style === "openai-completions";
}

/**
 * Whether a kept stream ended with its style's closing event: the provider
 * had sent everything. Null for a style whose stream has no closing event, so
 * only the end of the stream says it is whole.
 */
export function streamClosed(body: ObservedText, style: ApiStyle): boolean | null {
  const closing = CLOSING[style];
  if (closing === null) return null;
  // A kept tail starts wherever the window cut the stream, maybe mid-frame.
  // A `[DONE]` some services send after a Responses or Messages stream's
  // closing event is not the stream's own last word.
  const skip = (frame: SseFrame) => !closesWithDone(style) && frame.data === "[DONE]";
  const frame = body.truncated ? lastFrame(body.tail, false, skip) : lastFrame(body.head, true, skip);
  return frame !== null && closing(frame);
}

/**
 * Passes `body` through unchanged, and settles `observed` when it ends: read
 * to the end, cancelled by the app, or broken by the provider.
 *
 * A plain pulling stream rather than a TransformStream: a TransformStream's
 * cancel hook also runs when the provider's side fails, which would make a
 * broken provider stream look like the app leaving. Here the two cannot be
 * mixed up. Nothing is read from the provider before the app asks for it.
 */
export function observeBody(body: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  observed: Promise<ObservedBody>;
} {
  const windows = bodyWindows();
  const reader = body.getReader();
  let settle!: (value: ObservedBody) => void;
  const observed = new Promise<ObservedBody>((resolve) => (settle = resolve));
  let settled = false;
  const finish = (clientAborted: boolean, upstreamFailed: boolean) => {
    if (settled) return;
    settled = true;
    settle({ ...windows.read(), clientAborted, upstreamFailed });
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (error) {
          finish(false, true);
          controller.error(error);
          return;
        }
        if (result.done) {
          finish(false, false);
          controller.close();
          return;
        }
        windows.push(result.value);
        controller.enqueue(result.value);
      },
      // The app went away: stop reading from the provider too.
      async cancel(reason) {
        finish(true, false);
        await reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, observed };
}
