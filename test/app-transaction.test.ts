import { Buffer } from "node:buffer";
import { X509Certificate } from "node:crypto";
import * as asn1js from "asn1js";
import { CompactSign } from "jose";
import * as pkijs from "pkijs";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyAppTransaction } from "../src/client-auth/app-transaction";

/**
 * Apple will not sign anything for a test, so these build a stand-in for the
 * App Store's chain at run time — a root, a "WWDR" intermediate and a
 * "receipt signing" leaf, each with the marker extension Apple puts on the
 * real one — and hand the verifier the stand-in root in place of Apple's.
 */
const RECEIPT_SIGNING_LEAF_OID = "1.2.840.113635.100.6.11.1";
const WWDR_INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";
const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const YEAR_MS = 365 * 24 * 60 * 60_000;

// The workers runtime's `crypto` is a full WebCrypto, but its declared type
// is not the DOM one pkijs is typed against.
pkijs.setEngine("test", new pkijs.CryptoEngine({ name: "test", crypto: crypto as never }) as unknown as pkijs.ICryptoEngine);

interface Issued {
  certificate: pkijs.Certificate;
  keys: CryptoKeyPair;
}

let serial = 1;

async function issue(input: {
  name: string;
  issuer?: Issued;
  ca: boolean;
  marker?: string;
  notBefore?: number;
  notAfter?: number;
}): Promise<Issued> {
  const keys = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]) as CryptoKeyPair;
  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ value: serial++ });
  const name = (text: string) => new pkijs.RelativeDistinguishedNames({
    typesAndValues: [new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.Utf8String({ value: text }) })],
  });
  certificate.subject = name(input.name);
  certificate.issuer = input.issuer ? input.issuer.certificate.subject : name(input.name);
  certificate.notBefore.value = new Date(input.notBefore ?? Date.now() - YEAR_MS);
  certificate.notAfter.value = new Date(input.notAfter ?? Date.now() + YEAR_MS);
  certificate.extensions = [
    new pkijs.Extension({
      extnID: "2.5.29.19",
      critical: true,
      extnValue: new pkijs.BasicConstraints({ cA: input.ca }).toSchema().toBER(false),
      parsedValue: new pkijs.BasicConstraints({ cA: input.ca }),
    }),
    ...(input.marker === undefined ? [] : [
      new pkijs.Extension({ extnID: input.marker, critical: false, extnValue: new asn1js.Null().toBER(false) }),
    ]),
  ];
  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
  await certificate.sign((input.issuer ?? { keys }).keys.privateKey, "SHA-256");
  return { certificate, keys };
}

const der = (issued: Issued): Buffer => Buffer.from(issued.certificate.toSchema(true).toBER(false));

interface Chain {
  root: X509Certificate;
  x5c: string[];
  leafKey: CryptoKey;
}

async function chain(options: { leafMarker?: string | null; intermediateMarker?: string | null; leafExpires?: number } = {}): Promise<Chain> {
  const root = await issue({ name: "Test Root CA - G3", ca: true });
  const intermediate = await issue({
    name: "Test WWDR",
    issuer: root,
    ca: true,
    ...(options.intermediateMarker === null ? {} : { marker: options.intermediateMarker ?? WWDR_INTERMEDIATE_OID }),
  });
  const leaf = await issue({
    name: "Test Receipt Signing",
    issuer: intermediate,
    ca: false,
    ...(options.leafMarker === null ? {} : { marker: options.leafMarker ?? RECEIPT_SIGNING_LEAF_OID }),
    ...(options.leafExpires === undefined ? {} : { notAfter: options.leafExpires }),
  });
  return {
    root: new X509Certificate(der(root)),
    x5c: [der(leaf), der(intermediate), der(root)].map((bytes) => bytes.toString("base64")),
    leafKey: leaf.keys.privateKey,
  };
}

async function sign(chainOf: Chain, payload: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "ES256", x5c: chainOf.x5c, ...header })
    .sign(chainOf.leafKey);
}

const BUNDLE = "com.example.app";

function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receiptType: "Production",
    bundleId: BUNDLE,
    appAppleId: 1234567890,
    applicationVersion: "1",
    originalApplicationVersion: "1",
    receiptCreationDate: Date.now() - 60_000,
    originalPurchaseDate: Date.now() - YEAR_MS / 2,
    appTransactionId: "704289572155234567",
    originalPlatform: "iOS",
    ...overrides,
  };
}

describe("an App Store transaction", () => {
  let valid: Chain;

  beforeAll(async () => {
    valid = await chain();
  });

  const verify = (jws: string, root = valid.root, appId = "app-1") =>
    verifyAppTransaction({ jws, appId, bundleId: BUNDLE, root });

  it("names one stable account for an id, whatever device or install sends it", async () => {
    const first = await verify(await sign(valid, transaction()));
    const second = await verify(await sign(valid, transaction({ receiptCreationDate: Date.now() - 5_000 })));
    expect(first).toEqual({ account: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u), environment: "Production" });
    expect(second.account).toBe(first.account);
    // A hash, never Apple's id itself.
    expect(first.account).not.toContain("704289572155234567");
  });

  it("keeps applications, environments and people apart", async () => {
    const base = await verify(await sign(valid, transaction()));
    const otherApp = await verify(await sign(valid, transaction()), valid.root, "app-2");
    const sandbox = await verify(await sign(valid, transaction({ receiptType: "Sandbox" })));
    const otherPerson = await verify(await sign(valid, transaction({ appTransactionId: "704289572155239999" })));
    const accounts = [base, otherApp, sandbox, otherPerson].map((result) => result.account);
    expect(new Set(accounts).size).toBe(4);
    expect(sandbox).toMatchObject({ environment: "Sandbox" });
  });

  it("names nobody for a transaction Apple's root does not vouch for", async () => {
    // Signed by a chain that is not the trusted one: the shape of a
    // transaction an Xcode StoreKit configuration signs.
    const stranger = await chain();
    await expect(verify(await sign(stranger, transaction()))).resolves.toEqual({ account: null, rejection: "chain" });
    // Without the injected root, Apple's own is the only one trusted.
    await expect(verifyAppTransaction({ jws: await sign(valid, transaction()), appId: "app-1", bundleId: BUNDLE }))
      .resolves.toEqual({ account: null, rejection: "chain" });
  });

  it("requires Apple's marker on the leaf and on the intermediate", async () => {
    const unmarkedLeaf = await chain({ leafMarker: null });
    await expect(verify(await sign(unmarkedLeaf, transaction()), unmarkedLeaf.root))
      .resolves.toMatchObject({ rejection: "chain" });
    const unmarkedIntermediate = await chain({ intermediateMarker: null });
    await expect(verify(await sign(unmarkedIntermediate, transaction()), unmarkedIntermediate.root))
      .resolves.toMatchObject({ rejection: "chain" });
    // Each marker on the other certificate is no substitute.
    const swapped = await chain({ leafMarker: WWDR_INTERMEDIATE_OID, intermediateMarker: RECEIPT_SIGNING_LEAF_OID });
    await expect(verify(await sign(swapped, transaction()), swapped.root))
      .resolves.toMatchObject({ rejection: "chain" });
  });

  it("refuses a signature the leaf did not make, and a chain of the wrong length", async () => {
    const jws = await sign(valid, transaction());
    const [header, payload] = jws.split(".");
    const forged = `${header}.${Buffer.from(JSON.stringify(transaction({ appTransactionId: "someone-else" }))).toString("base64url")}.${jws.split(".")[2]}`;
    await expect(verify(forged)).resolves.toEqual({ account: null, rejection: "signature" });
    expect(payload).toBeTruthy();
    await expect(verify(await sign(valid, transaction(), { x5c: valid.x5c.slice(0, 2) })))
      .resolves.toMatchObject({ rejection: "chain" });
  });

  it("refuses another app's transaction, and one from an environment Apple does not sign", async () => {
    await expect(verify(await sign(valid, transaction({ bundleId: "com.example.other" }))))
      .resolves.toEqual({ account: null, rejection: "bundle" });
    for (const receiptType of ["Xcode", "LocalTesting", undefined]) {
      await expect(verify(await sign(valid, transaction({ receiptType }))))
        .resolves.toEqual({ account: null, rejection: "environment" });
    }
  });

  it("refuses a transaction that names no id", async () => {
    await expect(verify(await sign(valid, transaction({ appTransactionId: undefined }))))
      .resolves.toEqual({ account: null, rejection: "missing_id" });
    await expect(verify(await sign(valid, transaction({ appTransactionId: "" }))))
      .resolves.toEqual({ account: null, rejection: "missing_id" });
  });

  it("judges the chain when the transaction was signed, not now", async () => {
    // A leaf that has since expired still vouches for what it signed while valid.
    const expiring = await chain({ leafExpires: Date.now() - 24 * 60 * 60_000 });
    const signedWhileValid = transaction({ receiptCreationDate: Date.now() - 2 * 24 * 60 * 60_000 });
    await expect(verify(await sign(expiring, signedWhileValid), expiring.root))
      .resolves.toMatchObject({ environment: "Production" });
    // And signed after it expired, it vouches for nothing.
    await expect(verify(await sign(expiring, transaction()), expiring.root))
      .resolves.toEqual({ account: null, rejection: "chain" });
  });

  it("refuses a signing date from the future, and one that is not a time", async () => {
    await expect(verify(await sign(valid, transaction({ receiptCreationDate: Date.now() + 60 * 60_000 }))))
      .resolves.toEqual({ account: null, rejection: "signed_date" });
    await expect(verify(await sign(valid, transaction({ receiptCreationDate: "yesterday" }))))
      .resolves.toEqual({ account: null, rejection: "signed_date" });
  });

  it("refuses what is not a JWS at all, without throwing", async () => {
    for (const jws of ["", "not-a-jws", "a.b.c", `${"x".repeat(20_000)}`]) {
      await expect(verify(jws)).resolves.toMatchObject({ account: null });
    }
    const hs256 = `${Buffer.from(JSON.stringify({ alg: "HS256", x5c: valid.x5c })).toString("base64url")}.${Buffer.from("{}").toString("base64url")}.sig`;
    await expect(verify(hs256)).resolves.toEqual({ account: null, rejection: "malformed" });
  });
});
