/**
 * Reading a few text fields of a multipart form without copying it (plan
 * section 4.1, body handling).
 *
 * Parsing a buffered upload with `Request.formData()` copies every byte of
 * it. The gateway needs only a few short text fields, such as `model` and
 * `response_format`, so this scans the bytes it already holds: it decodes
 * each part's headers and the wanted fields' values, and skips every other
 * part, file parts included, without copying them.
 *
 * It reads a form exactly as workerd's own `FormData` parser does
 * (`src/workerd/api/form-data.c++`), which v1 used: the same framing, the
 * same `Content-Disposition` grammar, and the same order rules, so a form
 * means here what it meant in v1. Where workerd would refuse a form, so does
 * this; it is also stricter in a few places (a folded or non-UTF-8 header,
 * a repeated `Content-Disposition`).
 *
 * It is a fast path only. A form it cannot read throws `MultipartError`, and
 * the caller parses it with the platform's parser instead, so a form the
 * platform reads is never refused here.
 */

export class MultipartError extends Error {}

/** A wanted field's value, or `null` where the part is a file or too long to be one. */
export type FieldValue = string | null;

/** The longest wanted value read, in bytes. A model name or a format is far shorter. */
export const MAX_VALUE_BYTES = 1024;

const CR = 13;
const LF = 10;
const DASH = 45;

/** The boundary of a `multipart/form-data` content type, or null. */
export function multipartBoundary(contentType: string): string | null {
  const [type, ...params] = contentType.split(";");
  if (type?.trim().toLowerCase() !== "multipart/form-data") return null;
  for (const param of params) {
    const match = /^\s*boundary\s*=\s*(?:"([^"]{1,70})"|([^\s";]{1,70}))\s*$/iu.exec(param);
    if (match) return match[1] ?? match[2] ?? null;
  }
  return null;
}

/** Where `needle` starts in `bytes` at or after `from`, or -1. */
function find(bytes: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0]!;
  for (let at = bytes.indexOf(first, from); at !== -1 && at + needle.length <= bytes.length; at = bytes.indexOf(first, at + 1)) {
    let index = 1;
    while (index < needle.length && bytes[at + index] === needle[index]) index += 1;
    if (index === needle.length) return at;
  }
  return -1;
}

/** Where a part's headers end (`\r?\n\r?\n`, as workerd's regex): the index after them, or -1. */
function headersEnd(bytes: Uint8Array, from: number): number {
  for (let at = bytes.indexOf(LF, from); at !== -1; at = bytes.indexOf(LF, at + 1)) {
    const next = bytes[at + 1] === CR ? at + 2 : at + 1;
    if (bytes[next] === LF) return next + 1;
  }
  return -1;
}

/** An identifier of workerd's grammar: letters, digits, `_` and `-`. Whitespace is ASCII only, as kj's. */
const IDENTIFIER = /^[A-Za-z0-9_-]+/u;

/**
 * A `Content-Disposition` value read with workerd's grammar: whitespace, an
 * identifier, whitespace, then any number of `; key = "value"` parameters,
 * each value quoted and not empty, where `\c` stands for `c` and a line feed
 * may not appear. Parsing stops at the first parameter that does not fit,
 * and the rest is ignored, as in workerd: `filename*=UTF-8''a` ends the
 * parameters, and so does `filename=""`.
 */
function disposition(value: string): { type: string; params: [key: string, value: string][] } | null {
  let at = 0;
  const space = () => {
    while (at < value.length && /[ \t\r\n\v\f]/u.test(value[at]!)) at += 1;
  };
  space();
  const type = IDENTIFIER.exec(value.slice(at))?.[0];
  if (type === undefined) return null;
  at += type.length;
  space();
  const params: [string, string][] = [];
  for (;;) {
    let cursor = at;
    const param = (() => {
      if (value[cursor] !== ";") return null;
      cursor += 1;
      while (cursor < value.length && /[ \t\r\n\v\f]/u.test(value[cursor]!)) cursor += 1;
      const key = IDENTIFIER.exec(value.slice(cursor))?.[0];
      if (key === undefined) return null;
      cursor += key.length;
      while (cursor < value.length && /[ \t\r\n\v\f]/u.test(value[cursor]!)) cursor += 1;
      if (value[cursor] !== "=") return null;
      cursor += 1;
      while (cursor < value.length && /[ \t\r\n\v\f]/u.test(value[cursor]!)) cursor += 1;
      if (value[cursor] !== '"') return null;
      cursor += 1;
      let found = "";
      for (;;) {
        const character = value[cursor];
        if (character === undefined || character === "\n") return null;
        if (character === '"') break;
        if (character === "\\") {
          const escaped = value[cursor + 1];
          if (escaped === undefined || escaped === "\n") return null;
          found += escaped;
          cursor += 2;
          continue;
        }
        found += character;
        cursor += 1;
      }
      if (found === "") return null;
      cursor += 1;
      while (cursor < value.length && /[ \t\r\n\v\f]/u.test(value[cursor]!)) cursor += 1;
      return [key, found] as [string, string];
    })();
    if (param === null) return { type, params };
    params.push(param);
    at = cursor;
  }
}

/**
 * A part's field name and whether it is a file, by workerd's rules: the type
 * is exactly `form-data`; the last `name` and the last `filename` among the
 * parameters read count, keys compared exactly; a part with a `filename` is a
 * file; one with no `name` is refused.
 */
function partName(headers: string): { name: string; file: boolean } {
  const lines = headers.split(/\r?\n/u).filter((line) => line !== "");
  if (lines.some((line) => /^\s/u.test(line) || !line.includes(":"))) throw new MultipartError("A part's headers cannot be read");
  const found = lines.filter((line) => /^content-disposition\s*:/iu.test(line));
  if (found.length !== 1) throw new MultipartError("A part needs exactly one Content-Disposition");
  const parsed = disposition(found[0]!.slice(found[0]!.indexOf(":") + 1));
  if (parsed === null || parsed.type !== "form-data") throw new MultipartError("A part is not form-data");
  let name: string | null = null;
  let file = false;
  for (const [key, value] of parsed.params) {
    if (key === "name") name = value;
    else if (key === "filename") file = true;
  }
  if (name === null) throw new MultipartError("A part has no name");
  return { name, file };
}

/**
 * The values of the `wanted` fields of a multipart form, every occurrence of
 * each, in order. Throws `MultipartError` when the form cannot be read.
 *
 * Framing as workerd's: the first boundary is `--boundary` anywhere; every
 * later one is `\n--boundary`, and a part's body drops one `\r` before it. A
 * boundary is followed by a line end, or by `--` where the form ends.
 */
export function scanMultipart(bytes: Uint8Array, boundary: string, wanted: ReadonlySet<string>): Map<string, FieldValue[]> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const delimiter = encoder.encode(`\n--${boundary}`);
  const values = new Map<string, FieldValue[]>();
  let at = find(bytes, delimiter.subarray(1), 0);
  if (at === -1) throw new MultipartError("The form has no boundary");
  at += delimiter.length - 1;
  for (;;) {
    if (bytes[at] === LF) at += 1;
    else if (bytes[at] === CR && bytes[at + 1] === LF) at += 2;
    else if (bytes[at] === DASH && bytes[at + 1] === DASH) return values;
    else throw new MultipartError("A boundary is not followed by a line end");
    const end = headersEnd(bytes, at);
    if (end === -1 || end - at > 8192) throw new MultipartError("A part's headers cannot be read");
    const { name, file } = partName(decoder.decode(bytes.subarray(at, end)));
    const next = find(bytes, delimiter, end);
    if (next === -1) throw new MultipartError("The form does not close");
    if (wanted.has(name)) {
      const stop = next > end && bytes[next - 1] === CR ? next - 1 : next;
      // A view, never a copy, and decoded only when short enough to be a name.
      const value = file || stop - end > MAX_VALUE_BYTES ? null : decoder.decode(bytes.subarray(end, stop));
      const list = values.get(name);
      if (list === undefined) values.set(name, [value]);
      else list.push(value);
    }
    at = next + delimiter.length;
  }
}
