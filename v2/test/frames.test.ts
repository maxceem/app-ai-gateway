/**
 * The framer's contract (`src/usage/frames.ts`): for any body, cut into
 * pieces anywhere (empty pieces, single bytes, inside a CRLF, inside a
 * multi-byte character), it gives what a parser reading the whole text at
 * once gives: the same documents, the same closing frames, the same facts.
 */
import { describe, expect, it } from "vitest";
import { framer, MAX_EVENT_NAME, MAX_FIELD, type BodyDocument, type SseFrame } from "../src/usage/frames.ts";
import { pick, SKIM_VALUE_CAP, type PathTree } from "../src/usage/skim.ts";

const TREE: PathTree = { usage: true, type: true, model: true, usageMetadata: true };

interface Reading {
  readonly documents: BodyDocument[];
  readonly frames: SseFrame[];
  readonly cut: boolean;
  readonly overflow: boolean;
  readonly stopped: boolean;
}

/** Reads `pieces` of bytes the way the meter does: decoded as a stream, each piece handed on as it comes. */
function stream(contentType: string, pieces: readonly Uint8Array[], maxEvents?: number): Reading {
  const documents: BodyDocument[] = [];
  const frames: SseFrame[] = [];
  const reader = framer(
    contentType,
    TREE,
    { onDocument: (document) => documents.push(document), onFrame: (frame) => frames.push({ event: frame.event, data: frame.data, type: frame.type }) },
    maxEvents === undefined ? {} : { maxEvents },
  );
  const decoder = new TextDecoder();
  for (const piece of pieces) reader.push(decoder.decode(piece, { stream: true }));
  reader.push(decoder.decode());
  reader.end();
  return { documents, frames, cut: reader.cut, overflow: reader.overflow, stopped: reader.stopped };
}

/** Whether `pick` leaves out a declared value of `value` for being larger than the cap. */
function overflowIn(value: unknown, tree: PathTree): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.keys(tree).some((key) => {
    if (!Object.hasOwn(value, key)) return false;
    const declared = tree[key]!;
    const member = (value as Record<string, unknown>)[key];
    return declared === true ? JSON.stringify(member).length > SKIM_VALUE_CAP : overflowIn(member, declared);
  });
}

/**
 * An independent reader of a JSON text that may be cut or not quite JSON, by
 * the skimmer's documented rules, written apart from it: along the declared
 * paths objects are read member by member (a leaf counts once its value is
 * whole, an inner object as soon as it opens); anything else is passed over
 * with only its strings and bracket kinds checked, a number or literal ending
 * at a delimiter; a key named twice keeps its last value.
 */
function prefixRead(text: string): { closed: Record<string, unknown> | null; open: Record<string, unknown> | null; complete: boolean; overflow: boolean } {
  let at = 0;
  let failed = false;
  let overflow = false;
  const space = () => {
    while (at < text.length && " \t\r\n".includes(text[at]!)) at += 1;
  };
  /** Passes over one value; whether it closed inside the text. */
  const skip = (): boolean => {
    const first = text[at];
    if (first === undefined) return false;
    if (first === '"') return skipString();
    if (first === "{" || first === "[") {
      const closers: string[] = [];
      while (at < text.length) {
        const character = text[at]!;
        if (character === '"') {
          if (!skipString()) return false;
          continue;
        }
        at += 1;
        if (character === "{") closers.push("}");
        else if (character === "[") closers.push("]");
        else if (character === "}" || character === "]") {
          if (closers.pop() !== character) {
            failed = true;
            return false;
          }
          if (closers.length === 0) return true;
        }
      }
      return false;
    }
    if ("}],:".includes(first)) {
      failed = true;
      return false;
    }
    while (at < text.length && !" \t\r\n,]}".includes(text[at]!)) at += 1;
    return at < text.length;
  };
  const skipString = (): boolean => {
    at += 1;
    while (at < text.length) {
      if (text[at] === "\\") at += 2;
      else if (text[at] === '"') {
        at += 1;
        return true;
      } else at += 1;
    }
    return false;
  };
  /** Reads an object at `at` along `tree` into `into`; whether it closed. */
  const object = (tree: PathTree, into: Record<string, unknown>): boolean => {
    at += 1;
    let first = true;
    for (;;) {
      space();
      if (at >= text.length) return false;
      if (text[at] === "}" && first) {
        at += 1;
        return true;
      }
      if (text[at] !== '"') {
        failed = true;
        return false;
      }
      const keyStart = at;
      if (!skipString()) return false;
      let key: string | null;
      try {
        key = JSON.parse(text.slice(keyStart, at)) as string;
      } catch {
        key = null;
      }
      space();
      if (at >= text.length) return false;
      if (text[at] !== ":") {
        failed = true;
        return false;
      }
      at += 1;
      space();
      if (at >= text.length) return false;
      const declared = key !== null && Object.hasOwn(tree, key) ? tree[key] : undefined;
      if (declared !== undefined && declared !== true && text[at] === "{") {
        const inner: Record<string, unknown> = {};
        into[key!] = inner;
        if (!object(declared, inner)) return false;
      } else {
        if (declared !== undefined && declared !== true) delete into[key!];
        const valueStart = at;
        if (!skip()) return false;
        if (declared === true) {
          const raw = text.slice(valueStart, at);
          if (raw.length > SKIM_VALUE_CAP) {
            delete into[key!];
            overflow = true;
          } else {
            try {
              into[key!] = JSON.parse(raw) as unknown;
            } catch {
              failed = true;
              return false;
            }
          }
        }
      }
      space();
      if (at >= text.length) return false;
      if (text[at] === ",") {
        at += 1;
        first = false;
        continue;
      }
      if (text[at] === "}") {
        at += 1;
        return true;
      }
      failed = true;
      return false;
    }
  };
  space();
  if (text[at] !== "{") {
    const closedValue = skip();
    space();
    return { closed: null, open: null, complete: closedValue && !failed && at >= text.length, overflow };
  }
  const root: Record<string, unknown> = {};
  const closed = object(TREE, root);
  if (!closed) return { closed: null, open: root, complete: false, overflow };
  space();
  return { closed: root, open: null, complete: !failed && at >= text.length, overflow };
}

/** What a document cut before it closed keeps, by the independent reader. */
function partial(text: string): { value: Record<string, unknown> | null; overflow: boolean } {
  const read = prefixRead(text);
  return { value: read.closed ?? read.open, overflow: read.overflow };
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Whether `data`'s root closed with nothing after it, by the independent reader. */
function structurallyWhole(data: string): boolean {
  return prefixRead(data).complete;
}

/** One event's data as the reference reads it: whole, at once. */
function eventData(
  data: string,
  ended: boolean,
  dataLines: number,
  name: string | null,
  out: { documents: BodyDocument[]; frames: SseFrame[]; cut: boolean; overflow: boolean },
): void {
  // `[DONE]`, with any space before it, in data small enough to be kept.
  const done = data.length <= 64 * 1024 && data.split("\n").map((part) => part.trimStart()).join("\n") === "[DONE]";
  // Valid JSON: a small event parsed whole, a large one judged by its structure.
  const json = dataLines > 0 && (data.length <= 64 * 1024 ? isJson(data) : structurallyWhole(data));
  let document: Record<string, unknown> | null = null;
  let open: Record<string, unknown> | null = null;
  if (isJson(data)) {
    document = pick(JSON.parse(data), TREE);
    if (overflowIn(JSON.parse(data), TREE)) out.overflow = true;
  } else if (dataLines > 0 && data !== "") {
    // Not JSON: what of its root object was whole, by the independent reader.
    const read = prefixRead(data);
    if (read.overflow) out.overflow = true;
    document = read.closed;
    open = read.open;
  }
  const value = document ?? open;
  // Whole: the root object closed, with nothing after it (the skimmer's own contract covers valid JSON).
  const whole = document !== null && (json || structurallyWhole(data));
  // A whole `[DONE]` says nothing about the events before it; one the stream stopped inside was cut.
  if (dataLines > 0 && (!done || !ended)) out.cut = !(ended && json);
  if (value !== null && !done) out.documents.push({ value, whole });
  if (ended) {
    const named = (document as Record<string, unknown> | null)?.type;
    out.frames.push({ event: name, data: dataLines === 0 ? "none" : done ? "done" : json ? "json" : "other", type: json && typeof named === "string" ? named : null });
  }
}

/** The reference SSE parser: the whole text at once, as the SSE standard reads it. */
function referenceSse(text: string, maxEvents = Number.POSITIVE_INFINITY): Reading {
  const out = { documents: [] as BodyDocument[], frames: [] as SseFrame[], cut: false, overflow: false };
  const lines = text.split(/\r\n|\r|\n/u);
  // The text after the last break is a line that never ended; an empty one is no line.
  const last = lines.pop()!;
  if (last !== "") lines.push(last);
  let open = false;
  let data: string[] = [];
  let name: string | null = null;
  let events = 0;
  const start = (): boolean => {
    if (open) return true;
    events += 1;
    if (events > maxEvents) return false;
    open = true;
    data = [];
    name = null;
    return true;
  };
  const dispatch = (ended: boolean) => {
    if (!open) return;
    eventData(data.join("\n"), ended, data.length, name, out);
    open = false;
  };
  for (const line of lines) {
    if (line === "") {
      dispatch(true);
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1);
    if (field.length > MAX_FIELD) continue;
    if (field === "data") {
      if (!start()) return { ...out, stopped: true };
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    } else if (field === "event") {
      if (!start()) return { ...out, stopped: true };
      name = value.slice(0, MAX_EVENT_NAME).trim();
    }
  }
  dispatch(false);
  return { ...out, stopped: false };
}

/**
 * The reference for a JSON body made of `elements` (a root array of them, or
 * one root object), cut after `cut` characters: each element whole before the
 * cut is parsed whole, and the one the cut falls in is what the skimmer keeps
 * of it. Every element counts as an event from its first character.
 */
function referenceJson(elements: readonly string[], array: boolean, separator: string, cut: number, maxEvents = Number.POSITIVE_INFINITY): { text: string; want: Reading } {
  const text = array ? `[${elements.join(separator)}]` : elements[0]!;
  const documents: BodyDocument[] = [];
  let overflow = false;
  let at = array ? 1 : 0;
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    const start = at;
    const end = start + element.length;
    at = end + separator.length;
    if (start >= cut) break;
    if (index + 1 > maxEvents) return { text: text.slice(0, cut), want: { documents, frames: [], cut: false, overflow, stopped: true } };
    if (end <= cut) {
      const kept = pick(JSON.parse(element), TREE);
      if (overflowIn(JSON.parse(element), TREE)) overflow = true;
      if (kept !== null) documents.push({ value: kept, whole: true });
    } else {
      const kept = partial(element.slice(0, cut - start));
      if (kept.overflow) overflow = true;
      if (kept.value !== null) documents.push({ value: kept.value, whole: false });
    }
  }
  return { text: text.slice(0, cut), want: { documents, frames: [], cut: cut < text.length, overflow, stopped: false } };
}

/** A small seeded random source, so a failure can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DATA = [
  JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 1 }, model: "m-é" }),
  JSON.stringify({ type: "message_stop" }),
  JSON.stringify({ type: "response.completed", usage: { input_tokens: 5 }, text: "😀 ünï" }),
  JSON.stringify({ usageMetadata: { promptTokenCount: 2 } }),
  "[DONE]",
  "  [DONE]",
  `${" ".repeat(70)}[DONE]`,
  JSON.stringify({ usage: { pad: "a".repeat(SKIM_VALUE_CAP) }, model: "big" }),
  "42",
  '"just text"',
  '{"usage":{"prompt_tokens":9},"cut":"nev',
  '{"type":"message_stop","x":tru}',
  "not json at all",
  "",
  // Over the 64 KB kept to check: balanced, but not valid JSON.
  `{"usage":{"prompt_tokens":2},"type":"message_stop","pad":"${"a".repeat(70_000)}","x":tru}`,
];

/** A random SSE stream, written with every kind of line break and field. */
function sseText(next: () => number): string {
  const pickOne = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  const lines: string[] = [];
  const events = Math.floor(next() * 6);
  for (let event = 0; event < events; event += 1) {
    const fields = 1 + Math.floor(next() * 3);
    for (let field = 0; field < fields; field += 1) {
      const roll = next();
      if (roll < 0.5) lines.push(`data:${next() < 0.7 ? " " : ""}${pickOne(DATA)}`);
      else if (roll < 0.6) lines.push(`event: ${pickOne(["message_stop", "response.completed", " spaced ", "é"])}`);
      else if (roll < 0.7) lines.push(`: comment ${pickOne(["data: [DONE]", "x"])}`);
      else if (roll < 0.8) lines.push(pickOne(["data", "event", "id: 7", "retry: 10", `${"x".repeat(20)}: long`]));
      else if (roll < 0.9) lines.push(`data: ${JSON.stringify({ usage: { prompt_tokens: Math.floor(next() * 100) } })}`);
      // One JSON object spread over several data lines.
      else lines.push('data: {"usage":', 'data: {"prompt_tokens":7},', 'data:"model":"multi"}');
    }
    lines.push("");
  }
  const breaks = ["\n", "\r", "\r\n"];
  const fixed = pickOne(breaks);
  let text = lines.map((line) => line + (next() < 0.5 ? fixed : pickOne(breaks))).join("");
  // Some streams stop early, anywhere.
  if (next() < 0.3) text = text.slice(0, Math.floor(next() * text.length));
  return text;
}

/**
 * `bytes` cut into pieces: empty ones, single bytes, and random sizes, so
 * splits fall inside CRLFs and characters. A long body gets larger pieces
 * too, so a test stays fast.
 */
function pieces(bytes: Uint8Array, next: () => number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const large = Math.max(9, Math.floor(bytes.length / 30));
  let at = 0;
  while (at < bytes.length) {
    const roll = next();
    const size = roll < 0.15 ? 0 : roll < 0.4 ? 1 : 1 + Math.floor(next() * (roll < 0.7 ? 9 : large));
    out.push(bytes.subarray(at, at + size));
    at += size;
  }
  if (next() < 0.5) out.push(new Uint8Array(0));
  return out;
}

describe("the SSE framer gives what reading the whole text at once gives", () => {
  it("on random streams, cut into random pieces", () => {
    const next = random(20261120);
    for (let round = 0; round < 90; round += 1) {
      const text = sseText(next);
      const bytes = new TextEncoder().encode(text);
      const maxEvents = next() < 0.3 ? Math.floor(next() * 4) : undefined;
      const want = referenceSse(text, maxEvents);
      for (let trial = 0; trial < 6; trial += 1) {
        expect(stream("text/event-stream", pieces(bytes, next), maxEvents), JSON.stringify(text)).toEqual(want);
      }
      // Every two-piece split, byte by byte.
      for (let at = 0; at <= bytes.length; at += Math.max(1, Math.floor(bytes.length / 40))) {
        expect(stream("text/event-stream", [bytes.subarray(0, at), bytes.subarray(at)], maxEvents), `${JSON.stringify(text)} at ${at}`).toEqual(want);
      }
    }
  });

  it("keeps a carriage return pending across an empty piece (S1)", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    const body = 'data: {"usage":{"prompt_tokens":1}}\r\n\r\ndata: [DONE]\r\n\r\n';
    const split = body.indexOf("\r\n") + 1;
    const want = referenceSse(body);
    expect(stream("text/event-stream", [bytes(body.slice(0, split)), new Uint8Array(0), bytes(body.slice(split))])).toEqual(want);
    expect(want.frames).toHaveLength(2);
  });

  it("checks the event budget before any data is read, counting every event (S2)", () => {
    const body = 'data: 1\n\ndata: {"usage":{"prompt_tokens":9}}\n\n';
    expect(stream("text/event-stream", [new TextEncoder().encode(body)], 1)).toEqual({
      documents: [],
      frames: [{ event: null, data: "json", type: null }],
      cut: false,
      overflow: false,
      stopped: true,
    });
  });

  it("reads [DONE] with any space before it (round 3, S10)", () => {
    const body = `data: {"usage":{"prompt_tokens":1}}\n\ndata:${" ".repeat(70)}[DONE]\n\n`;
    expect(stream("text/event-stream", [new TextEncoder().encode(body)]).frames.at(-1)).toEqual({ event: null, data: "done", type: null });
  });

  it("counts a stream that stopped inside [DONE] as cut, but not one after a whole [DONE] (round 3, S11)", () => {
    const encode = (text: string) => [new TextEncoder().encode(text)];
    expect(stream("text/event-stream", encode('data: {"usage":{"prompt_tokens":1}}\n\ndata: [DONE]')).cut).toBe(true);
    expect(stream("text/event-stream", encode('data: {"usage":{"prompt_tokens":1}}\n\ndata: [DONE]\n\n')).cut).toBe(false);
    expect(stream("text/event-stream", encode('data: {"usage":1,"x":"nev\n\ndata: [DONE]\n\n')).cut).toBe(true);
  });

  it("never lets [DONE] clear what an earlier event said about the end (S3)", () => {
    const body = 'data: {"usage":{"prompt_tokens":1},"text":"nev\n\ndata: [DONE]\n\n';
    expect(stream("text/event-stream", [new TextEncoder().encode(body)]).cut).toBe(true);
    expect(referenceSse(body).cut).toBe(true);
  });
});

describe("the JSON framer gives what parsing the whole body gives", () => {
  const ELEMENTS = [
    "1",
    '"x"',
    "null",
    JSON.stringify({ usageMetadata: { promptTokenCount: 4 } }),
    JSON.stringify({ model: "ü", usage: { a: 1 } }),
    "[1,[2]]",
    "{}",
    JSON.stringify({ model: "big", usage: { pad: "a".repeat(SKIM_VALUE_CAP) } }),
  ];

  it("on random root arrays and objects, whole or cut, cut into random pieces, with any event budget", () => {
    const next = random(42);
    let cuts = 0;
    let overflows = 0;
    for (let round = 0; round < 300; round += 1) {
      const count = Math.floor(next() * 5);
      const items = Array.from({ length: count }, () => ELEMENTS[Math.floor(next() * ELEMENTS.length)]!);
      const array = next() < 0.8;
      const elements = array ? items : [items.find((item) => item.startsWith("{")) ?? "{}"];
      const separator = next() < 0.5 ? "," : " ,\r\n ";
      const length = (array ? elements.join(separator).length + 2 : elements[0]!.length);
      const cut = next() < 0.4 ? Math.floor(next() * length) : length;
      const maxEvents = next() < 0.4 ? Math.floor(next() * 4) : undefined;
      const { text, want } = referenceJson(elements, array, separator, cut, maxEvents);
      if (want.cut) cuts += 1;
      if (want.overflow) overflows += 1;
      const bytes = new TextEncoder().encode(text);
      for (let trial = 0; trial < 6; trial += 1) expect(stream("application/json", pieces(bytes, next), maxEvents), text.slice(0, 300)).toEqual(want);
    }
    // Both facts are seen, not just their absence.
    expect(cuts).toBeGreaterThan(20);
    expect(overflows).toBeGreaterThan(5);
  });

  it("counts every element, scalars included, before reading it (S2)", () => {
    const body = '[1,2,{"usageMetadata":{"promptTokenCount":9}}]';
    expect(stream("application/json", [new TextEncoder().encode(body)], 1)).toEqual({ documents: [], frames: [], cut: false, overflow: false, stopped: true });
    expect(stream("application/json", [new TextEncoder().encode(body)], 3).documents).toEqual([{ value: { usageMetadata: { promptTokenCount: 9 } }, whole: true }]);
  });
});
