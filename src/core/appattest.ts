import { Buffer } from "node:buffer";
import { createPublicKey, createVerify, X509Certificate } from "node:crypto";
import * as asn1js from "asn1js";
import { decode } from "cbor-x";
import { Certificate } from "pkijs";
import { GatewayError } from "./errors";

const APPLE_APP_ATTEST_ROOT = new X509Certificate(`-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`);

interface AttestationObject {
  fmt: unknown;
  attStmt?: { x5c?: unknown; receipt?: unknown };
  authData?: unknown;
}

interface AssertionObject {
  signature?: unknown;
  authenticatorData?: unknown;
}

function fail(message = "App Attest proof was rejected"): never {
  throw new GatewayError(403, "attest_failed", message);
}

function decodeBase64(value: string, label: string): Buffer {
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.byteLength === 0) fail(`${label} is not valid base64`);
    return decoded;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    return fail(`${label} is not valid base64`);
  }
}

async function sha256(value: Uint8Array): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer));
}

function uint32(bytes: Uint8Array, offset: number): number {
  if (bytes.byteLength < offset + 4) fail();
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export function appAttestEnvironment(
  authData: Uint8Array,
): "production" {
  if (authData.byteLength < 53) fail();
  const aaguid = authData.subarray(37, 53);
  const productionAaguid = Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)]);
  if (!bytesEqual(aaguid, productionAaguid)) fail();
  return "production";
}

function certificateIsCurrent(certificate: X509Certificate): boolean {
  const now = Date.now();
  return now >= Date.parse(certificate.validFrom) && now <= Date.parse(certificate.validTo);
}

function findNonce(value: unknown, expected: Uint8Array): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const valueBlock = record.valueBlock;
  if (typeof valueBlock === "object" && valueBlock !== null) {
    const block = valueBlock as Record<string, unknown>;
    if (block.valueHexView instanceof Uint8Array && bytesEqual(block.valueHexView, expected)) return true;
    if (Array.isArray(block.value) && block.value.some((child) => findNonce(child, expected))) return true;
  }
  return false;
}

function parsePkiCertificate(certificate: X509Certificate): Certificate {
  const parsed = asn1js.fromBER(Uint8Array.from(certificate.raw).buffer);
  if (parsed.offset === -1) fail();
  return new Certificate({ schema: parsed.result });
}

function assertAttestationShape(value: unknown): {
  authData: Buffer;
  certificateDer: Buffer;
  intermediateDer: Buffer;
} {
  if (typeof value !== "object" || value === null) fail();
  const decoded = value as AttestationObject;
  const x5c = decoded.attStmt?.x5c;
  if (
    decoded.fmt !== "apple-appattest" ||
    !Array.isArray(x5c) ||
    x5c.length !== 2 ||
    !(x5c[0] instanceof Uint8Array) ||
    !(x5c[1] instanceof Uint8Array) ||
    !(decoded.attStmt?.receipt instanceof Uint8Array) ||
    !(decoded.authData instanceof Uint8Array) ||
    decoded.authData.byteLength < 87
  ) fail();
  return {
    authData: Buffer.from(decoded.authData),
    certificateDer: Buffer.from(x5c[0]),
    intermediateDer: Buffer.from(x5c[1]),
  };
}

export async function verifyAppAttestation(input: {
  appId: string;
  keyId: string;
  challenge: string;
  attestation: string;
}): Promise<{ publicKeyPem: string }> {
  let decoded: unknown;
  try {
    decoded = decode(decodeBase64(input.attestation, "attestation"));
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    return fail();
  }
  const proof = assertAttestationShape(decoded);
  let credential: X509Certificate;
  let intermediate: X509Certificate;
  try {
    credential = new X509Certificate(proof.certificateDer);
    intermediate = new X509Certificate(proof.intermediateDer);
  } catch {
    return fail();
  }
  if (
    !certificateIsCurrent(credential) ||
    !certificateIsCurrent(intermediate) ||
    !credential.checkIssued(intermediate) ||
    !credential.verify(intermediate.publicKey) ||
    !intermediate.checkIssued(APPLE_APP_ATTEST_ROOT) ||
    !intermediate.verify(APPLE_APP_ATTEST_ROOT.publicKey)
  ) fail();

  const challengeHash = await sha256(decodeBase64(input.challenge, "challenge"));
  const nonce = await sha256(Buffer.concat([proof.authData, challengeHash]));
  const pkiCertificate = parsePkiCertificate(credential);
  const extension = pkiCertificate.extensions?.find((item) => item.extnID === "1.2.840.113635.100.8.2");
  if (!extension) fail();
  const parsedExtension = asn1js.fromBER(Uint8Array.from(extension.extnValue.valueBlock.valueHexView).buffer);
  if (parsedExtension.offset === -1 || !findNonce(parsedExtension.result, nonce)) fail();

  const publicKeyBytes = pkiCertificate.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView;
  if ((await sha256(publicKeyBytes)).toString("base64") !== input.keyId) fail();
  const expectedRpId = await sha256(Buffer.from(input.appId));
  if (!bytesEqual(proof.authData.subarray(0, 32), expectedRpId)) fail();
  if (uint32(proof.authData, 33) !== 0) fail();
  appAttestEnvironment(proof.authData);
  const credentialLength = proof.authData.readUInt16BE(53);
  if (credentialLength !== 32 || proof.authData.byteLength < 55 + credentialLength) fail();
  if (proof.authData.subarray(55, 55 + credentialLength).toString("base64") !== input.keyId) fail();

  const exported = credential.publicKey.export({ type: "spki", format: "pem" });
  if (typeof exported !== "string") fail();
  return { publicKeyPem: exported };
}

export function assertionClientData(app: string, challenge: string, keyId: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ app, challenge, key_id: keyId }));
}

export async function verifyAppAssertion(input: {
  gatewayAppId: string;
  rpId: string;
  keyId: string;
  challenge: string;
  assertion: string;
  publicKeyPem: string;
  previousCounter: number;
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
  const clientDataHash = await sha256(assertionClientData(input.gatewayAppId, input.challenge, input.keyId));
  const nonce = await sha256(Buffer.concat([authenticatorData, clientDataHash]));
  let verified = false;
  try {
    const verifier = createVerify("SHA256");
    verifier.update(nonce);
    verified = verifier.verify(createPublicKey(input.publicKeyPem), Buffer.from(assertion.signature));
  } catch {
    return fail();
  }
  if (!verified) fail();
  if (!bytesEqual(authenticatorData.subarray(0, 32), await sha256(Buffer.from(input.rpId)))) fail();
  const nextCounter = uint32(authenticatorData, 33);
  if (nextCounter <= input.previousCounter) fail();
  return nextCounter;
}
