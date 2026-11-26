/**
 * Test-only builders for App Attest and App Store proofs: a CBOR encoder for
 * the shapes a device sends, and an X.509 issuer on WebCrypto. Apple will not
 * sign anything for a test, so tests build a stand-in chain and hand the
 * verifier its root.
 */

import { Buffer } from "node:buffer";
import { X509Certificate } from "node:crypto";

// ---------------------------------------------------------------- CBOR

export type CborInput = Uint8Array | string | CborInput[] | { [key: string]: CborInput };

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(length, 1);
  return out;
}

/** Definite-length CBOR for byte strings, text, arrays and text-keyed maps. */
export function encodeCbor(value: CborInput): Buffer {
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.byteLength), value]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.byteLength), bytes]);
  }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeCbor)]);
  const entries = Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, item]) => [encodeCbor(key), encodeCbor(item)])]);
}

// ---------------------------------------------------------------- DER

export function tlv(tag: number, ...content: Uint8Array[]): Buffer {
  const body = Buffer.concat(content);
  const length = body.byteLength;
  const prefix = length < 0x80
    ? Buffer.from([tag, length])
    : length < 0x100
      ? Buffer.from([tag, 0x81, length])
      : Buffer.from([tag, 0x82, length >> 8, length & 0xff]);
  return Buffer.concat([prefix, body]);
}

export const sequence = (...items: Uint8Array[]) => tlv(0x30, ...items);
export const octets = (bytes: Uint8Array) => tlv(0x04, bytes);

export function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [first! * 40 + second!];
  for (const part of rest) {
    const chunk = [part! & 0x7f];
    let value = Math.floor(part! / 128);
    while (value > 0) {
      chunk.unshift((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function integer(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

/** A positive DER INTEGER from big-endian bytes. */
function unsigned(bytes: Uint8Array): Buffer {
  let start = 0;
  while (start < bytes.byteLength - 1 && bytes[start] === 0) start += 1;
  const trimmed = Buffer.from(bytes.subarray(start));
  return tlv(0x02, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function utcTime(at: number): Buffer {
  const date = new Date(at);
  const two = (value: number) => String(value).padStart(2, "0");
  const text = `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}`
    + `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
}

const name = (text: string) => sequence(tlv(0x31, sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(text, "utf8")))));
const ECDSA_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));
const YEAR_MS = 365 * 24 * 60 * 60_000;

export interface Extension {
  oid: string;
  critical?: boolean;
  /** The extension's value: the inside of its OCTET STRING. */
  value: Uint8Array;
}

export interface Issued {
  name: string;
  keys: CryptoKeyPair;
  der: Buffer;
  certificate: X509Certificate;
}

let serial = 1;

/** Issues a certificate for a fresh P-256 key, signed by `issuer` or by itself. */
export async function issue(input: {
  name: string;
  issuer?: Issued;
  ca: boolean;
  extensions?: Extension[];
  notBefore?: number;
  notAfter?: number;
  /** The subject's key pair, when the caller needs it before the certificate exists. */
  keys?: CryptoKeyPair;
  /** Signs with this key instead of the issuer's, keeping the issuer's name: a forgery. */
  forgedBy?: CryptoKeyPair;
}): Promise<Issued> {
  const keys = input.keys ?? await newKeys();
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey) as ArrayBuffer);
  const basicConstraints = sequence(...(input.ca ? [tlv(0x01, Buffer.from([0xff]))] : []));
  const extensions = [
    { oid: "2.5.29.19", critical: true, value: basicConstraints },
    ...(input.extensions ?? []),
  ].map((extension) => sequence(
    oid(extension.oid),
    ...(extension.critical ? [tlv(0x01, Buffer.from([0xff]))] : []),
    octets(extension.value),
  ));
  const tbs = sequence(
    tlv(0xa0, integer(2)),
    integer(serial++),
    ECDSA_SHA256,
    name(input.issuer?.name ?? input.name),
    sequence(utcTime(input.notBefore ?? Date.now() - YEAR_MS), utcTime(input.notAfter ?? Date.now() + YEAR_MS)),
    name(input.name),
    spki,
    tlv(0xa3, sequence(...extensions)),
  );
  const signer = input.forgedBy?.privateKey ?? input.issuer?.keys.privateKey ?? keys.privateKey;
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer, Uint8Array.from(tbs)) as ArrayBuffer);
  const signature = sequence(unsigned(raw.subarray(0, 32)), unsigned(raw.subarray(32)));
  const der = sequence(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), signature));
  let certificate: X509Certificate | undefined;
  return {
    name: input.name,
    keys,
    der,
    // Parsed on first use, so a test can build a certificate X509Certificate would refuse.
    get certificate() {
      certificate ??= new X509Certificate(der);
      return certificate;
    },
  };
}

export async function newKeys(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
}

/** The raw EC point of a P-256 public key: what App Attest's key id hashes. */
export async function rawPublicKey(keys: CryptoKeyPair): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey) as ArrayBuffer);
}
