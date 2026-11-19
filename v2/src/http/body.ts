/**
 * Reading a request body once, with a hard size limit (plan section 4.1, T11).
 *
 * - The limit counts the bytes actually read, so a missing or wrong
 *   `Content-Length` cannot get a larger body in.
 * - No extra copies: with a `Content-Length`, the bytes go straight into one
 *   buffer of that size. Without one, the chunks are kept and joined once at
 *   the end.
 * - A body over the limit, or longer than its declared length, stops the read
 *   and cancels the rest of the upload.
 */
import { GatewayError } from "../core/errors.ts";

/** The largest request body v2 reads: 20 MiB. */
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

function tooLarge(limit: number): GatewayError {
  return new GatewayError(413, "payload_too_large", `The request body is larger than ${limit} bytes`);
}

/** Reads the whole body as bytes. An absent body reads as zero bytes. */
export async function readBody(request: Request, limit: number = MAX_BODY_BYTES): Promise<Uint8Array> {
  const declaredText = request.headers.get("content-length");
  const declared = declaredText === null || !/^\d{1,16}$/u.test(declaredText) ? null : Number(declaredText);
  if (declared !== null && declared > limit) {
    await request.body?.cancel().catch(() => undefined);
    throw tooLarge(limit);
  }
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const fail = async (error: GatewayError): Promise<never> => {
    await reader.cancel().catch(() => undefined);
    throw error;
  };

  if (declared !== null) {
    const buffer = new Uint8Array(declared);
    let offset = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > declared) {
        return fail(new GatewayError(400, "invalid_request", "The request body is longer than its Content-Length"));
      }
      buffer.set(value, offset);
      offset += value.byteLength;
    }
    return offset === declared ? buffer : buffer.subarray(0, offset);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) return fail(tooLarge(limit));
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0]!;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  chunks.length = 0;
  return joined;
}

/**
 * Remembers one read of a request's body, so the auth check and the handler
 * share it instead of reading twice.
 */
export function bodyOnce(request: Request, limit: number = MAX_BODY_BYTES): () => Promise<Uint8Array> {
  let pending: Promise<Uint8Array> | undefined;
  return () => (pending ??= readBody(request, limit));
}

/** Parses bytes as a JSON object, the shape every auth route body has. */
export function jsonObject(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GatewayError(400, "invalid_request", "The request body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
  return value as Record<string, unknown>;
}
