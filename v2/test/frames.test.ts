/**
 * The framer's contract (`src/usage/frames.ts`): for any body, cut into
 * pieces anywhere (empty pieces, single bytes, inside a CRLF, inside a
 * multi-byte character), it gives what a parser reading the whole text at
 * once gives: the same documents, the same closing frames, the same facts.
 */
import { describe, expect, it } from "vitest";
import { framer, MAX_EVENT_NAME, MAX_FIELD, type BodyDocument, type SseFrame } from "../src/usage/frames.ts";
import { pick, Skimmer, type PathTree } from "../src/usage/skim.ts";

const TREE: PathTree = { usage: true, type: true, model: true, usageMetadata: true };

interface Reading {
  readonly documents: BodyDocument[];
  readonly frames: SseFrame[];
  readonly cut: boolean;
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
  return { documents, frames, cut: reader.cut, stopped: reader.stopped };
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Whether the skimmer reads `data`'s root as closed with nothing after it. */
function structurallyWhole(data: string): boolean {
  const skimmer = new Skimmer(TREE);
  skimmer.push(data);
  skimmer.end();
  return skimmer.complete;
}

/** One event's data as the reference reads it: whole, at once. */
function eventData(data: string, ended: boolean, dataLines: number, name: string | null, out: { documents: BodyDocument[]; frames: SseFrame[]; cut: boolean }): void {
  const done = data.split("\n").map((part) => part.trimStart()).join("\n") === "[DONE]";
  const json = dataLines > 0 && isJson(data);
  let document: Record<string, unknown> | null = null;
  let open: Record<string, unknown> | null = null;
  if (json) document = pick(JSON.parse(data), TREE);
  else if (dataLines > 0 && data !== "") {
    // Not JSON: what of its root object was whole, as the skimmer keeps it (tested on its own).
    const skimmer = new Skimmer(TREE, { onDocument: (value) => (document = value) });
    skimmer.push(data);
    skimmer.end();
    open = skimmer.openDocument;
  }
  const value = document ?? open;
  // Whole: the root object closed, with nothing after it (the skimmer's own contract covers valid JSON).
  const whole = document !== null && (json || structurallyWhole(data));
  if (dataLines > 0 && !done) out.cut = !(ended && json);
  if (value !== null && !done) out.documents.push({ value, whole });
  if (ended) {
    const named = (document as Record<string, unknown> | null)?.type;
    out.frames.push({ event: name, data: dataLines === 0 ? "none" : done ? "done" : json ? "json" : "other", type: json && typeof named === "string" ? named : null });
  }
}

/** The reference SSE parser: the whole text at once, as the SSE standard reads it. */
function referenceSse(text: string, maxEvents = Number.POSITIVE_INFINITY): Reading {
  const out = { documents: [] as BodyDocument[], frames: [] as SseFrame[], cut: false };
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

/** The reference for a whole JSON body: its root object, or a root array's object elements, each one event. */
function referenceJson(text: string, maxEvents = Number.POSITIVE_INFINITY): Reading {
  const value = JSON.parse(text) as unknown;
  const elements = Array.isArray(value) ? value : [value];
  const documents: BodyDocument[] = [];
  for (let index = 0; index < elements.length; index += 1) {
    if (index + 1 > maxEvents) return { documents, frames: [], cut: false, stopped: true };
    const kept = pick(elements[index], TREE);
    if (kept !== null) documents.push({ value: kept, whole: true });
  }
  return { documents, frames: [], cut: false, stopped: false };
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
  "42",
  '"just text"',
  '{"usage":{"prompt_tokens":9},"cut":"nev',
  '{"type":"message_stop","x":tru}',
  "not json at all",
  "",
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
      else lines.push(`data: ${JSON.stringify({ usage: { prompt_tokens: Math.floor(next() * 100) } })}`);
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

/** `bytes` cut into pieces: empty ones, single bytes, and random sizes, so splits fall inside CRLFs and characters. */
function pieces(bytes: Uint8Array, next: () => number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.length) {
    const roll = next();
    const size = roll < 0.15 ? 0 : roll < 0.5 ? 1 : 1 + Math.floor(next() * 9);
    out.push(bytes.subarray(at, at + size));
    at += size;
  }
  if (next() < 0.5) out.push(new Uint8Array(0));
  return out;
}

describe("the SSE framer gives what reading the whole text at once gives", () => {
  it("on random streams, cut into random pieces", () => {
    const next = random(20261120);
    for (let round = 0; round < 200; round += 1) {
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
    expect(stream("text/event-stream", [new TextEncoder().encode(body)], 1)).toEqual({ documents: [], frames: [{ event: null, data: "json", type: null }], cut: false, stopped: true });
  });

  it("never lets [DONE] clear what an earlier event said about the end (S3)", () => {
    const body = 'data: {"usage":{"prompt_tokens":1},"text":"nev\n\ndata: [DONE]\n\n';
    expect(stream("text/event-stream", [new TextEncoder().encode(body)]).cut).toBe(true);
    expect(referenceSse(body).cut).toBe(true);
  });
});

describe("the JSON framer gives what parsing the whole body gives", () => {
  const ELEMENTS = ["1", '"x"', "null", JSON.stringify({ usageMetadata: { promptTokenCount: 4 } }), JSON.stringify({ model: "ü", usage: { a: 1 } }), "[1,[2]]", "{}"];

  it("on random root arrays and objects, cut into random pieces, with any event budget", () => {
    const next = random(42);
    for (let round = 0; round < 300; round += 1) {
      const count = Math.floor(next() * 5);
      const items = Array.from({ length: count }, () => ELEMENTS[Math.floor(next() * ELEMENTS.length)]!);
      const text = next() < 0.8 ? `[${items.join(next() < 0.5 ? "," : " ,\r\n ")}]` : (items.find((item) => item.startsWith("{")) ?? "{}");
      const bytes = new TextEncoder().encode(text);
      const maxEvents = next() < 0.4 ? Math.floor(next() * 4) : undefined;
      const want = referenceJson(text, maxEvents);
      for (let trial = 0; trial < 6; trial += 1) expect(stream("application/json", pieces(bytes, next), maxEvents), text).toEqual(want);
    }
  });

  it("counts every element, scalars included, before reading it (S2)", () => {
    const body = '[1,2,{"usageMetadata":{"promptTokenCount":9}}]';
    expect(stream("application/json", [new TextEncoder().encode(body)], 1)).toEqual({ documents: [], frames: [], cut: false, stopped: true });
    expect(stream("application/json", [new TextEncoder().encode(body)], 3).documents).toEqual([{ value: { usageMetadata: { promptTokenCount: 9 } }, whole: true }]);
  });
});
