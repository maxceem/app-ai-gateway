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
 * It is strict, because the provider parses the same bytes: a form it cannot
 * read exactly is refused rather than guessed at.
 */

export class MultipartError extends Error {}

/** A wanted field's value, or `null` where the part is a file or too long to be one. */
export type FieldValue = string | null;

/** The longest wanted value read, in bytes. A model name or a format is far shorter. */
const MAX_VALUE_BYTES = 1024;

const CR = 13;
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

/** A part's field name and whether it is a file, from its headers. */
function partName(headers: string): { name: string; file: boolean } {
  const line = headers.split("\r\n").find((header) => /^content-disposition\s*:/iu.test(header));
  if (line === undefined) throw new MultipartError("A part has no Content-Disposition");
  const params = line.slice(line.indexOf(":") + 1).split(";").map((param) => param.trim());
  if (params[0]?.toLowerCase() !== "form-data") throw new MultipartError("A part is not form-data");
  let name: string | null = null;
  let file = false;
  for (const param of params.slice(1)) {
    const match = /^([A-Za-z*]+)\s*=\s*(?:"([^"]*)"|([^\s";]*))$/u.exec(param);
    if (!match) throw new MultipartError("A part's Content-Disposition cannot be read");
    const key = match[1]!.toLowerCase();
    // An encoded name could name a field differently to another parser.
    if (key === "name*") throw new MultipartError("A part names itself in an encoded form");
    if (key === "name") {
      if (name !== null) throw new MultipartError("A part names itself twice");
      name = match[2] ?? match[3] ?? "";
    }
    if (key === "filename" || key === "filename*") file = true;
  }
  if (name === null) throw new MultipartError("A part has no name");
  return { name, file };
}

/**
 * The values of the `wanted` fields of a multipart form, every occurrence of
 * each, in order. Throws `MultipartError` when the form cannot be read.
 */
export function scanMultipart(bytes: Uint8Array, boundary: string, wanted: ReadonlySet<string>): Map<string, FieldValue[]> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  const values = new Map<string, FieldValue[]>();
  // The first delimiter may open the body without the CRLF before it.
  const opening = encoder.encode(`--${boundary}`);
  let at = opening.every((byte, index) => bytes[index] === byte) ? 0 : find(bytes, delimiter, 0);
  if (at === -1) throw new MultipartError("The form has no boundary");
  at += at === 0 && bytes[0] === DASH ? opening.length : delimiter.length;
  for (;;) {
    if (bytes[at] === DASH && bytes[at + 1] === DASH) return values;
    if (bytes[at] !== CR || bytes[at + 1] !== 10) throw new MultipartError("A boundary is not followed by a line end");
    const headersStart = at + 2;
    const headersEnd = find(bytes, encoder.encode("\r\n\r\n"), headersStart);
    if (headersEnd === -1 || headersEnd - headersStart > 8192) throw new MultipartError("A part's headers cannot be read");
    const { name, file } = partName(decoder.decode(bytes.subarray(headersStart, headersEnd)));
    const bodyStart = headersEnd + 4;
    const next = find(bytes, delimiter, bodyStart);
    if (next === -1) throw new MultipartError("The form does not close");
    if (wanted.has(name)) {
      const length = next - bodyStart;
      // A view, never a copy, and decoded only when short enough to be a name.
      const value = file || length > MAX_VALUE_BYTES ? null : decoder.decode(bytes.subarray(bodyStart, next));
      values.set(name, [...(values.get(name) ?? []), value]);
    }
    at = next + delimiter.length;
  }
}
