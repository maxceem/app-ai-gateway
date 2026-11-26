import { Buffer } from "node:buffer";
import { X509Certificate } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyAppAttestation } from "../src/client-auth/app-attest.ts";
import { CborError, decodeCbor } from "../src/client-auth/cbor.ts";
import { DerError, appAttestNonce, certificateFields } from "../src/client-auth/der.ts";
import {
  type CborInput,
  type Issued,
  encodeCbor,
  issue,
  newKeys,
  octets,
  rawPublicKey,
  sequence,
  tlv,
} from "./app-attest-fixtures.ts";
import { APPLE_SAMPLE } from "./apple-attestation-sample.ts";

/**
 * Apple will not attest anything for a test, and publishes no attestation
 * whose certificates are still valid, so these build a stand-in chain the way
 * Apple shapes its own: a root, an intermediate, and a credential certificate
 * for the device's key that carries the nonce in Apple's extension. The
 * verifier gets the stand-in root in place of Apple's. A real iPhone checks
 * the real chain on the test deployment.
 */
const NONCE_OID = "1.2.840.113635.100.8.2";
const APP_ID = "TEAMID1234.com.example.app";
const CHALLENGE = Buffer.from("a challenge from the gateway").toString("base64");

async function digest(value: Uint8Array): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer));
}

interface Attestation {
  attestation: string;
  keyId: string;
  root: Issued;
}

type Options = {
  appId?: string;
  aaguid?: Buffer;
  counter?: number;
  credentialId?: Buffer;
  challenge?: string;
  /** Replaces the nonce extension's value. */
  nonceExtension?: (nonce: Buffer) => Uint8Array | null;
  /** Builds the attestation object from its parts. */
  shape?: (parts: { authData: Buffer; leaf: Buffer; intermediate: Buffer }) => CborInput;
  otherRoot?: boolean;
  leafExpired?: boolean;
  intermediateExpired?: boolean;
  /** Valid from tomorrow. */
  leafNotYetValid?: boolean;
  intermediateNotYetValid?: boolean;
  /** The intermediate as an end-entity certificate the root issued. */
  intermediateNotCa?: boolean;
  /** Cuts authData to this length before the nonce is made, so every earlier check still passes. */
  authDataLength?: number;
  /** Signs the credential certificate, or the intermediate, with an attacker's key under the real issuer's name. */
  forge?: "leaf" | "intermediate";
  /** The credential id's length field. */
  credentialLength?: number;
  /** The key id and credential id name one key; the certificate holds another. */
  otherCertificateKey?: boolean;
};

async function attestation(options: Options = {}): Promise<Attestation> {
  const root = await issue({ name: "Test App Attestation Root CA", ca: true });
  const attacker = await newKeys();
  const intermediate = await issue({
    name: "Test App Attestation CA 1",
    issuer: root,
    ca: !options.intermediateNotCa,
    ...(options.intermediateNotYetValid ? { notBefore: Date.now() + 86_400_000, notAfter: Date.now() + 2 * 86_400_000 } : {}),
    ...(options.forge === "intermediate" ? { forgedBy: attacker } : {}),
    ...(options.intermediateExpired ? { notBefore: Date.now() - 2 * 86_400_000, notAfter: Date.now() - 86_400_000 } : {}),
  });
  const keys = await newKeys();
  const point = await rawPublicKey(options.otherCertificateKey ? await newKeys() : keys);
  const keyHash = await digest(point);

  let authData = Buffer.alloc(87 + 77);
  (await digest(Buffer.from(options.appId ?? APP_ID))).copy(authData, 0);
  authData[32] = 0x40;
  authData.writeUInt32BE(options.counter ?? 0, 33);
  (options.aaguid ?? Buffer.from("appattestdevelop")).copy(authData, 37);
  authData.writeUInt16BE(options.credentialLength ?? 32, 53);
  (options.credentialId ?? keyHash).copy(authData, 55);
  if (options.authDataLength !== undefined) authData = authData.subarray(0, options.authDataLength);

  const nonce = await digest(Buffer.concat([authData, await digest(Buffer.from(options.challenge ?? CHALLENGE, "base64"))]));
  const extensionValue = options.nonceExtension
    ? options.nonceExtension(nonce)
    : sequence(tlv(0xa1, octets(nonce)));
  const leaf = await issue({
    name: "Test App Attest credential",
    issuer: intermediate,
    ca: false,
    keys,
    ...(options.forge === "leaf" ? { forgedBy: attacker } : {}),
    ...(extensionValue === null ? {} : { extensions: [{ oid: NONCE_OID, value: extensionValue }] }),
    ...(options.leafExpired ? { notBefore: Date.now() - 2 * 86_400_000, notAfter: Date.now() - 86_400_000 } : {}),
    ...(options.leafNotYetValid ? { notBefore: Date.now() + 86_400_000, notAfter: Date.now() + 2 * 86_400_000 } : {}),
  });
  const parts = { authData, leaf: leaf.der, intermediate: intermediate.der };
  const object = options.shape
    ? options.shape(parts)
    : { fmt: "apple-appattest", attStmt: { x5c: [parts.leaf, parts.intermediate], receipt: Buffer.from("receipt") }, authData };
  return {
    attestation: encodeCbor(object).toString("base64"),
    keyId: keyHash.toString("base64"),
    root: options.otherRoot ? await issue({ name: "Some other root", ca: true }) : root,
  };
}

function verify(made: Attestation, overrides: { challenge?: string; keyId?: string; attestation?: string } = {}) {
  return verifyAppAttestation({
    appId: APP_ID,
    allowedEnvironments: ["development", "production"],
    keyId: overrides.keyId ?? made.keyId,
    challenge: overrides.challenge ?? CHALLENGE,
    attestation: overrides.attestation ?? made.attestation,
    root: made.root.certificate,
  });
}

const refused = { status: 403, code: "attest_failed" };

/**
 * The certificate with one bit flipped in its public key, so it still parses
 * but reading its key throws (the iPhone check's broken intermediate, T33).
 */
function withBrokenKey(der: Buffer): Buffer {
  const spki = new X509Certificate(der).publicKey.export({ type: "spki", format: "der" });
  const at = der.indexOf(spki);
  if (at < 0) throw new Error("public key not found in the certificate");
  const broken = Buffer.from(der);
  broken[at + spki.length - 1]! ^= 0x01;
  const certificate = new X509Certificate(broken);
  expect(() => certificate.publicKey).toThrow();
  return broken;
}

describe("an App Attest attestation", () => {
  let valid: Attestation;

  beforeAll(async () => {
    valid = await attestation();
  });

  it("accepts a well-formed attestation and answers the key and its environment", async () => {
    const result = await verify(valid);
    expect(result.environment).toBe("development");
    expect(result.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/u);
    const production = await attestation({ aaguid: Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)]) });
    expect((await verify(production)).environment).toBe("production");
  });

  it("refuses a nonce for another challenge, and a nonce extension that is missing or shaped otherwise", async () => {
    await expect(verify(valid, { challenge: Buffer.from("another challenge").toString("base64") })).rejects.toMatchObject(refused);
    await expect(verify(await attestation({ nonceExtension: () => null }))).rejects.toMatchObject(refused);
    // The nonce bare, not inside SEQUENCE { [1] { ... } }.
    await expect(verify(await attestation({ nonceExtension: (nonce) => octets(nonce) }))).rejects.toMatchObject(refused);
    // A second element after the tagged nonce.
    await expect(verify(await attestation({
      nonceExtension: (nonce) => sequence(tlv(0xa1, octets(nonce)), octets(nonce)),
    }))).rejects.toMatchObject(refused);
    // Another tag in place of [1].
    await expect(verify(await attestation({ nonceExtension: (nonce) => sequence(tlv(0xa2, octets(nonce))) })))
      .rejects.toMatchObject(refused);
    // Another type in place of the OCTET STRING.
    await expect(verify(await attestation({ nonceExtension: (nonce) => sequence(tlv(0xa1, tlv(0x0c, nonce))) })))
      .rejects.toMatchObject(refused);
    // A second element inside [1].
    await expect(verify(await attestation({ nonceExtension: (nonce) => sequence(tlv(0xa1, octets(nonce), octets(nonce))) })))
      .rejects.toMatchObject(refused);
    // The nonce one level deeper, under [0].
    await expect(verify(await attestation({ nonceExtension: (nonce) => sequence(tlv(0xa1, tlv(0xa0, octets(nonce)))) })))
      .rejects.toMatchObject(refused);
    // Trailing bytes after the extension's value.
    await expect(verify(await attestation({
      nonceExtension: (nonce) => Buffer.concat([sequence(tlv(0xa1, octets(nonce))), Buffer.from([0])]),
    }))).rejects.toMatchObject(refused);
  });

  it("refuses another app, a counter that is not zero, and an environment the app does not accept", async () => {
    await expect(verify(await attestation({ appId: "TEAMID1234.com.example.other" }))).rejects.toMatchObject(refused);
    await expect(verify(await attestation({ counter: 1 }))).rejects.toMatchObject(refused);
    await expect(verify(await attestation({ aaguid: Buffer.from("appattestunknown") }))).rejects.toMatchObject(refused);
    const production = await attestation();
    await expect(verifyAppAttestation({
      appId: APP_ID,
      allowedEnvironments: ["production"],
      keyId: production.keyId,
      challenge: CHALLENGE,
      attestation: production.attestation,
      root: production.root.certificate,
    })).rejects.toMatchObject(refused);
  });

  it("refuses a key id that is not the certificate's key, and a credential id that is not the key id", async () => {
    await expect(verify(valid, { keyId: Buffer.alloc(32, 7).toString("base64") })).rejects.toMatchObject(refused);
    await expect(verify(await attestation({ credentialId: Buffer.alloc(32, 7) }))).rejects.toMatchObject(refused);
    // Apple's step 5: the key id and the credential id agree, but the certificate holds another key.
    await expect(verify(await attestation({ otherCertificateKey: true }))).rejects.toMatchObject(refused);
    // A credential id whose length is not 32.
    await expect(verify(await attestation({ credentialLength: 31 }))).rejects.toMatchObject(refused);
  });

  it("refuses certificates signed by another key under the real issuer's name", async () => {
    await expect(verify(await attestation({ forge: "leaf" }))).rejects.toMatchObject(refused);
    await expect(verify(await attestation({ forge: "intermediate" }))).rejects.toMatchObject(refused);
  });

  it("refuses a chain to another root, the certificates swapped, and an expired credential certificate", async () => {
    await expect(verify(await attestation({ otherRoot: true }))).rejects.toMatchObject(refused);
    await expect(verify(await attestation({
      shape: ({ authData, leaf, intermediate }) => ({
        fmt: "apple-appattest", attStmt: { x5c: [intermediate, leaf], receipt: Buffer.from("r") }, authData,
      }),
    }))).rejects.toMatchObject(refused);
    await expect(verify(await attestation({ leafExpired: true }))).rejects.toMatchObject(refused);
    await expect(verify(await attestation({ intermediateExpired: true }))).rejects.toMatchObject(refused);
    await expect(verify(await attestation({ leafNotYetValid: true }))).rejects.toMatchObject(refused);
    await expect(verify(await attestation({ intermediateNotYetValid: true }))).rejects.toMatchObject(refused);
  });

  it("refuses an intermediate whose public key does not parse, as 403 and not a gateway error", async () => {
    await expect(verify(await attestation({
      shape: ({ authData, leaf, intermediate }) => ({
        fmt: "apple-appattest", attStmt: { x5c: [leaf, withBrokenKey(intermediate)], receipt: Buffer.from("r") }, authData,
      }),
    }))).rejects.toMatchObject(refused);
  });

  it("refuses an end-entity certificate from the root standing in as the intermediate", async () => {
    await expect(verify(await attestation({ intermediateNotCa: true }))).rejects.toMatchObject(refused);
  });

  it("refuses another format, a missing receipt, one certificate, and CBOR that is cut short or runs on", async () => {
    const shapes: Array<Options["shape"]> = [
      ({ authData, leaf, intermediate }) => ({ fmt: "packed", attStmt: { x5c: [leaf, intermediate], receipt: Buffer.from("r") }, authData }),
      ({ authData, leaf, intermediate }) => ({ fmt: "apple-appattest", attStmt: { x5c: [leaf, intermediate] }, authData }),
      ({ authData, leaf }) => ({ fmt: "apple-appattest", attStmt: { x5c: [leaf], receipt: Buffer.from("r") }, authData }),
      ({ authData, leaf, intermediate }) => ({
        fmt: "apple-appattest", attStmt: { x5c: [leaf, intermediate, intermediate], receipt: Buffer.from("r") }, authData,
      }),
    ];
    for (const shape of shapes) await expect(verify(await attestation({ shape }))).rejects.toMatchObject(refused);
    // authData too short to hold a credential id, with a nonce made over it, refused before it is read.
    await expect(verify(await attestation({ authDataLength: 54 }))).rejects.toMatchObject(refused);
    const bytes = Buffer.from(valid.attestation, "base64");
    await expect(verify(valid, { attestation: bytes.subarray(0, bytes.byteLength - 1).toString("base64") }))
      .rejects.toMatchObject(refused);
    await expect(verify(valid, { attestation: Buffer.concat([bytes, Buffer.from([0x40])]).toString("base64") }))
      .rejects.toMatchObject(refused);
  });
});

describe("the CBOR reader", () => {
  it("reads the shapes App Attest sends", () => {
    expect(decodeCbor(encodeCbor({ signature: Buffer.from([1, 2]), authenticatorData: Buffer.from([3]) }))).toEqual({
      signature: new Uint8Array([1, 2]),
      authenticatorData: new Uint8Array([3]),
    });
    expect(decodeCbor(encodeCbor({ a: { b: [Buffer.alloc(300), "text"] } }))).toEqual({ a: { b: [new Uint8Array(300), "text"] } });
  });

  it("keeps a leading byte order mark, so a format or key with one never reads as the real one", async () => {
    const bom = "\uFEFF";
    expect(decodeCbor(encodeCbor(`${bom}apple-appattest`))).toBe(`${bom}apple-appattest`);
    expect(Object.keys(decodeCbor(encodeCbor({ [`${bom}authData`]: Buffer.from([1]) })) as object)).toEqual([`${bom}authData`]);
    await expect(verify(await attestation({
      shape: ({ authData, leaf, intermediate }) => ({
        fmt: `${bom}apple-appattest`, attStmt: { x5c: [leaf, intermediate], receipt: Buffer.from("r") }, authData,
      }),
    }))).rejects.toMatchObject(refused);
  });

  it("refuses what those shapes never hold", () => {
    const cases: Array<[string, number[]]> = [
      ["an integer", [0x01]],
      ["a negative integer", [0x20]],
      ["a tag", [0xc0, 0x40]],
      ["a float", [0xf9, 0, 0]],
      ["null", [0xf6]],
      ["an indefinite byte string", [0x5f, 0x40, 0xff]],
      ["an indefinite map", [0xbf, 0xff]],
      ["an 8-byte length", [0x5b, 0, 0, 0, 0, 0, 0, 0, 1, 0]],
      ["a length past the end", [0x45, 1, 2]],
      ["a count past the end", [0x9a, 0xff, 0xff, 0xff, 0xff]],
      ["a map key that is not text", [0xa1, 0x41, 0x61, 0x40]],
      ["a duplicate key", [0xa2, 0x61, 0x61, 0x40, 0x61, 0x61, 0x40]],
      ["invalid UTF-8", [0x61, 0xff]],
      ["trailing bytes", [0x40, 0x40]],
      ["nothing", []],
      ["arrays four deep", [0x81, 0x81, 0x81, 0x81, 0x40]],
      ["maps four deep", [0xa1, 0x61, 0x61, 0xa1, 0x61, 0x61, 0xa1, 0x61, 0x61, 0xa1, 0x61, 0x61, 0x40]],
      ["an array of nine", [0x89, ...Array<number>(9).fill(0x40)]],
      ["a map of nine", [0xa9, ...Array.from({ length: 9 }, (_, index) => [0x61, 0x61 + index, 0x40]).flat()]],
    ];
    for (const [label, bytes] of cases) {
      expect(() => decodeCbor(Uint8Array.from(bytes)), label).toThrow(CborError);
    }
  });
});

describe("the DER reader", () => {
  let leaf: Issued;

  beforeAll(async () => {
    const root = await issue({ name: "Root", ca: true });
    leaf = await issue({
      name: "Leaf",
      issuer: root,
      ca: false,
      extensions: [{ oid: NONCE_OID, value: sequence(tlv(0xa1, octets(Buffer.alloc(32, 9)))) }],
    });
  });

  it("finds the public key and the extensions of a certificate", async () => {
    const fields = certificateFields(leaf.der);
    expect(Buffer.from(fields.publicKey)).toEqual(await rawPublicKey(leaf.keys));
    expect([...fields.extensions.keys()]).toEqual(["2.5.29.19", NONCE_OID]);
    expect(Buffer.from(appAttestNonce(fields.extensions.get(NONCE_OID)!))).toEqual(Buffer.alloc(32, 9));
  });

  it("refuses a certificate cut short, with trailing bytes, with an indefinite length, or with a length not in its shortest form", () => {
    expect(() => certificateFields(leaf.der.subarray(0, leaf.der.byteLength - 1))).toThrow(DerError);
    expect(() => certificateFields(Buffer.concat([leaf.der, Buffer.from([0])]))).toThrow(DerError);
    // The same certificate, its outer length re-encoded. It starts 30 82 <two length bytes>.
    expect([leaf.der[0], leaf.der[1]]).toEqual([0x30, 0x82]);
    // BER's indefinite length, 0x80, followed by exactly 128 bytes that would be well formed if 0x80 were read
    // as a length of 128: SEQUENCE { [1] { OCTET STRING (124 bytes) } }.
    const indefinite = Buffer.concat([Buffer.from([0x30, 0x80, 0xa1, 0x7e, 0x04, 0x7c]), Buffer.alloc(124, 9)]);
    expect(indefinite.byteLength).toBe(2 + 128);
    expect(() => appAttestNonce(indefinite)).toThrow(DerError);
    // Three length bytes where two are enough.
    expect(() => certificateFields(Buffer.concat([Buffer.from([0x30, 0x83, 0x00]), leaf.der.subarray(2)]))).toThrow(DerError);
    // A long form for a length that fits the short form.
    const nonce = sequence(tlv(0xa1, octets(Buffer.alloc(32, 9))));
    expect(Buffer.from(appAttestNonce(nonce))).toEqual(Buffer.alloc(32, 9));
    expect(() => appAttestNonce(Buffer.concat([Buffer.from([0x30, 0x81, nonce[1]!]), nonce.subarray(2)]))).toThrow(DerError);
  });

  it("reads the nonce only in Apple's shape, SEQUENCE { [1] { OCTET STRING } }", () => {
    const value = Buffer.alloc(32, 9);
    const shapes = [
      sequence(tlv(0xa2, octets(value))),
      sequence(tlv(0xa1, tlv(0x0c, value))),
      sequence(tlv(0xa1, octets(value), octets(value))),
      sequence(tlv(0xa1, tlv(0xa0, octets(value)))),
      sequence(tlv(0xa0, tlv(0xa1, octets(value)))),
      sequence(tlv(0xa1, octets(value)), octets(value)),
      octets(value),
    ];
    for (const shape of shapes) expect(() => appAttestNonce(shape)).toThrow(DerError);
  });

  it("refuses the same extension twice", async () => {
    const root = await issue({ name: "Root", ca: true });
    const twice = await issue({
      name: "Twice",
      issuer: root,
      ca: false,
      extensions: [{ oid: NONCE_OID, value: sequence() }, { oid: NONCE_OID, value: sequence() }],
    });
    expect(() => certificateFields(twice.der)).toThrow(DerError);
  });
});

/**
 * Apple's own sample attestation, read with the same readers. The full
 * verifier rightly refuses it: its credential certificate expired on 23 April
 * 2026 (its intermediate is valid until 13 March 2030), and
 * Apple's guide builds its nonce from the literal challenge, not its SHA-256
 * as App Attest does. So this checks each step the readers take against the
 * values Apple gives, which confirms the nonce's shape against Apple's real
 * encoding.
 */
describe("Apple's sample attestation", () => {
  const APPLE_ROOT_PEM = [
    "-----BEGIN CERTIFICATE-----",
    "MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw",
    "JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK",
    "QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa",
    "Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv",
    "biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y",
    "bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh",
    "NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au",
    "Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/",
    "MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw",
    "CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn",
    "53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV",
    "oyFraWVIyd/dganmrduC1bmTBGwD",
    "-----END CERTIFICATE-----",
  ].join("\n");

  it("decodes, chains to Apple's root, and reads Apple's nonce and key from the credential certificate", async () => {
    const decoded = decodeCbor(Buffer.from(APPLE_SAMPLE.attestation, "base64")) as {
      fmt: string;
      attStmt: { x5c: Uint8Array[]; receipt: Uint8Array };
      authData: Uint8Array;
    };
    expect(decoded.fmt).toBe("apple-appattest");
    expect(decoded.attStmt.x5c).toHaveLength(2);
    expect(decoded.attStmt.receipt).toBeInstanceOf(Uint8Array);
    const [leafDer, intermediateDer] = decoded.attStmt.x5c as [Uint8Array, Uint8Array];
    expect(Buffer.from(leafDer).toString("base64")).toBe(APPLE_SAMPLE.leaf);
    expect(Buffer.from(intermediateDer).toString("base64")).toBe(APPLE_SAMPLE.intermediate);

    // The signatures, not the dates: the sample's credential certificate has expired.
    const root = new X509Certificate(APPLE_ROOT_PEM);
    const leaf = new X509Certificate(leafDer);
    const intermediate = new X509Certificate(intermediateDer);
    expect(leaf.checkIssued(intermediate) && leaf.verify(intermediate.publicKey)).toBe(true);
    expect(intermediate.checkIssued(root) && intermediate.verify(root.publicKey)).toBe(true);
    expect(intermediate.ca).toBe(true);

    const fields = certificateFields(leaf.raw);
    const nonce = appAttestNonce(fields.extensions.get(NONCE_OID)!);
    expect(Buffer.from(nonce).toString("base64")).toBe(APPLE_SAMPLE.nonce);

    const jwk = leaf.publicKey.export({ format: "jwk" });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
    expect(Buffer.from(fields.publicKey)).toEqual(point);
    // The key's hash is the sample's key id, as the verifier checks. (The guide also lists a different
    // "public key SHA256 hash"; it matches neither the key id nor the credential id the guide gives, so it is not used.)
    expect((await digest(fields.publicKey)).toString("base64")).toBe(APPLE_SAMPLE.keyId);
    expect(Buffer.from(decoded.authData.subarray(55, 87)).toString("base64")).toBe(APPLE_SAMPLE.keyId);

    expect(Buffer.from(decoded.authData.subarray(0, 32)).toString("base64")).toBe(APPLE_SAMPLE.appIdHash);
    expect((await digest(Buffer.from(APPLE_SAMPLE.appId))).toString("base64")).toBe(APPLE_SAMPLE.appIdHash);
  });
});
