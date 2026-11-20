/**
 * The root fields of a JSON document the gateway kept only part of: the head
 * of a large answer, the tail of one, or one SSE event cut by a window.
 *
 * A small JSON tokenizer (strings with escapes, numbers, literals, `{}[]`,
 * `:` and `,`), used through explicit anchors only, so depth is always known
 * and never guessed:
 *
 * - **Head:** the text starts where the document starts. Root members are read
 *   forwards from its `{`. A field counts only if its whole value is inside
 *   the text: a string closed, an object or array closed, a number or literal
 *   followed by a delimiter inside the text (one cut at the end could be the
 *   start of a longer number).
 * - **Tail:** the text ends where the document ends, at the root's closing
 *   `}`. Only a document or event that really ended is a tail: a cut one has
 *   no known end, so it gives no root fields. Root members are read backwards
 *   from that `}`.
 *
 * Reading stops at the first thing that does not fit, never guessing past it.
 * Each value is returned raw, whatever its type: the caller judges it.
 */

/** The anchored windows of one document. Either may be left out. */
export interface AnchoredText {
  /** Text that starts where the document starts. */
  readonly head?: string;
  /** Text that ends where the document ends. Only for a document that really ended. */
  readonly tail?: string;
}

const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u;
const LITERALS = ["true", "false", "null"] as const;

function isSpace(character: string | undefined): boolean {
  return character === " " || character === "\n" || character === "\r" || character === "\t";
}

/** The index just after the string opening at `at`, or -1 when it does not close in the text. */
function stringEnd(text: string, at: number): number {
  for (let index = at + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") index += 1;
    else if (character === '"') return index + 1;
  }
  return -1;
}

/** The index just after the value starting at `at` (no space before it), or -1 when it is cut or not JSON. */
function valueEnd(text: string, at: number): number {
  const first = text[at];
  if (first === '"') return stringEnd(text, at);
  if (first === "{" || first === "[") {
    let depth = 0;
    for (let index = at; index < text.length; index += 1) {
      const character = text[index];
      if (character === '"') {
        const end = stringEnd(text, index);
        if (end === -1) return -1;
        index = end - 1;
      } else if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return -1;
  }
  const rest = text.slice(at);
  const number = NUMBER.exec(rest);
  const length = number?.[0].length ?? LITERALS.find((literal) => rest.startsWith(literal))?.length;
  if (length === undefined) return -1;
  // A scalar must be followed by a JSON delimiter inside the text: one that
  // runs to the end, or into anything else (`42e`), may be part of a longer one.
  const next = text[at + length];
  return next === "," || next === "}" || next === "]" || isSpace(next) ? at + length : -1;
}

function skipSpace(text: string, at: number): number {
  let index = at;
  while (index < text.length && isSpace(text[index])) index += 1;
  return index;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The fields wanted from one object: a key maps to `true` for its whole value,
 * or to the fields wanted from inside it, when its value is an object.
 */
type Wanted = ReadonlyMap<string, true | Wanted>;

/** What was found in one object: values, and objects of the values found inside them. */
type Found = Map<string, unknown>;

/**
 * Members of the object opening at `open`, read forwards. Reading stops at
 * the first thing that does not fit, after looking inside a wanted object it
 * could not read to its end.
 */
function fromHead(text: string, open: number, wanted: Wanted, found: Found): void {
  if (text[open] !== "{") return;
  let at = skipSpace(text, open + 1);
  if (text[at] === "}") return;
  for (;;) {
    if (text[at] !== '"') return;
    const keyEnd = stringEnd(text, at);
    if (keyEnd === -1) return;
    const key = parsed(text.slice(at, keyEnd));
    at = skipSpace(text, keyEnd);
    if (text[at] !== ":") return;
    const start = skipSpace(text, at + 1);
    const end = valueEnd(text, start);
    const want = typeof key === "string" ? wanted.get(key) : undefined;
    if (want !== undefined && !found.has(key as string)) {
      if (want === true) {
        if (end !== -1) {
          const value = parsed(text.slice(start, end));
          if (value !== undefined) found.set(key as string, value);
        }
      } else if (text[start] === "{") {
        const inside: Found = new Map();
        fromHead(text, start, want, inside);
        if (inside.size > 0) found.set(key as string, inside);
      }
    }
    if (end === -1) return;
    at = skipSpace(text, end);
    if (text[at] === "}") return;
    if (text[at] !== ",") return;
    at = skipSpace(text, at + 1);
  }
}

/**
 * Whether the quote at `at` is escaped, or null when what decides it runs to
 * the text's start: a backslash before the window could escape it, a quote at
 * index 0 included.
 */
function escaped(text: string, at: number): boolean | null {
  let slashes = 0;
  let index = at - 1;
  for (; index >= 0 && text[index] === "\\"; index -= 1) slashes += 1;
  if (index < 0) return null;
  return slashes % 2 === 1;
}

/** The index of the opening quote of the string closing at `close`, or -1 when it opens before the text. */
function stringStartBack(text: string, close: number): number {
  for (let index = close - 1; index >= 0; index -= 1) {
    if (text[index] !== '"') continue;
    const isEscaped = escaped(text, index);
    if (isEscaped === null) return -1;
    if (!isEscaped) return index;
  }
  return -1;
}

/** The index where the value ending at `last` (inclusive) starts, or -1 when it starts before the text. */
function valueStartBack(text: string, last: number): number {
  const final = text[last];
  if (final === '"') return stringStartBack(text, last);
  if (final === "}" || final === "]") {
    let depth = 0;
    for (let index = last; index >= 0; index -= 1) {
      const character = text[index];
      if (character === '"') {
        const isEscaped = escaped(text, index);
        if (isEscaped === null) return -1;
        if (isEscaped) continue;
        const open = stringStartBack(text, index);
        if (open === -1) return -1;
        index = open;
      } else if (character === "}" || character === "]") depth += 1;
      else if (character === "{" || character === "[") {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  }
  // A number or literal: back over its characters, to the delimiter before it.
  let index = last;
  while (index >= 0 && /[-+.0-9a-zA-Z]/u.test(text[index]!)) index -= 1;
  return index < 0 ? -1 : index + 1;
}

function skipSpaceBack(text: string, at: number): number {
  let index = at;
  while (index >= 0 && isSpace(text[index])) index -= 1;
  return index;
}

/**
 * Members of the object closing at `close`, read backwards. A member whose
 * value starts before the text is too large to see whole: when it is an
 * object and one object is wanted from this level, it is taken to be that one
 * (a Responses event's `response`), and read backwards inside, from its end.
 */
function fromTail(text: string, close: number, wanted: Wanted, found: Found): void {
  if (text[close] !== "}") return;
  let at = skipSpaceBack(text, close - 1);
  if (text[at] === "{") return;
  for (;;) {
    if (at < 0) return;
    const start = valueStartBack(text, at);
    if (start === -1) {
      const objects = [...wanted].filter(([key, want]) => want !== true && !found.has(key));
      if (text[at] === "}" && objects.length === 1) {
        const [key, want] = objects[0]!;
        const inside: Found = new Map();
        fromTail(text, at, want as Wanted, inside);
        if (inside.size > 0) found.set(key, inside);
      }
      return;
    }
    const value = text.slice(start, at + 1);
    let colon = skipSpaceBack(text, start - 1);
    if (text[colon] !== ":") return;
    colon = skipSpaceBack(text, colon - 1);
    if (text[colon] !== '"') return;
    const keyStart = stringStartBack(text, colon);
    if (keyStart === -1) return;
    const key = parsed(text.slice(keyStart, colon + 1));
    const want = typeof key === "string" ? wanted.get(key) : undefined;
    if (want !== undefined && !found.has(key as string)) {
      if (want === true) {
        const raw = parsed(value);
        if (raw !== undefined) found.set(key as string, raw);
      } else if (text[at] === "}") {
        const inside: Found = new Map();
        fromTail(text, at, want, inside);
        if (inside.size > 0) found.set(key as string, inside);
      }
    }
    at = skipSpaceBack(text, keyStart - 1);
    if (text[at] === "{") return;
    if (text[at] !== ",") return;
    at = skipSpaceBack(text, at - 1);
  }
}

/** The wanted tree of a list of paths. */
function wantedOf(paths: readonly (readonly string[])[]): Wanted {
  const root = new Map<string, true | Map<string, unknown>>();
  for (const path of paths) {
    let level = root as Map<string, unknown>;
    path.forEach((key, index) => {
      if (index === path.length - 1) {
        if (!level.has(key)) level.set(key, true);
        return;
      }
      let next = level.get(key);
      if (!(next instanceof Map)) {
        next = new Map();
        level.set(key, next);
      }
      level = next as Map<string, unknown>;
    });
  }
  return root as unknown as Wanted;
}

/** Each wanted field from the tail, else from the head, as plain objects. */
function merged(wanted: Wanted, tail: Found | undefined, head: Found | undefined): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, want] of wanted) {
    if (want === true) {
      if (tail?.has(key)) out[key] = tail.get(key);
      else if (head?.has(key)) out[key] = head.get(key);
      continue;
    }
    const inner = merged(want, tail?.get(key) as Found | undefined, head?.get(key) as Found | undefined);
    if (inner !== null) out[key] = inner;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * The fields named by `paths` of a document known by its anchored windows:
 * each found on its own, in the tail, else in the head. A path of one key is
 * a root field; a longer one is a field inside a root object
 * (`["response", "usage"]`). Null when none is whole in either.
 */
export function anchoredRootFields(text: AnchoredText, paths: readonly (readonly string[])[]): Record<string, unknown> | null {
  const wanted = wantedOf(paths);
  const tail: Found = new Map();
  const head: Found = new Map();
  if (text.tail !== undefined) fromTail(text.tail, skipSpaceBack(text.tail, text.tail.length - 1), wanted, tail);
  if (text.head !== undefined) fromHead(text.head, skipSpace(text.head, 0), wanted, head);
  return merged(wanted, tail, head);
}
