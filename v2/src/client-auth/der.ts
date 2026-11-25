/**
 * A small DER reader for the two facts App Attest and App Transaction need
 * from a certificate that `node:crypto`'s `X509Certificate` has already
 * parsed and verified: its public key's bytes, and its extensions by OID.
 *
 * It replaces `pkijs` and `asn1js`, so no npm package shares memory with the
 * code that checks a device's proof. It reads only DER, the one encoding a
 * certificate may use: definite lengths, no trailing bytes, and nothing it
 * does not need. Anything else throws `DerError`, and callers refuse.
 */

export class DerError extends Error {}

export interface Tlv {
  tag: number;
  /** Where the value starts and ends, in the bytes it was read from. */
  start: number;
  end: number;
}

const SEQUENCE = 0x30;
const BOOLEAN = 0x01;
const OCTET_STRING = 0x04;
const BIT_STRING = 0x03;
const OBJECT_IDENTIFIER = 0x06;

/** Reads one element at `offset`, which must end at or before `limit`. */
export function readTlv(bytes: Uint8Array, offset: number, limit = bytes.byteLength): Tlv {
  if (offset + 2 > limit) throw new DerError("truncated");
  const tag = bytes[offset]!;
  // Multi-byte tags never appear in what is read here.
  if ((tag & 0x1f) === 0x1f) throw new DerError("long tag");
  let length = bytes[offset + 1]!;
  let start = offset + 2;
  if (length === 0x80) throw new DerError("indefinite length");
  if (length > 0x80) {
    const size = length & 0x7f;
    if (size > 3 || start + size > limit) throw new DerError("length");
    length = 0;
    for (let index = 0; index < size; index += 1) length = length * 256 + bytes[start + index]!;
    // DER uses the shortest form.
    if (length < 0x80 || bytes[start] === 0) throw new DerError("length not minimal");
    start += size;
  }
  const end = start + length;
  if (end > limit) throw new DerError("truncated");
  return { tag, start, end };
}

/** The elements inside a constructed one, which must fill it exactly. */
export function children(bytes: Uint8Array, parent: Tlv): Tlv[] {
  const items: Tlv[] = [];
  let offset = parent.start;
  while (offset < parent.end) {
    const item = readTlv(bytes, offset, parent.end);
    items.push(item);
    offset = item.end;
  }
  return items;
}

function expectTag(item: Tlv | undefined, tag: number): Tlv {
  if (item === undefined || item.tag !== tag) throw new DerError("unexpected element");
  return item;
}

/** One whole element: `bytes` must hold exactly it. */
export function readWhole(bytes: Uint8Array, tag: number): Tlv {
  const item = expectTag(readTlv(bytes, 0), tag);
  if (item.end !== bytes.byteLength) throw new DerError("trailing bytes");
  return item;
}

function oid(bytes: Uint8Array, item: Tlv): string {
  if (item.end === item.start) throw new DerError("empty OID");
  const parts: number[] = [];
  let value = 0;
  for (let index = item.start; index < item.end; index += 1) {
    const byte = bytes[index]!;
    if (value === 0 && byte === 0x80) throw new DerError("OID not minimal");
    value = value * 128 + (byte & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER / 128) throw new DerError("OID too large");
    if ((byte & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  if ((bytes[item.end - 1]! & 0x80) !== 0) throw new DerError("truncated OID");
  const first = parts.shift()!;
  const head = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
  return [...head, ...parts].join(".");
}

export interface CertificateFields {
  /** The subject public key, without the bit string's unused-bits byte. */
  publicKey: Uint8Array;
  /** Each extension's value (the inside of its OCTET STRING), by OID. */
  extensions: Map<string, Uint8Array>;
}

/**
 * Reads a certificate's public key and extensions. `X509Certificate` has
 * parsed and verified the same bytes first; this only finds two fields in them.
 */
export function certificateFields(der: Uint8Array): CertificateFields {
  const certificate = readWhole(der, SEQUENCE);
  const [tbs] = children(der, certificate);
  const fields = children(der, expectTag(tbs, SEQUENCE));
  // [0] version is optional; v3 certificates (the only ones with extensions) carry it.
  let index = fields[0]?.tag === 0xa0 ? 1 : 0;
  // serialNumber, signature, issuer, validity, subject.
  index += 5;
  const spki = children(der, expectTag(fields[index], SEQUENCE));
  const bitString = expectTag(spki[1], BIT_STRING);
  if (bitString.end - bitString.start < 2 || der[bitString.start] !== 0) throw new DerError("bit string");
  const publicKey = new Uint8Array(der.subarray(bitString.start + 1, bitString.end));
  index += 1;

  const extensions = new Map<string, Uint8Array>();
  for (const field of fields.slice(index)) {
    // [1] issuerUniqueID and [2] subjectUniqueID are skipped; [3] holds the extensions.
    if (field.tag !== 0xa3) continue;
    const [list, extra] = children(der, field);
    if (extra !== undefined) throw new DerError("extensions");
    for (const extension of children(der, expectTag(list, SEQUENCE))) {
      const parts = children(der, expectTag(extension, SEQUENCE));
      const id = oid(der, expectTag(parts[0], OBJECT_IDENTIFIER));
      let next = 1;
      if (parts[next]?.tag === BOOLEAN) next += 1;
      const value = expectTag(parts[next], OCTET_STRING);
      if (parts.length !== next + 1) throw new DerError("extension");
      if (extensions.has(id)) throw new DerError("duplicate extension");
      extensions.set(id, new Uint8Array(der.subarray(value.start, value.end)));
    }
  }
  return { publicKey, extensions };
}

/**
 * The nonce in App Attest's extension (1.2.840.113635.100.8.2), whose value
 * is `SEQUENCE { [1] EXPLICIT OCTET STRING }`, as Apple documents it.
 */
export function appAttestNonce(value: Uint8Array): Uint8Array {
  const sequence = readWhole(value, SEQUENCE);
  const [tagged, extra] = children(value, sequence);
  if (extra !== undefined) throw new DerError("nonce extension");
  const [nonce, more] = children(value, expectTag(tagged, 0xa1));
  if (more !== undefined) throw new DerError("nonce extension");
  const octets = expectTag(nonce, OCTET_STRING);
  return new Uint8Array(value.subarray(octets.start, octets.end));
}
