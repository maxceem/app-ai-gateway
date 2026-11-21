/**
 * Watching a provider's response on its way to the app, without holding it.
 *
 * The response is piped to the app as it arrives. Each piece is handed on to
 * a reader (`readResponse` in `./meter.ts`) only after it is passed to the
 * app, so reading never delays the answer, and the reader keeps what it needs
 * as the body streams past. Nothing of the body is kept here, except the
 * start of an error answer, for its error code, and the pieces of an answer
 * whose conversation is stored (`keepWhole`), up to its cap. Those pieces are
 * never joined here: the app's answer ends first, and whoever stores them joins
 * them later, in the background (`wholeBody`).
 */

/** How much of an error answer is kept, for its error code. Error bodies are small. */
export const ERROR_HEAD_BYTES = 256 * 1024;

export interface ObservedBody {
  readonly totalBytes: number;
  /** The start of the body as text, when kept (`keepHead`): an error answer's. */
  readonly head: string;
  /**
   * The body's pieces, in order, when kept (`keepWhole`) and no larger than its
   * cap; null otherwise. Join them with `wholeBody`, off the answer's path.
   */
  readonly whole: readonly Uint8Array[] | null;
  /** The app went away before the end: the rest was never read from the provider. */
  readonly clientAborted: boolean;
  /** The provider's stream broke before the end. */
  readonly upstreamFailed: boolean;
}

export interface ObserveOptions {
  /** Called with each piece, after it is passed to the app. */
  readonly onChunk?: (chunk: Uint8Array) => void;
  /** Keep the start of the body, for an error answer's code. */
  readonly keepHead?: boolean;
  /** Keep the whole body, up to this many bytes; past it, none of it (a stored conversation's). */
  readonly keepWhole?: number;
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
export function observeBody(
  body: ReadableStream<Uint8Array>,
  options: ObserveOptions = {},
): {
  stream: ReadableStream<Uint8Array>;
  observed: Promise<ObservedBody>;
} {
  const reader = body.getReader();
  const head: Uint8Array[] = [];
  let headBytes = 0;
  let whole: Uint8Array[] | null = options.keepWhole === undefined ? null : [];
  let totalBytes = 0;
  let onChunk = options.onChunk;
  let settle!: (value: ObservedBody) => void;
  const observed = new Promise<ObservedBody>((resolve) => (settle = resolve));
  let settled = false;
  const finish = (clientAborted: boolean, upstreamFailed: boolean) => {
    if (settled) return;
    settled = true;
    const kept = new Uint8Array(headBytes);
    let at = 0;
    for (const piece of head) {
      kept.set(piece, at);
      at += piece.byteLength;
    }
    settle({ totalBytes, head: new TextDecoder().decode(kept), whole, clientAborted, upstreamFailed });
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
          // The app's answer ends first; what was observed is settled after.
          controller.close();
          finish(false, false);
          return;
        }
        const chunk = result.value;
        controller.enqueue(chunk);
        totalBytes += chunk.byteLength;
        if (whole !== null) {
          if (totalBytes > (options.keepWhole ?? 0)) whole = null;
          else whole.push(chunk.slice());
        }
        if (options.keepHead === true && headBytes < ERROR_HEAD_BYTES) {
          const take = Math.min(chunk.byteLength, ERROR_HEAD_BYTES - headBytes);
          head.push(chunk.slice(0, take));
          headBytes += take;
        }
        if (onChunk !== undefined) {
          try {
            onChunk(chunk);
          } catch {
            // The reader reports its own failures; one it did not catch only
            // stops the reading, never the answer.
            onChunk = undefined;
          }
        }
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

/** Joins kept pieces into one body. Call it off the answer's path, where the body is stored. */
export function wholeBody(pieces: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const piece of pieces) size += piece.byteLength;
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const piece of pieces) {
    joined.set(piece, offset);
    offset += piece.byteLength;
  }
  return joined;
}
