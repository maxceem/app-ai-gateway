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
  // A scalar must be followed by something inside the text: one that runs to
  // the end may be the start of a longer one.
  return at + length < text.length ? at + length : -1;
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

/** Root members read forwards from the document's start. */
function fromHead(text: string, keys: ReadonlySet<string>, found: Map<string, unknown>): void {
  let at = skipSpace(text, 0);
  if (text[at] !== "{") return;
  at = skipSpace(text, at + 1);
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
    if (end === -1) return;
    if (typeof key === "string" && keys.has(key) && !found.has(key)) {
      const value = parsed(text.slice(start, end));
      if (value !== undefined) found.set(key, value);
    }
    at = skipSpace(text, end);
    if (text[at] === "}") return;
    if (text[at] !== ",") return;
    at = skipSpace(text, at + 1);
  }
}

/** Whether the quote at `at` is escaped, or null when the backslashes before it run to the text's start. */
function escaped(text: string, at: number): boolean | null {
  let slashes = 0;
  let index = at - 1;
  for (; index >= 0 && text[index] === "\\"; index -= 1) slashes += 1;
  if (index < 0 && slashes > 0) return null;
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

/** Root members read backwards from the document's closing `}`. */
function fromTail(text: string, keys: ReadonlySet<string>, found: Map<string, unknown>): void {
  let at = skipSpaceBack(text, text.length - 1);
  if (text[at] !== "}") return;
  at = skipSpaceBack(text, at - 1);
  if (text[at] === "{") return;
  for (;;) {
    if (at < 0) return;
    const start = valueStartBack(text, at);
    if (start === -1) return;
    const value = text.slice(start, at + 1);
    let colon = skipSpaceBack(text, start - 1);
    if (text[colon] !== ":") return;
    colon = skipSpaceBack(text, colon - 1);
    if (text[colon] !== '"') return;
    const keyStart = stringStartBack(text, colon);
    if (keyStart === -1) return;
    const key = parsed(text.slice(keyStart, colon + 1));
    if (typeof key === "string" && keys.has(key) && !found.has(key)) {
      const raw = parsed(value);
      if (raw !== undefined) found.set(key, raw);
    }
    at = skipSpaceBack(text, keyStart - 1);
    if (text[at] === "{") return;
    if (text[at] !== ",") return;
    at = skipSpaceBack(text, at - 1);
  }
}

/**
 * The root fields named by `keys` of a document known by its anchored windows:
 * each found on its own, in the tail, else in the head. Null when none is
 * whole in either.
 */
export function anchoredRootFields(text: AnchoredText, keys: readonly string[]): Record<string, unknown> | null {
  const wanted = new Set(keys);
  const tail = new Map<string, unknown>();
  const head = new Map<string, unknown>();
  if (text.tail !== undefined) fromTail(text.tail, wanted, tail);
  if (text.head !== undefined) fromHead(text.head, wanted, head);
  const root: Record<string, unknown> = {};
  for (const key of keys) {
    if (tail.has(key)) root[key] = tail.get(key);
    else if (head.has(key)) root[key] = head.get(key);
  }
  return Object.keys(root).length === 0 ? null : root;
}
