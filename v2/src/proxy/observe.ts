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

/**
 * How each API style's stream says it has sent everything: its last event.
 * Gemini has no closing event; its last chunk names why the answer ended.
 */
const LAST_EVENT: Readonly<Record<ApiStyle, RegExp>> = {
  "openai-chat": /^data:\s*\[DONE\]$/u,
  "openai-completions": /^data:\s*\[DONE\]$/u,
  "openai-responses": /"type"\s*:\s*"response\.(?:completed|incomplete|failed)"/u,
  "anthropic-messages": /"type"\s*:\s*"message_stop"/u,
  "gemini-generate": /"finishReason"\s*:/u,
};

/** Whether a kept stream ends with its style's last event: the provider had sent everything. */
export function streamFinished(body: ObservedText, style: ApiStyle): boolean {
  const text = (body.truncated ? body.tail : body.head).replace(/\r\n/gu, "\n").trimEnd();
  const last = text.slice(text.lastIndexOf("\n\n") + 1).trim();
  return LAST_EVENT[style].test(last.split("\n").find((line) => line.startsWith("data:")) ?? "");
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
