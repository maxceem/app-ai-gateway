/**
 * The App Store's signed `AppTransaction`, read for one fact: which Apple
 * Account the install belongs to.
 *
 * StoreKit gives every Apple Account that has an app its own
 * `appTransactionId`, the same on every device that account uses and after
 * every reinstall, and signs it into a JWS chained to Apple Root CA - G3. An
 * App Attest client sends that JWS with its token exchange, and an application
 * that measures its budget per Apple Account counts the install's spending
 * against the id it names, so deleting and reinstalling the app no longer
 * starts a fresh month.
 *
 * Nothing here can refuse an exchange. A transaction that does not verify —
 * one an Xcode StoreKit configuration signed, one for another app, one that
 * was tampered with — names no account, and the install is counted on its own
 * as it was before Apple Accounts existed. Refusing instead would buy nothing:
 * a client that sent nothing at all is counted the same way.
 *
 * Imported dynamically by the token exchange, like `./app-attest`, so the
 * certificate libraries stay off every other path.
 */

import { Buffer } from "node:buffer";
import { X509Certificate } from "node:crypto";
import * as asn1js from "asn1js";
import { compactVerify, decodeProtectedHeader } from "jose";
import { Certificate } from "pkijs";
import { MAX_APP_TRANSACTION_LENGTH } from "../contracts/schemas";
import { sha256 } from "./app-assertion";

/** Apple Root CA - G3, which the App Store signs every StoreKit JWS under. */
const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

/**
 * The marker extensions Apple puts on the two certificates below its root,
 * which Apple's own App Store Server Library checks: the leaf that signs App
 * Store receipts, and the Worldwide Developer Relations intermediate. A chain
 * to the right root without them is some other Apple certificate — one that
 * signs something that is not a StoreKit transaction.
 */
const RECEIPT_SIGNING_LEAF_OID = "1.2.840.113635.100.6.11.1";
const WWDR_INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";

/**
 * The environments whose transactions Apple signs under its root: the App
 * Store, and the sandbox that TestFlight and development builds use. `Xcode`
 * and `LocalTesting` transactions are signed locally and never verify.
 */
const SIGNED_ENVIRONMENTS = new Set(["Production", "Sandbox"]);

/** How far in the future a transaction's `receiptCreationDate` may be: Apple's clock, judged by ours. */
const SIGNED_DATE_SKEW_MS = 5 * 60_000;

let appleRoot: X509Certificate | undefined;

function appleRootCertificate(): X509Certificate {
  appleRoot ??= new X509Certificate(APPLE_ROOT_CA_G3_PEM);
  return appleRoot;
}

/** Why a transaction named no account: a bounded token for logs, never a value from the JWS. */
export type AppTransactionRejection =
  | "malformed"
  | "chain"
  | "signature"
  | "bundle"
  | "environment"
  | "signed_date"
  | "missing_id";

export type AppTransactionResult =
  | { account: string; environment: string }
  | { account: null; rejection: AppTransactionRejection };

function hasExtension(certificate: X509Certificate, oid: string): boolean {
  const parsed = asn1js.fromBER(Uint8Array.from(certificate.raw).buffer);
  if (parsed.offset === -1) return false;
  return new Certificate({ schema: parsed.result }).extensions?.some((item) => item.extnID === oid) ?? false;
}

function validAt(certificate: X509Certificate, at: number): boolean {
  return at >= Date.parse(certificate.validFrom) && at <= Date.parse(certificate.validTo);
}

/**
 * Whether `x5c` is a leaf and an intermediate that chain to `root`, each valid
 * at `at` and each carrying its marker extension. The chain's own third
 * certificate is never trusted: only the root this module holds is.
 */
function chainVerifies(x5c: unknown, root: X509Certificate, at: number): X509Certificate | null {
  if (!Array.isArray(x5c) || x5c.length !== 3 || !x5c.every((item) => typeof item === "string")) return null;
  let leaf: X509Certificate;
  let intermediate: X509Certificate;
  try {
    leaf = new X509Certificate(Buffer.from(x5c[0] as string, "base64"));
    intermediate = new X509Certificate(Buffer.from(x5c[1] as string, "base64"));
  } catch {
    return null;
  }
  const verified = validAt(leaf, at)
    && validAt(intermediate, at)
    && validAt(root, at)
    && intermediate.ca
    && leaf.checkIssued(intermediate)
    && leaf.verify(intermediate.publicKey)
    && intermediate.checkIssued(root)
    && intermediate.verify(root.publicKey)
    && hasExtension(leaf, RECEIPT_SIGNING_LEAF_OID)
    && hasExtension(intermediate, WWDR_INTERMEDIATE_OID);
  return verified ? leaf : null;
}

/**
 * The account key an app transaction names, or why it names none.
 *
 * The key is a hash rather than Apple's id itself: it only ever has to be
 * compared, and a stable identifier for a person is better not stored where a
 * hash does the same job. The application and the environment are hashed in,
 * so neither two applications nor a sandbox and the App Store can ever share
 * a ledger, whatever ids Apple hands out.
 *
 * Certificates are judged at the transaction's `receiptCreationDate`, as Apple's own
 * library does for a transaction it reads offline. StoreKit caches an
 * AppTransaction on the device, and one signed under a leaf that has since
 * expired still says who bought the app. Revocation is not checked: that
 * needs a network call to Apple, and the worst a revoked-but-genuine signing
 * key could do here is assign some install's spending to the wrong account.
 */
export async function verifyAppTransaction(input: {
  jws: string;
  appId: string;
  bundleId: string;
  now?: number;
  /** For tests, which cannot get Apple to sign anything. */
  root?: X509Certificate;
}): Promise<AppTransactionResult> {
  const now = input.now ?? Date.now();
  const reject = (rejection: AppTransactionRejection): AppTransactionResult => ({ account: null, rejection });
  if (input.jws.length > MAX_APP_TRANSACTION_LENGTH) return reject("malformed");

  let header: ReturnType<typeof decodeProtectedHeader>;
  let payload: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(input.jws);
    const segment = input.jws.split(".")[1];
    if (segment === undefined) return reject("malformed");
    const decoded: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return reject("malformed");
    payload = decoded as Record<string, unknown>;
  } catch {
    return reject("malformed");
  }
  if (header.alg !== "ES256") return reject("malformed");

  // Read before anything is verified only to choose the instant the chain is
  // judged at; the signature checked below covers it. Apple's library falls
  // back to the present when the field is absent, and so does this.
  const created = payload.receiptCreationDate;
  if (created !== undefined && (typeof created !== "number" || !Number.isFinite(created))) {
    return reject("signed_date");
  }
  const signedDate = typeof created === "number" ? created : now;
  if (signedDate > now + SIGNED_DATE_SKEW_MS) return reject("signed_date");

  const leaf = chainVerifies(header.x5c, input.root ?? appleRootCertificate(), signedDate);
  if (leaf === null) return reject("chain");
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      Uint8Array.from(leaf.publicKey.export({ type: "spki", format: "der" })),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    await compactVerify(input.jws, key, { algorithms: ["ES256"] });
  } catch {
    return reject("signature");
  }

  if (payload.bundleId !== input.bundleId) return reject("bundle");
  const environment = payload.receiptType;
  if (typeof environment !== "string" || !SIGNED_ENVIRONMENTS.has(environment)) return reject("environment");
  const id = payload.appTransactionId;
  if (typeof id !== "string" || id.length === 0) return reject("missing_id");

  const digest = await sha256(new TextEncoder().encode(JSON.stringify([input.appId, environment, id])));
  return { account: digest.toString("base64url"), environment };
}
