/**
 * Paths: normalizing what a client sent, and matching it against templates.
 *
 * Normalizing refuses anything that could reach a different path upstream
 * than the one the gateway checked: `.` and `..` segments, encoded slashes
 * and backslashes, control characters and broken percent-encoding, raw or
 * encoded. Repeated slashes and a trailing slash are dropped. The upstream
 * path is always rebuilt from the checked segments, never copied from the
 * request.
 *
 * Template rules are in `./operation.ts`.
 */

export type NormalizedPath =
  | { readonly ok: true; readonly segments: readonly string[] }
  | { readonly ok: false; readonly reason: PathRefusal };

export type PathRefusal =
  | "bad_encoding"
  | "dot_segment"
  | "encoded_separator"
  | "control_character";

/** Splits and decodes a path such as `v1/audio/%E2%9C%93`. A leading `/` is optional. */
export function normalizePath(raw: string): NormalizedPath {
  const segments: string[] = [];
  for (const piece of raw.split("/")) {
    if (piece === "") continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(piece);
    } catch {
      return { ok: false, reason: "bad_encoding" };
    }
    if (decoded === "." || decoded === "..") return { ok: false, reason: "dot_segment" };
    if (decoded.includes("/") || decoded.includes("\\")) return { ok: false, reason: "encoded_separator" };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(decoded)) return { ok: false, reason: "control_character" };
    segments.push(decoded);
  }
  return { ok: true, segments };
}

/**
 * Encodes one decoded segment for an upstream URL. Characters a path segment
 * may hold as they are (RFC 3986 `pchar`) stay, so `models/gemini:generate`
 * keeps its colon. Everything else is percent-encoded.
 */
export function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%(21|24|26|27|28|29|2A|2B|2C|3B|3D|3A|40)/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** Joins decoded segments into an upstream path, with a leading `/`. */
export function joinSegments(segments: readonly string[]): string {
  return "/" + segments.map(encodeSegment).join("/");
}

// ---------------------------------------------------------------------------
// Templates

/** One segment of a parsed template. */
export type TemplateSegment =
  | { readonly kind: "literal"; readonly value: string }
  /** `{name}`, with an optional literal before and after it in the same segment. */
  | { readonly kind: "part"; readonly name: string; readonly prefix: string; readonly suffix: string }
  /** `{name...}`: one or more whole segments, from a closed list. */
  | { readonly kind: "multi"; readonly name: string }
  /** `*` at the end of a refused-path pattern: the rest of the path, if any. */
  | { readonly kind: "rest" };

export interface Template {
  readonly source: string;
  readonly segments: readonly TemplateSegment[];
}

export class TemplateError extends Error {
  constructor(template: string, problem: string) {
    super(`Path template "${template}": ${problem}`);
    this.name = "TemplateError";
  }
}

export interface ParseOptions {
  /** Allow `{name...}`. Off for paths a customer lists: a part there never spans a `/`. */
  readonly multi?: boolean;
  /** Allow a trailing `*`. Only refused-path patterns use it. */
  readonly rest?: boolean;
}

const PART = /^([^{}]*)\{([A-Za-z_][A-Za-z0-9_]*)(\.\.\.)?\}([^{}]*)$/;

/**
 * Parses a template and checks all its rules: the ones `defineOperation`
 * checks at compile time, plus the ones only a parser can see.
 */
export function parseTemplate(source: string, options: ParseOptions = {}): Template {
  const trimmed = source.startsWith("/") ? source.slice(1) : source;
  if (trimmed === "") throw new TemplateError(source, "is empty");
  const pieces = trimmed.split("/");
  const names = new Set<string>();
  const segments: TemplateSegment[] = [];
  pieces.forEach((piece, index) => {
    if (piece === "") throw new TemplateError(source, "has an empty segment");
    if (piece === "." || piece === "..") throw new TemplateError(source, "has a dot segment");
    if (piece === "*") {
      if (!options.rest) throw new TemplateError(source, "may not use *");
      if (index !== pieces.length - 1) throw new TemplateError(source, "may use * only as the last segment");
      segments.push({ kind: "rest" });
      return;
    }
    if (!piece.includes("{") && !piece.includes("}")) {
      segments.push({ kind: "literal", value: piece });
      return;
    }
    const found = PART.exec(piece);
    if (found === null) throw new TemplateError(source, `segment "${piece}" must have exactly one {name} part`);
    const [, prefix = "", name = "", dots, suffix = ""] = found;
    if (names.has(name)) throw new TemplateError(source, `uses {${name}} twice`);
    names.add(name);
    if (dots !== undefined) {
      if (!options.multi) throw new TemplateError(source, `may not use {${name}...}`);
      if (prefix !== "" || suffix !== "") throw new TemplateError(source, `{${name}...} must be a whole segment`);
      if (segments.some((segment) => segment.kind === "multi")) {
        throw new TemplateError(source, "can have only one {name...} part");
      }
      segments.push({ kind: "multi", name });
      return;
    }
    segments.push({ kind: "part", name, prefix, suffix });
  });
  return { source, segments };
}

/**
 * Values for `{name...}` parts. A value outside its list never matches.
 * `any` matches every value: its list is judged after routing, as the priced
 * models are (`resolveCall`, `../pricing/billability.ts`).
 */
export type ClosedLists = Readonly<Record<string, ReadonlySet<string> | "any">>;

export interface MatchOptions {
  readonly closedLists?: ClosedLists;
  /** Compare literals ignoring case. Used for refused paths, so case tricks cannot get around them. */
  readonly ignoreCase?: boolean;
}

/** The part values of a match, decoded. A `{name...}` value holds its `/`s. */
export type Parts = Readonly<Record<string, string>>;

/** Matches decoded segments against a template. Returns the parts, or null. */
export function matchTemplate(
  template: Template,
  segments: readonly string[],
  options: MatchOptions = {},
): Parts | null {
  const parts: Record<string, string> = {};
  const same = options.ignoreCase
    ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string) => a === b;

  const one = (pattern: TemplateSegment, value: string): boolean => {
    switch (pattern.kind) {
      case "literal":
        return same(pattern.value, value);
      case "part": {
        const { prefix, suffix } = pattern;
        if (value.length <= prefix.length + suffix.length) return false;
        if (!same(value.slice(0, prefix.length), prefix)) return false;
        if (!same(value.slice(value.length - suffix.length), suffix)) return false;
        parts[pattern.name] = value.slice(prefix.length, value.length - suffix.length);
        return true;
      }
      default:
        return false;
    }
  };

  const pattern = template.segments;
  const last = pattern[pattern.length - 1];
  if (last?.kind === "rest") {
    const fixed = pattern.slice(0, -1);
    if (segments.length < fixed.length) return null;
    return fixed.every((segment, index) => one(segment, segments[index]!)) ? parts : null;
  }

  const multiAt = pattern.findIndex((segment) => segment.kind === "multi");
  if (multiAt === -1) {
    if (segments.length !== pattern.length) return null;
    return pattern.every((segment, index) => one(segment, segments[index]!)) ? parts : null;
  }

  // One `{name...}` part: the segments before and after it are fixed in number.
  const before = pattern.slice(0, multiAt);
  const after = pattern.slice(multiAt + 1);
  const middle = segments.length - before.length - after.length;
  if (middle < 1) return null;
  if (!before.every((segment, index) => one(segment, segments[index]!))) return null;
  const tail = segments.length - after.length;
  if (!after.every((segment, index) => one(segment, segments[tail + index]!))) return null;
  const multi = pattern[multiAt] as Extract<TemplateSegment, { kind: "multi" }>;
  const value = segments.slice(before.length, tail).join("/");
  const list = options.closedLists?.[multi.name];
  if (list === undefined || (list !== "any" && !list.has(value))) return null;
  parts[multi.name] = value;
  return parts;
}

/**
 * Builds an upstream path from a template and the parts of a match. A
 * `{name...}` value keeps its `/`s; every other character is encoded.
 *
 * Returns null if a segment comes out as `.` or `..`. That can happen when a
 * part loses the prefix or suffix it had in the request (`x..` matched by
 * `x{id}`), and the provider would read it as a dot segment.
 */
export function fillTemplate(template: Template, parts: Parts): string | null {
  const out: string[] = [];
  for (const segment of template.segments) {
    switch (segment.kind) {
      case "literal":
        out.push(segment.value);
        break;
      case "part": {
        const value = parts[segment.name];
        if (value === undefined) throw new TemplateError(template.source, `has no value for {${segment.name}}`);
        out.push(segment.prefix + value + segment.suffix);
        break;
      }
      case "multi": {
        const value = parts[segment.name];
        if (value === undefined) throw new TemplateError(template.source, `has no value for {${segment.name}...}`);
        out.push(...value.split("/"));
        break;
      }
      case "rest":
        throw new TemplateError(template.source, "is a pattern, not an upstream template");
    }
  }
  if (out.some((segment) => segment === "." || segment === "..")) return null;
  return joinSegments(out);
}
