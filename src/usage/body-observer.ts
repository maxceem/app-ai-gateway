/**
 * The bounded observer that lets a response be read twice: once by the client,
 * once by accounting. It knows nothing about providers, usage shapes or
 * pricing — it hands `./usage-readers.ts` two windows of text and that is all.
 */

/**
 * The two windows the observer keeps. Usage lives at one end of every shape
 * the readers know — OpenAI puts `usage` last, an SSE stream reports in its
 * final events, and Anthropic's `message_start` opens the stream — so the ends
 * are what a body is kept for. The middle of a batch of embeddings or a long
 * tool result is megabytes of text that says nothing about what was billed.
 */
export const OBSERVER_HEAD_BYTES = 256 * 1024;
export const OBSERVER_TAIL_BYTES = 1024 * 1024;

/** Exactly what `Response.body` is, so the pipe stays assignable to it. */
type ResponseBodyStream = ReadableStream<Uint8Array<ArrayBuffer>>;

/** The text of one response body: the whole of it, or its two ends. */
export interface ObservedText {
  /** The start of the body, and all of it unless `truncated`. */
  head: string;
  /** The end of the body; empty unless `truncated`. */
  tail: string;
  /** True when bytes between the two windows were dropped. */
  truncated: boolean;
}

/** One body as the observer kept it, with what it measured of the whole. */
export interface BodyWindows extends ObservedText {
  /** Every byte the upstream delivered, including the dropped ones. */
  totalBytes: number;
}

/** An untruncated body, for callers that already hold the whole text. */
export function wholeBody(text: string): ObservedText {
  return { head: text, tail: "", truncated: false };
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Collects the first {@link OBSERVER_HEAD_BYTES} and the last
 * {@link OBSERVER_TAIL_BYTES} of a body, and never more than their sum: a
 * response of any size costs the same bounded memory, where buffering it whole
 * would let one batch embeddings call decide how much an isolate holds.
 *
 * Chunks are copied in rather than referenced, because the same bytes are on
 * their way to the client and are not the observer's to keep.
 */
export function bodyWindows(): {
  push(chunk: Uint8Array): void;
  /** Bytes retained right now: the memory bound this observer promises. */
  retainedBytes(): number;
  read(): BodyWindows;
} {
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
      // Drop whole chunks off the front of the ring, then trim the one that
      // straddles the boundary, so the tail is exactly the last window's bytes.
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
    retainedBytes: () => headBytes + tailBytes,
    read() {
      const decoder = new TextDecoder();
      const tailBuffer = concatBytes(tail, tailBytes);
      // Short bodies leave the windows overlapping, and the overlap is exactly
      // the bytes the head already holds: dropping it rebuilds the body byte
      // for byte, so everything below a window's worth parses as it always did.
      if (headBytes + tailBytes >= totalBytes) {
        const whole = new Uint8Array(totalBytes);
        whole.set(concatBytes(head, headBytes));
        whole.set(tailBuffer.subarray(headBytes + tailBytes - totalBytes), headBytes);
        return { ...wholeBody(decoder.decode(whole)), totalBytes };
      }
      return {
        head: decoder.decode(concatBytes(head, headBytes)),
        // The tail starts mid-character as easily as mid-event; the decoder
        // marks the broken lead character and the parsers drop the event.
        tail: decoder.decode(tailBuffer),
        truncated: true,
        totalBytes,
      };
    },
  };
}

/** What the usage observer saw of one upstream response body. */
export interface ObservedBody extends BodyWindows {
  /** True only when the client stopped reading before the upstream was done. */
  aborted: boolean;
}

/**
 * Splits one upstream body into the bytes the client reads and the text the
 * usage observer reads, as a single pipe rather than a `tee()`.
 *
 * A tee keeps pulling the source to feed the observer branch after the client
 * branch is cancelled, so a user closing the app mid-generation leaves the
 * provider generating and the operator paying for tokens nobody will see. Here
 * the client's stream *is* the pipe: cancelling it cancels the upstream, and
 * the observer settles with whatever had arrived by then.
 */
export function observeUpstreamBody(body: ResponseBodyStream): {
  stream: ResponseBodyStream;
  observed: Promise<ObservedBody>;
} {
  const windows = bodyWindows();
  // Set both when the client cancels its side and when the pipe tears the
  // transform down after an upstream failure; the two are told apart below by
  // whether the pipe itself finished cleanly.
  let cancelled = false;
  const transform = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      // The client's copy goes out first and unchanged: accounting never
      // rewrites a byte and never holds one back.
      controller.enqueue(chunk);
      windows.push(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const settle = (aborted: boolean): ObservedBody => ({ ...windows.read(), aborted });
  const observed = body.pipeTo(transform.writable).then(
    // A pipe that ran to completion either delivered the whole body or ended
    // because the client cancelled; an upstream that broke mid-body rejects
    // instead, and that is the provider's doing, not the client's.
    () => settle(cancelled),
    () => settle(false),
  );
  return { stream: transform.readable, observed };
}
