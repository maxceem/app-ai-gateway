/**
 * Reading a provider's answer into memory, never more of it than a limit.
 * The one reader for every answer the gateway reads whole: a job submit's
 * answer, a status answer whose links it rewrites, and a result body it reads
 * to count outputs.
 */

/** The most of a provider answer the gateway reads into memory. */
export const BODY_READ_LIMIT = 1024 * 1024;

export type BoundedRead =
  /** The whole body, within the limit. */
  | { readonly kind: "whole"; readonly bytes: Uint8Array<ArrayBuffer> }
  /** Larger than the limit: the bytes already read and then the rest, as a stream (cancel it when not passed on). */
  | { readonly kind: "too_large"; readonly stream: ReadableStream<Uint8Array> }
  /** The deadline passed, or the signal fired, before the body ended. The stream is cancelled. */
  | { readonly kind: "stopped" }
  /** The body failed while it was read. */
  | { readonly kind: "read_error"; readonly error: unknown };

const STOPPED = Symbol("stopped");

/**
 * A body read up to `limit` bytes, counted as they arrive, so a large answer
 * is never held whole. `deadlineMs` and `signal` stop the read; `onStop` runs
 * then (to abort the fetch itself), and nothing waits on the stream's own
 * cleanup, which can hang.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array>,
  options: { readonly limit?: number; readonly deadlineMs?: number; readonly signal?: AbortSignal; readonly onStop?: () => void } = {},
): Promise<BoundedRead> {
  const limit = options.limit ?? BODY_READ_LIMIT;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<typeof STOPPED>((resolve) => {
    if (options.deadlineMs !== undefined) timer = setTimeout(() => resolve(STOPPED), options.deadlineMs);
    if (options.signal !== undefined) {
      if (options.signal.aborted) resolve(STOPPED);
      else options.signal.addEventListener("abort", () => resolve(STOPPED), { once: true });
    }
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), stopped]);
      if (next === STOPPED) {
        options.onStop?.();
        void reader.cancel().catch(() => undefined);
        return { kind: "stopped" };
      }
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
      if (size > limit) return { kind: "too_large", stream: thenRest(chunks, reader) };
    }
  } catch (error) {
    return { kind: "read_error", error };
  } finally {
    clearTimeout(timer);
  }
  const bytes = new Uint8Array(new ArrayBuffer(size));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { kind: "whole", bytes };
}

/** A stream that gives the chunks already read, then the rest of the reader. */
function thenRest(chunks: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next < chunks.length) {
        controller.enqueue(chunks[next]!);
        chunks[next++] = new Uint8Array(0);
        return;
      }
      const part = await reader.read();
      if (part.done) controller.close();
      else controller.enqueue(part.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Bytes as JSON, or `undefined` when they are not whole JSON. */
export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}
