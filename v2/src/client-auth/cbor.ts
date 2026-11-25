/**
 * A small CBOR decoder for the two shapes App Attest sends: the attestation
 * object (`{ fmt, attStmt: { x5c: [bytes, bytes], receipt }, authData }`) and
 * the assertion (`{ signature, authenticatorData }`).
 *
 * It replaces `cbor-x`, so no npm package reads a device's proof. It reads
 * only what those shapes use: maps with text keys, arrays, byte strings and
 * text strings, with definite lengths, at most three levels deep, and the
 * whole input consumed. Anything else (integers, tags, floats, indefinite
 * lengths, duplicate keys, trailing bytes) throws `CborError`, and callers
 * refuse.
 */

export class CborError extends Error {}

export type CborValue = Uint8Array | string | CborValue[] | { [key: string]: CborValue };

/** The attestation object nests three deep: the outer map, `attStmt`, `x5c`. */
const MAX_DEPTH = 3;

// `ignoreBOM` keeps a leading U+FEFF, so "\uFEFFapple-appattest" never reads as "apple-appattest".
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decodeCbor(bytes: Uint8Array): CborValue {
  const state = { offset: 0 };
  const value = item(bytes, state, 1);
  if (state.offset !== bytes.byteLength) throw new CborError("trailing bytes");
  return value;
}

function argument(bytes: Uint8Array, state: { offset: number }, info: number): number {
  if (info < 24) return info;
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
  // 8-byte lengths, reserved values and indefinite lengths (31) are refused.
  if (size === 0) throw new CborError("length");
  if (state.offset + size > bytes.byteLength) throw new CborError("truncated");
  let value = 0;
  for (let index = 0; index < size; index += 1) value = value * 256 + bytes[state.offset + index]!;
  state.offset += size;
  return value;
}

function item(bytes: Uint8Array, state: { offset: number }, depth: number): CborValue {
  if (state.offset >= bytes.byteLength) throw new CborError("truncated");
  const initial = bytes[state.offset]!;
  state.offset += 1;
  const major = initial >> 5;
  const length = argument(bytes, state, initial & 0x1f);
  switch (major) {
    case 2:
    case 3: {
      if (state.offset + length > bytes.byteLength) throw new CborError("truncated");
      const content = new Uint8Array(bytes.subarray(state.offset, state.offset + length));
      state.offset += length;
      if (major === 2) return content;
      try {
        return utf8.decode(content);
      } catch {
        throw new CborError("text");
      }
    }
    case 4: {
      if (depth >= MAX_DEPTH + 1) throw new CborError("too deep");
      // Each element takes at least one byte, so a count past what is left is a lie.
      if (length > bytes.byteLength - state.offset) throw new CborError("truncated");
      const items: CborValue[] = [];
      for (let index = 0; index < length; index += 1) items.push(item(bytes, state, depth + 1));
      return items;
    }
    case 5: {
      if (depth >= MAX_DEPTH + 1) throw new CborError("too deep");
      if (length * 2 > bytes.byteLength - state.offset) throw new CborError("truncated");
      const map: { [key: string]: CborValue } = Object.create(null) as { [key: string]: CborValue };
      for (let index = 0; index < length; index += 1) {
        const key = item(bytes, state, depth + 1);
        if (typeof key !== "string") throw new CborError("key");
        if (Object.hasOwn(map, key)) throw new CborError("duplicate key");
        map[key] = item(bytes, state, depth + 1);
      }
      return map;
    }
    default:
      throw new CborError("type");
  }
}
