import { Buffer } from "node:buffer";
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
};

async function attestation(options: Options = {}): Promise<Attestation> {
  const root = await issue({ name: "Test App Attestation Root CA", ca: true });
  const intermediate = await issue({ name: "Test App Attestation CA 1", issuer: root, ca: true });
  const keys = await newKeys();
  const point = await rawPublicKey(keys);
  const keyHash = await digest(point);

  const authData = Buffer.alloc(87 + 77);
  (await digest(Buffer.from(options.appId ?? APP_ID))).copy(authData, 0);
  authData[32] = 0x40;
  authData.writeUInt32BE(options.counter ?? 0, 33);
  (options.aaguid ?? Buffer.from("appattestdevelop")).copy(authData, 37);
  authData.writeUInt16BE(32, 53);
  (options.credentialId ?? keyHash).copy(authData, 55);

  const nonce = await digest(Buffer.concat([authData, await digest(Buffer.from(options.challenge ?? CHALLENGE, "base64"))]));
  const extensionValue = options.nonceExtension
    ? options.nonceExtension(nonce)
    : sequence(tlv(0xa1, octets(nonce)));
  const leaf = await issue({
    name: "Test App Attest credential",
    issuer: intermediate,
    ca: false,
    keys,
    ...(extensionValue === null ? {} : { extensions: [{ oid: NONCE_OID, value: extensionValue }] }),
    ...(options.leafExpired ? { notBefore: Date.now() - 2 * 86_400_000, notAfter: Date.now() - 86_400_000 } : {}),
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
  });

  it("refuses a chain to another root, the certificates swapped, and an expired credential certificate", async () => {
    await expect(verify(await attestation({ otherRoot: true }))).rejects.toMatchObject(refused);
    await expect(verify(await attestation({
      shape: ({ authData, leaf, intermediate }) => ({
        fmt: "apple-appattest", attStmt: { x5c: [intermediate, leaf], receipt: Buffer.from("r") }, authData,
      }),
    }))).rejects.toMatchObject(refused);
    await expect(verify(await attestation({ leafExpired: true }))).rejects.toMatchObject(refused);
  });

  it("refuses another format, a missing receipt, one certificate, and CBOR that is cut short or runs on", async () => {
    const shapes: Array<Options["shape"]> = [
      ({ authData, leaf, intermediate }) => ({ fmt: "packed", attStmt: { x5c: [leaf, intermediate], receipt: Buffer.from("r") }, authData }),
      ({ authData, leaf, intermediate }) => ({ fmt: "apple-appattest", attStmt: { x5c: [leaf, intermediate] }, authData }),
      ({ authData, leaf }) => ({ fmt: "apple-appattest", attStmt: { x5c: [leaf], receipt: Buffer.from("r") }, authData }),
    ];
    for (const shape of shapes) await expect(verify(await attestation({ shape }))).rejects.toMatchObject(refused);
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
      ["containers four deep", [0x81, 0x81, 0x81, 0x81, 0x40]],
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

  it("refuses a certificate cut short, with trailing bytes, or with an indefinite length", () => {
    expect(() => certificateFields(leaf.der.subarray(0, leaf.der.byteLength - 1))).toThrow(DerError);
    expect(() => certificateFields(Buffer.concat([leaf.der, Buffer.from([0])]))).toThrow(DerError);
    expect(() => certificateFields(Buffer.from([0x30, 0x80, 0x00, 0x00]))).toThrow(DerError);
    // A length in more bytes than it needs.
    expect(() => certificateFields(Buffer.from([0x30, 0x81, 0x01, 0x05]))).toThrow(DerError);
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
