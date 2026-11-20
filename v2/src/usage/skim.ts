/**
 * The JSON skimmer: reads a JSON text as it streams past, in pieces of any
 * size, and keeps only the values found at declared paths.
 *
 * It tracks exact depth and key path from the first byte, so a value is never
 * taken for one at another depth, and a value counts only once it is whole:
 * a string closed, an object or array closed, a number or literal followed by
 * a delimiter. Everything else is skipped without being kept or decoded:
 * native searches jump over strings (`indexOf`) and over containers nobody
 * asked for (a regular expression for the next quote or bracket), so a long
 * base64 image or number array is not walked in JavaScript character by
 * character.
 *
 * What it keeps, for a document `doc` and a path tree `tree` (the tests hold
 * a reference written apart from it, `test/skim-reference.ts`):
 *
 * - a leaf (`true`) keeps the member's whole value, decoded with `JSON.parse`
 *   once it closes, up to `SKIM_VALUE_CAP` characters of its JSON text as
 *   written; a larger one is left out and `overflow` is set;
 * - an inner tree keeps the member as an object holding only its declared
 *   members, when the member is an object; when it is an array, it keeps a
 *   list of its object elements that have at least one declared member, each
 *   with only those (other elements are left out), so a value inside a list
 *   of objects, such as Deepgram's `results.channels[].detected_language`,
 *   can be declared. One list holds at most `MAX_LIST_ELEMENTS` elements and
 *   `SKIM_VALUE_CAP` characters of kept leaves, counted as they are kept,
 *   nested lists' too: past either, the list is left out, nothing more of it
 *   is kept, and `overflow` is set;
 * - a tree whose members are all `"max"` keeps, for an array, one object
 *   instead of a list: for each member, the largest number any element has
 *   there (Deepgram's last utterance `end`). It holds the same however long
 *   the array is, and never overflows: a value past `SKIM_VALUE_CAP`, or one
 *   that is not a number, is skipped for that aggregate only, and an
 *   aggregate no element gave a number stays empty. Elsewhere `"max"` is a
 *   leaf;
 * - a key named twice keeps its last value, as `JSON.parse` does.
 *
 * A root object is one document. With `arrayDocuments`, a root array's
 * object elements are documents too (Gemini's JSON-array stream). Any other
 * root holds no document.
 *
 * What it holds after a `push()` returns, part of a value or of a key, goes
 * through `keep` (`./keep.ts`), and every value it keeps is built by
 * `JSON.parse`: nothing it holds shares memory with a piece of the body.
 */
import { keep } from "./keep.ts";

/**
 * Declared paths: `true` keeps a member's whole value; a tree keeps an object
 * member's declared members, or each object element's of an array member;
 * `"max"` keeps the largest number across an array's elements.
 */
export type PathTree = { readonly [key: string]: PathTree | true | "max" };

/** Whether a tree keeps only the largest numbers across an array (`"max"`), not its elements. */
function aggregates(tree: PathTree): boolean {
  const values = Object.values(tree);
  return values.length > 0 && values.every((value) => value === "max");
}

/** The largest value kept, in characters of JSON text. A usage report is a few hundred. */
export const SKIM_VALUE_CAP = 64 * 1024;

/**
 * The deepest nesting skipped inside one value. JSON this deep is no answer a
 * provider sends; past it the skimmer fails, so a runaway body of brackets
 * can never grow its memory.
 */
export const MAX_SKIP_DEPTH = 1024;

/** The most elements one kept list holds (`SKIM_VALUE_CAP` caps its kept leaves' text). */
export const MAX_LIST_ELEMENTS = 8192;

/** A key longer than this, in characters of JSON text, cannot be a declared one. */
const MAX_KEY = 256;

type Holder = Record<string, unknown>;

/** A tree's keys by length, so a key in the text is matched without being copied out. */
type Compiled = ReadonlyMap<number, readonly (readonly [string, PathTree | true | "max"])[]>;
const COMPILED = new WeakMap<PathTree, Compiled>();

function compiled(tree: PathTree): Compiled {
  let found = COMPILED.get(tree);
  if (found === undefined) {
    const byLength = new Map<number, (readonly [string, PathTree | true | "max"])[]>();
    for (const [key, value] of Object.entries(tree)) {
      const list = byLength.get(key.length) ?? [];
      list.push([key, value]);
      byLength.set(key.length, list);
    }
    found = byLength;
    COMPILED.set(tree, found);
  }
  return found;
}

/** What happens to the value about to start. */
const Target = {
  Skip: 0,
  /** Kept whole, at `targetHolder[targetKey]`. */
  Leaf: 1,
  /** Kept as an object of its declared members (`targetTree`), when it is an object. */
  Inner: 2,
  /** A root array's element: a document when it is an object. */
  Document: 3,
  /** The root value. */
  Root: 4,
  /** An element of a kept array: kept with the array's tree when it is an object. */
  Element: 5,
} as const;
type Target = (typeof Target)[keyof typeof Target];

interface Frame {
  /** An object kept with its declared members, or null for an array (a root array of documents, or a kept array). */
  readonly tree: PathTree | null;
  readonly keys: Compiled | null;
  readonly value: Holder | null;
  /** A document's own object. */
  readonly document: boolean;
  /** A kept array: its object elements, as they are kept, and what they hold. */
  readonly list?: KeptList;
  /** An element of a kept array: the list it is in, so an element with nothing declared is taken out again. */
  readonly inList?: KeptList;
}

/** A kept array while it is read: its elements, what they hold so far, and where it is kept. */
interface KeptList {
  readonly elements: unknown[];
  /** For a tree of `"max"` members: the largest number of each, kept instead of the elements. */
  readonly aggregate: Holder | null;
  readonly tree: PathTree;
  readonly holder: Holder;
  readonly key: string;
  bytes: number;
  count: number;
  /** Past its cap: left out, and nothing more of it is kept. */
  over: boolean;
}

const Mode = {
  /** Expecting a value, after optional space. */
  Value: 0,
  /** Inside a string that is skipped (or captured). */
  SkipString: 1,
  /** Inside a skipped (or captured) container, between strings. */
  SkipContainer: 2,
  /** Inside a skipped (or captured) number or literal. */
  SkipScalar: 3,
  /** In a tracked object: a key, or `}` right after `{`. */
  KeyOrClose: 4,
  /** In a tracked object: a key, after `,`. */
  Key: 5,
  /** In a tracked object: inside a key's string. */
  KeyString: 6,
  /** In a tracked object: `:` after a key. */
  Colon: 7,
  /** After a value in a tracked object or array: `,` or the closing bracket. */
  CommaOrClose: 8,
  /** In a tracked array: a value, or `]` right after `[`. */
  ValueOrClose: 9,
  /** The root value is whole; only space may follow. */
  Done: 10,
  /** The text is not JSON this skimmer can read; nothing more is taken. */
  Failed: 11,
} as const;
type Mode = (typeof Mode)[keyof typeof Mode];

const STRUCTURE = /["{}[\]]/gu;
const SCALAR_END = /[ \t\r\n,\]}]/gu;

/** The first character at or after `at` that is not JSON space, or -1. */
function nonSpace(text: string, at: number): number {
  for (let index = at; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 32 && code !== 10 && code !== 13 && code !== 9) return index;
  }
  return -1;
}

/** Whether `text` has a backslash between `from` and `to`. Keys are short. */
function hasBackslash(text: string, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) if (text.charCodeAt(index) === 92) return true;
  return false;
}

/** Whether the run of backslashes just before `end`, down to `from`, is odd: the character at `end` is escaped. */
function escapedAt(text: string, from: number, end: number): boolean {
  let count = 0;
  for (let index = end - 1; index >= from && text.charCodeAt(index) === 92; index -= 1) count += 1;
  return count % 2 === 1;
}

export interface SkimOptions {
  /** A root array's object elements are documents. */
  readonly arrayDocuments?: boolean;
  /** Called with each document's object once it closes. */
  readonly onDocument?: (value: Holder) => void;
  /**
   * Called as each root-array element (with `arrayDocuments`), or else the
   * root value, starts, before any of it is read. Returning false stops the
   * skimmer there.
   */
  readonly onElement?: () => boolean;
}

export class Skimmer {
  private readonly tree: PathTree;
  private readonly options: SkimOptions;
  private mode: Mode = Mode.Value;
  private target: Target = Target.Root;
  private targetHolder: Holder | null = null;
  private targetKey = "";
  private targetTree: PathTree | null = null;
  private readonly frames: Frame[] = [];
  /** The closing bracket each open container inside the value being skipped expects, innermost last. */
  private readonly skipClosers: number[] = [];
  /** A backslash ended the last piece inside a string: the next character is escaped. */
  private escapePending = false;
  /** The captured JSON text of a leaf value, in pieces, while one is being read. */
  private capture: string[] | null = null;
  private captureLength = 0;
  private captureOverflow = false;
  /** Where the captured value starts in the piece being read. */
  private captureFrom = 0;
  /** A key read over several pieces, or null. */
  private keyPieces: string[] | null = null;
  private keyLength = 0;
  /** The key being read is too long to be declared. */
  private keyTooLong = false;
  /** The key read last, when the frame's tree declares it, and what it declares. */
  private lastKey = "";
  private lastDeclared: PathTree | true | "max" | undefined = undefined;
  /** The leaf being read is a `"max"` member of an aggregate's element. */
  private leafAggregated = false;
  /** The innermost open document, if one is open. */
  private document: Holder | null = null;
  /** A value was too large to keep. */
  overflow = false;

  constructor(tree: PathTree, options: SkimOptions = {}) {
    this.tree = tree;
    this.options = options;
  }

  /** The root value closed and nothing but space followed it. */
  get complete(): boolean {
    return this.mode === Mode.Done;
  }

  get failed(): boolean {
    return this.mode === Mode.Failed;
  }

  /** The document still open when the text stopped: what of it was whole by then. */
  get openDocument(): Holder | null {
    return this.document;
  }

  push(text: string): void {
    let at = 0;
    while (at < text.length && this.mode !== Mode.Failed) at = this.step(text, at);
    // A leaf value still open at the end of the piece: keep what of it arrived, copied, as it outlives the piece.
    if (this.capture !== null && this.mode !== Mode.Failed) this.keep(text, this.captureFrom, text.length, true);
    this.captureFrom = 0;
  }

  /**
   * The text has ended. A number or literal at the root ends with it; one
   * inside a container was cut, and is not kept.
   */
  end(): void {
    if (this.mode === Mode.SkipScalar && this.frames.length === 0) {
      this.capture = null;
      this.mode = Mode.Done;
    }
  }

  private fail(): number {
    this.mode = Mode.Failed;
    this.capture = null;
    return Number.MAX_SAFE_INTEGER;
  }

  /** Adds text to the captured value. `outlives` copies it: it is kept past the piece it came from. */
  private keep(text: string, from: number, to: number, outlives = false): void {
    if (this.capture === null || to <= from) return;
    this.captureLength += to - from;
    if (this.captureLength > SKIM_VALUE_CAP) {
      this.captureOverflow = true;
      this.capture.length = 0;
      return;
    }
    if (!this.captureOverflow) this.capture.push(outlives ? keep(text.slice(from, to)) : text.slice(from, to));
  }

  /** One step from `at`; returns where to go on. */
  private step(text: string, at: number): number {
    switch (this.mode) {
      case Mode.Value:
        return this.valueStart(text, at);
      case Mode.SkipString:
        return this.skipString(text, at);
      case Mode.SkipContainer:
        return this.skipContainer(text, at);
      case Mode.SkipScalar:
        return this.skipScalar(text, at);
      case Mode.KeyOrClose:
      case Mode.Key:
        return this.keyStart(text, at);
      case Mode.KeyString:
        return this.keyString(text, at);
      case Mode.Colon:
        return this.colon(text, at);
      case Mode.CommaOrClose:
        return this.commaOrClose(text, at);
      case Mode.ValueOrClose:
        return this.arrayValueOrClose(text, at);
      case Mode.Done:
        return nonSpace(text, at) === -1 ? text.length : this.fail();
      case Mode.Failed:
        return text.length;
    }
  }

  private valueStart(text: string, at: number): number {
    const index = nonSpace(text, at);
    if (index === -1) return text.length;
    const character = text.charCodeAt(index);
    const target = this.target;
    // A root-array element, or else the root value, is counted before any of it is read.
    const onElement = this.options.onElement;
    if (
      onElement !== undefined &&
      (target === Target.Document || (target === Target.Root && !(character === 91 && this.options.arrayDocuments === true))) &&
      !onElement()
    ) {
      return this.fail();
    }
    if (character === 123 /* { */ && target !== Target.Skip && target !== Target.Leaf) {
      const value: Holder = {};
      const document = target === Target.Document || target === Target.Root;
      let tree: PathTree;
      if (document) {
        this.document = value;
        tree = this.tree;
      } else if (target === Target.Element) {
        const list = this.frames[this.frames.length - 1]!.list!;
        // An aggregate's element is read, folded in when it closes, and dropped.
        if (list.aggregate === null) list.elements.push(value);
        this.frames.push({ tree: list.tree, keys: compiled(list.tree), value, document, inList: list });
        this.mode = Mode.KeyOrClose;
        return index + 1;
      } else {
        this.targetHolder![this.targetKey] = value;
        tree = this.targetTree!;
      }
      this.frames.push({ tree, keys: compiled(tree), value, document });
      this.mode = Mode.KeyOrClose;
      return index + 1;
    }
    if (character === 91 /* [ */ && target === Target.Inner) {
      const tree = this.targetTree!;
      const aggregate = aggregates(tree) ? {} : null;
      const list: KeptList = { elements: [], aggregate, tree, holder: this.targetHolder!, key: this.targetKey, bytes: 0, count: 0, over: false };
      this.targetHolder![this.targetKey] = aggregate ?? list.elements;
      this.frames.push({ tree: null, keys: null, value: null, document: false, list });
      this.mode = Mode.ValueOrClose;
      return index + 1;
    }
    if (character === 91 /* [ */ && target === Target.Root && this.options.arrayDocuments === true) {
      this.frames.push({ tree: null, keys: null, value: null, document: false });
      this.mode = Mode.ValueOrClose;
      return index + 1;
    }
    // Anything else is skipped, and kept whole for a leaf.
    if (target === Target.Inner) delete this.targetHolder![this.targetKey];
    if (target === Target.Leaf) {
      this.capture = [];
      this.captureLength = 0;
      this.captureOverflow = false;
      this.captureFrom = index;
    }
    if (character === 34 /* " */) {
      this.skipClosers.length = 0;
      this.mode = Mode.SkipString;
      return index + 1;
    }
    if (character === 123 || character === 91) {
      this.skipClosers.length = 0;
      this.skipClosers.push(character === 123 ? 125 : 93);
      this.mode = Mode.SkipContainer;
      return index + 1;
    }
    // A number or literal starts with a digit, a minus sign, or t, f or n: anything else (a binary answer, say) is not JSON.
    if (!((character >= 48 && character <= 57) || character === 45 || character === 116 || character === 102 || character === 110)) return this.fail();
    this.mode = Mode.SkipScalar;
    return index;
  }

  private skipString(text: string, at: number): number {
    let from = at;
    if (this.escapePending) {
      // The character after a backslash that ended the last piece is escaped.
      this.escapePending = false;
      from += 1;
    }
    for (;;) {
      const quote = text.indexOf('"', from);
      if (quote === -1) {
        this.escapePending = escapedAt(text, from, text.length);
        return text.length;
      }
      if (escapedAt(text, from, quote)) {
        from = quote + 1;
        continue;
      }
      if (this.skipClosers.length === 0) return this.valueEnd(text, quote + 1);
      this.mode = Mode.SkipContainer;
      return quote + 1;
    }
  }

  private skipContainer(text: string, at: number): number {
    STRUCTURE.lastIndex = at;
    for (;;) {
      if (!STRUCTURE.test(text)) return text.length;
      const character = text.charCodeAt(STRUCTURE.lastIndex - 1);
      if (character === 34 /* " */) {
        this.mode = Mode.SkipString;
        return STRUCTURE.lastIndex;
      }
      // A container is closed only by its own kind of bracket.
      if (character === 123 || character === 91) {
        if (this.skipClosers.length >= MAX_SKIP_DEPTH) return this.fail();
        this.skipClosers.push(character === 123 ? 125 : 93);
      } else {
        if (this.skipClosers.pop() !== character) return this.fail();
        if (this.skipClosers.length === 0) return this.valueEnd(text, STRUCTURE.lastIndex);
      }
    }
  }

  private skipScalar(text: string, at: number): number {
    SCALAR_END.lastIndex = at;
    if (!SCALAR_END.test(text)) return text.length;
    return this.valueEnd(text, SCALAR_END.lastIndex - 1);
  }

  /** A skipped value ended just before `end`: keeps a leaf, then goes on after the value. */
  private valueEnd(text: string, end: number): number {
    if (this.capture !== null) {
      this.keep(text, this.captureFrom, end);
      const holder = this.targetHolder!;
      if (this.captureOverflow) {
        delete holder[this.targetKey];
        // An aggregate's value too large to be a number is skipped for that aggregate only.
        if (!this.leafAggregated) this.overflow = true;
      } else {
        const raw = this.capture.length === 1 ? this.capture[0]! : this.capture.join("");
        // Parsed, which also gives the value storage of its own.
        try {
          holder[this.targetKey] = JSON.parse(raw) as unknown;
        } catch {
          return this.fail();
        }
        // Counted against every list it is kept in.
        for (const frame of this.frames) {
          const list = frame.list;
          if (list === undefined || list.over || list.aggregate !== null) continue;
          list.bytes += this.captureLength;
          if (list.bytes > SKIM_VALUE_CAP) this.overList(list);
        }
      }
      this.capture = null;
    }
    this.afterValue();
    return end;
  }

  private afterValue(): void {
    this.target = Target.Skip;
    this.mode = this.frames.length === 0 ? Mode.Done : Mode.CommaOrClose;
  }

  private keyStart(text: string, at: number): number {
    const index = nonSpace(text, at);
    if (index === -1) return text.length;
    const character = text.charCodeAt(index);
    if (character === 34 /* " */) {
      const from = index + 1;
      const quote = text.indexOf('"', from);
      // The usual key: whole in this piece, with no escape.
      if (quote !== -1 && !hasBackslash(text, from, quote)) {
        this.declared(text, from, quote);
        this.mode = Mode.Colon;
        return quote + 1;
      }
      this.keyPieces = [];
      this.keyLength = 0;
      this.keyTooLong = false;
      this.mode = Mode.KeyString;
      return from;
    }
    if (character === 125 /* } */ && this.mode === Mode.KeyOrClose) return this.close(index);
    return this.fail();
  }

  private keyString(text: string, at: number): number {
    let from = at;
    if (this.escapePending) {
      this.escapePending = false;
      from += 1;
    }
    for (;;) {
      const quote = text.indexOf('"', from);
      if (quote === -1) {
        this.keyPiece(text, at, text.length);
        this.escapePending = escapedAt(text, from, text.length);
        return text.length;
      }
      if (escapedAt(text, from, quote)) {
        from = quote + 1;
        continue;
      }
      this.keyPiece(text, at, quote);
      const key = this.decodedKey();
      const tree = this.frames[this.frames.length - 1]!.tree!;
      this.lastKey = key ?? "";
      this.lastDeclared = key !== null && Object.hasOwn(tree, key) ? tree[key] : undefined;
      this.mode = Mode.Colon;
      return quote + 1;
    }
  }

  /** Matches the key at `from`..`to` in the text against the frame's declared keys. */
  private declared(text: string, from: number, to: number): void {
    const candidates = this.frames[this.frames.length - 1]!.keys!.get(to - from);
    this.lastDeclared = undefined;
    if (candidates === undefined) return;
    for (const [key, value] of candidates) {
      if (text.startsWith(key, from)) {
        this.lastKey = key;
        this.lastDeclared = value;
        return;
      }
    }
  }

  private keyPiece(text: string, from: number, to: number): void {
    if (this.keyTooLong || to <= from) return;
    this.keyLength += to - from;
    if (this.keyLength > MAX_KEY) {
      this.keyTooLong = true;
      this.keyPieces = null;
    } else this.keyPieces!.push(keep(text.slice(from, to)));
  }

  private decodedKey(): string | null {
    const pieces = this.keyPieces;
    this.keyPieces = null;
    if (this.keyTooLong || pieces === null) return null;
    const raw = pieces.join("");
    if (!raw.includes("\\")) return raw;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return null;
    }
  }

  private colon(text: string, at: number): number {
    const index = nonSpace(text, at);
    if (index === -1) return text.length;
    if (text.charCodeAt(index) !== 58 /* : */) return this.fail();
    const declared = this.lastDeclared;
    if (declared === undefined) this.target = Target.Skip;
    else {
      this.targetHolder = this.frames[this.frames.length - 1]!.value;
      this.targetKey = this.lastKey;
      if (declared === true || declared === "max") {
        this.target = Target.Leaf;
        this.leafAggregated = declared === "max" && this.frames[this.frames.length - 1]!.inList?.aggregate != null;
      }
      else {
        this.target = Target.Inner;
        this.targetTree = declared;
      }
    }
    this.mode = Mode.Value;
    return index + 1;
  }

  private commaOrClose(text: string, at: number): number {
    const index = nonSpace(text, at);
    if (index === -1) return text.length;
    const character = text.charCodeAt(index);
    const frame = this.frames[this.frames.length - 1]!;
    if (character === 44 /* , */) {
      if (frame.tree !== null) this.mode = Mode.Key;
      else {
        this.target = this.elementTarget(frame);
        this.mode = Mode.Value;
      }
      return index + 1;
    }
    if ((character === 125 && frame.tree !== null) || (character === 93 && frame.tree === null)) return this.close(index);
    return this.fail();
  }

  private arrayValueOrClose(text: string, at: number): number {
    const index = nonSpace(text, at);
    if (index === -1) return text.length;
    if (text.charCodeAt(index) === 93 /* ] */) return this.close(index);
    this.target = this.elementTarget(this.frames[this.frames.length - 1]!);
    this.mode = Mode.Value;
    return index;
  }

  /** What the next element of an array frame is: a document, an element of a kept list, or, past a list's cap, skipped. */
  private elementTarget(frame: Frame): Target {
    if (frame.list === undefined) return Target.Document;
    return frame.list.over ? Target.Skip : Target.Element;
  }

  /** A list past its cap: left out of its holder, emptied, and nothing more of it kept. */
  private overList(list: KeptList): void {
    list.over = true;
    list.elements.length = 0;
    if (list.holder[list.key] === list.elements) delete list.holder[list.key];
    this.overflow = true;
  }

  /** Closes the innermost tracked container at `index`. */
  private close(index: number): number {
    const frame = this.frames.pop()!;
    if (frame.document) {
      this.document = null;
      this.options.onDocument?.(frame.value!);
    }
    const list = frame.inList;
    if (list !== undefined && list.aggregate !== null) {
      const aggregate = list.aggregate;
      for (const [key, value] of Object.entries(frame.value!)) {
        if (typeof value === "number" && Number.isFinite(value) && !(typeof aggregate[key] === "number" && aggregate[key] >= value)) aggregate[key] = value;
      }
    } else if (list !== undefined && !list.over) {
      // An element with nothing declared is taken out; one kept counts toward the list's cap.
      if (Object.keys(frame.value!).length === 0) list.elements.pop();
      else if (++list.count > MAX_LIST_ELEMENTS) this.overList(list);
    }
    this.afterValue();
    return index + 1;
  }
}
