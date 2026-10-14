/**
 * App Attest assertion verification, on its own.
 *
 * Split from `./app-attest` because the two are paid for at different rates.
 * Attestation runs once per install and needs a certificate chain parsed —
 * `pkijs` and `asn1js` — while an assertion is checked on every request an App
 * Attest application serves, and needs only CBOR and an ECDSA verify. Keeping
 * them apart keeps the certificate libraries off the proxy path entirely.
 * Still imported dynamically by its callers, so a server application's isolate
 * never parses even this.
 */

import { Buffer } from "node:buffer";
import { createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { decode } from "cbor-x";
import { GatewayError } from "../core/errors";
import { ttlCache } from "../core/ttl-cache";

interface AssertionObject {
  signature?: unknown;
  authenticatorData?: unknown;
}

export function fail(message = "App Attest proof was rejected"): never {
  throw new GatewayError(403, "attest_failed", message);
}

/** Standard or URL-safe base64, which Node's decoder reads alike. Empty is refused. */
export function decodeBase64(value: string, label: string): Buffer {
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.byteLength === 0) fail(`${label} is not valid base64`);
    return decoded;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    return fail(`${label} is not valid base64`);
  }
}

export async function sha256(value: Uint8Array): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer));
}

export function uint32(bytes: Uint8Array, offset: number): number {
  if (bytes.byteLength < offset + 4) fail();
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

/**
 * The client data the token exchange's assertion signs: the challenge it
 * consumes, bound to the application and the key. A per-request proof signs
 * different client data; see `./request-proof`.
 */
export function assertionClientData(app: string, challenge: string, keyId: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ app, challenge, key_id: keyId }));
}

/**
 * Imported public keys by PEM. Every request of an install verifies against
 * the same key, and importing it is most of what a verify costs otherwise.
 */
const publicKeys = ttlCache<string, KeyObject>({
  name: "app-attest-public-key",
  ttlMs: 10 * 60_000,
  maxEntries: 10_000,
});

function publicKey(pem: string): KeyObject {
  let key = publicKeys.get(pem);
  if (!key) {
    key = createPublicKey(pem);
    publicKeys.set(pem, key);
  }
  return key;
}

/**
 * Verifies one App Attest assertion over `clientDataHash` — the SHA-256 of
 * whatever the device passed to `generateAssertion` — and answers its counter.
 *
 * Whether that counter is acceptable is not decided here: the counter is
 * per-install state, and the install's limiter Durable Object owns it, so the
 * caller hands it on.
 */
export async function verifyAppAssertion(input: {
  /** `<team id>.<bundle id>`, whose hash the authenticator data must start with. */
  rpId: string;
  /** The CBOR assertion, base64 or base64url. */
  assertion: string;
  publicKeyPem: string;
  clientDataHash: Uint8Array;
}): Promise<number> {
  let decoded: unknown;
  try {
    decoded = decode(decodeBase64(input.assertion, "assertion"));
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    return fail();
  }
  if (typeof decoded !== "object" || decoded === null) fail();
  const assertion = decoded as AssertionObject;
  if (
    !(assertion.signature instanceof Uint8Array) ||
    !(assertion.authenticatorData instanceof Uint8Array) ||
    assertion.authenticatorData.byteLength < 37
  ) fail();

  const authenticatorData = Buffer.from(assertion.authenticatorData);
  const nonce = await sha256(Buffer.concat([authenticatorData, input.clientDataHash]));
  let verified = false;
  try {
    const verifier = createVerify("SHA256");
    verifier.update(nonce);
    verified = verifier.verify(publicKey(input.publicKeyPem), Buffer.from(assertion.signature));
  } catch {
    return fail();
  }
  if (!verified) fail("App Attest assertion signature is invalid");
  if (!bytesEqual(authenticatorData.subarray(0, 32), await sha256(Buffer.from(input.rpId)))) fail();
  return uint32(authenticatorData, 33);
}
