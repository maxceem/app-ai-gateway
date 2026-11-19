/**
 * Watching a provider's response on its way to the app, without holding it.
 *
 * The response is piped to the app as it arrives. On the side, only the first
 * 256 KB and the last 1 MB are kept, which is where every usage report is (at
 * the start or the end of a body or stream). Ported from v1's body observer.
 */

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
 * Passes `body` through unchanged, and settles `observed` when it ends: read
 * to the end, cancelled by the app, or broken by the provider.
 */
export function observeBody(body: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  observed: Promise<ObservedBody>;
} {
  const windows = bodyWindows();
  let clientAborted = false;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      windows.push(chunk);
    },
    cancel() {
      clientAborted = true;
    },
  });
  const settle = (upstreamFailed: boolean): ObservedBody => ({
    ...windows.read(),
    clientAborted,
    upstreamFailed: upstreamFailed && !clientAborted,
  });
  // A cancel by the app cancels the provider's body too (pipeTo propagates it).
  const observed = body.pipeTo(transform.writable).then(
    () => settle(false),
    () => settle(true),
  );
  return { stream: transform.readable, observed };
}
