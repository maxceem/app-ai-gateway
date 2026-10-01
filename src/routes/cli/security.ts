import { GatewayError } from "../../core/errors";
import { digest } from "../../management/digest";

export { digest };

const encoder = new TextEncoder();
export async function derive(secret: string, purpose: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(purpose)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function proofMatches(
  raw: unknown,
  expected: string | null,
): Promise<boolean> {
  if (typeof raw !== "string" || !expected) return false;
  const hash = await digest(raw);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(expected),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(hash));
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(expected));
}
export async function cliJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader)
    throw new GatewayError(
      400,
      "invalid_request",
      "A JSON request is required",
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw new GatewayError(413, "invalid_request", "Request is too large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GatewayError(
      400,
      "invalid_request",
      "A valid JSON request is required",
    );
  }
}
