import { GatewayError } from "../../core/errors";
import { secretVault } from "../../vault";

export const TTL = 15 * 60_000;
const encoder = new TextEncoder();
export async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
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
export function proof(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(value))
    throw new GatewayError(
      400,
      "invalid_request",
      "A random 32-character or longer proof is required",
    );
  return value;
}
export function credentialContext(id: string, pollProofHash: string) {
  return { purpose: "cli-credential-exchange", operationId: id, pollProofHash };
}
export async function protectCredential(
  env: Env,
  id: string,
  pollHash: string,
  value: unknown,
): Promise<string> {
  return secretVault(env).encryptSecret(
    JSON.stringify(value),
    credentialContext(id, pollHash),
  );
}
export async function openCredential(
  env: Env,
  id: string,
  pollHash: string,
  ciphertext: string,
): Promise<unknown> {
  return JSON.parse(
    await secretVault(env).decryptSecret(
      ciphertext,
      credentialContext(id, pollHash),
    ),
  );
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
