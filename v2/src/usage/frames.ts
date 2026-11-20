/**
 * The framer: turns a response body, as its text streams past, into the
 * documents the usage readers read, and the facts about how it ended.
 *
 * - A JSON body is one document, its root object, or, for a root array (a
 *   Gemini stream without SSE), one per object element.
 * - An SSE stream is one document per event: the event's `data:` lines, each
 *   without the field name and one space after it, joined with line breaks,
 *   as SSE does. Comments and other fields are never data. A line ends at a
 *   carriage return, a line feed, or both together, even when the two arrive
 *   in different pieces. This is the one SSE parser in the gateway.
 *
 * Every byte is seen once, in order, so the framer always knows where a line
 * and an event start and end: nothing is ever read from the middle of one.
 * Each document's values are kept by the skimmer (`./skim.ts`) at declared
 * paths only, as they arrive, so nothing large is held.
 *
 * A document is whole when its JSON closed, with nothing but space after it.
 * One that was not whole holds only the values that were whole when it
 * stopped. How the body ended is reported as facts (`cut`, `overflow`,
 * `stopped`), for the reader to judge the whole reading by, never one
 * document at a time.
 */
import { copyString, Skimmer, type PathTree } from "./skim.ts";

export interface BodyDocument {
  /** The document's declared values. */
  readonly value: Record<string, unknown>;
  /** Its JSON closed, with nothing but space after it. */
  readonly whole: boolean;
}

/** One SSE event that ended (its blank line came), as the stream-closing check reads it. */
export interface SseFrame {
  readonly event: string | null;
  /** `none`: no data line. `done`: `[DONE]`. `json`: valid JSON. `other`: anything else. */
  readonly data: "none" | "done" | "json" | "other";
  /** The data's `type`, when the data is a valid JSON object naming one. */
  readonly type: string | null;
}

export interface FramerListener {
  readonly onDocument: (document: BodyDocument) => void;
  readonly onFrame?: (frame: SseFrame) => void;
}

export interface FramerOptions {
  /** The most events (an SSE stream's, or a JSON array's elements) read; past it the framer stops. */
  readonly maxEvents?: number;
}

export interface Framer {
  push(text: string): void;
  /** The body ended. */
  end(): void;
  /** A declared value was too large to keep: the reading lacks it. */
  readonly overflow: boolean;
  /** The body ended inside a document or an event: what it held was not all there. */
  readonly cut: boolean;
  /** More events came than `maxEvents`: the framer stopped reading, and nothing after was read. */
  readonly stopped: boolean;
}

export function isEventStream(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/event-stream");
}

/** The framer for a body of `contentType`, keeping the values `tree` declares. */
export function framer(contentType: string, tree: PathTree, listener: FramerListener, options: FramerOptions = {}): Framer {
  const maxEvents = options.maxEvents ?? Number.POSITIVE_INFINITY;
  return isEventStream(contentType) ? sseFramer(tree, listener, maxEvents) : jsonFramer(tree, listener, maxEvents);
}

function jsonFramer(tree: PathTree, listener: FramerListener, maxEvents: number): Framer {
  let events = 0;
  let stopped = false;
  let cut = false;
  const skimmer = new Skimmer(tree, {
    arrayDocuments: true,
    onDocument(value) {
      if (stopped) return;
      events += 1;
      if (events > maxEvents) stopped = true;
      else listener.onDocument({ value, whole: true });
    },
  });
  return {
    push(text) {
      if (!stopped) skimmer.push(text);
    },
    end() {
      if (stopped) return;
      skimmer.end();
      cut = !skimmer.complete;
      const open = skimmer.openDocument;
      if (open === null) return;
      events += 1;
      if (events > maxEvents) stopped = true;
      else listener.onDocument({ value: open, whole: false });
    },
    get overflow() {
      return skimmer.overflow;
    },
    get cut() {
      return cut;
    },
    get stopped() {
      return stopped;
    },
  };
}

/** A field name longer than this is no field the framer reads. */
const MAX_FIELD = 16;
const MAX_EVENT_NAME = 128;
const DONE = "[DONE]";
/** The data an event keeps whole, to check that a small one, a closing event say, is valid JSON. */
const MAX_CHECKED_DATA = 64 * 1024;
const LINE_BREAK = /[\r\n]/gu;

const Line = {
  /** Reading the field name, from the start of a line. */
  Field: 0,
  /** After `data:`: one space may follow, then the value. */
  DataStart: 1,
  /** Inside a `data:` line's value. */
  Data: 2,
  /** Inside an `event:` line's value. */
  Event: 3,
  /** Inside a comment or a field the framer does not read. */
  Skip: 4,
} as const;
type Line = (typeof Line)[keyof typeof Line];

function sseFramer(tree: PathTree, listener: FramerListener, maxEvents: number): Framer {
  let line: Line = Line.Field;
  let field = "";
  /** The last piece ended with a carriage return: a line feed starting the next one is the same break. */
  let afterReturn = false;
  let events = 0;
  let stopped = false;
  let overflow = false;
  let cut = false;
  // The event being read.
  let skimmer: Skimmer | null = null;
  let document: Record<string, unknown> | null = null;
  let dataLines = 0;
  let dataLength = 0;
  /** The event's data, kept while it is small, to check it is valid JSON. */
  let checked: string[] | null = [];
  let eventName: string | null = null;

  function data(text: string): void {
    if (text === "") return;
    dataLength += text.length;
    if (checked !== null) {
      if (dataLength > MAX_CHECKED_DATA) checked = null;
      else checked.push(copyString(text));
    }
    skimmer ??= new Skimmer(tree, { onDocument: (value) => (document = value) });
    skimmer.push(text);
  }

  function startData(): void {
    if (dataLines > 0) data("\n");
    dataLines += 1;
  }

  function reset(): void {
    if ((skimmer as Skimmer | null)?.overflow === true) overflow = true;
    skimmer = null;
    document = null;
    dataLines = 0;
    dataLength = 0;
    checked = [];
    eventName = null;
  }

  /** The event ends: `ended` when its blank line came, false when the stream stopped inside it. */
  function dispatch(ended: boolean): void {
    if (dataLines === 0 && eventName === null) return reset();
    events += 1;
    if (events > maxEvents) {
      stopped = true;
      return reset();
    }
    const current = skimmer as Skimmer | null;
    current?.end();
    const text = checked === null ? null : checked.join("");
    // `[DONE]` is read as before: space before it on any line does not matter.
    const done = text !== null && text.split("\n").map((part) => part.trimStart()).join("\n") === DONE;
    // Valid JSON: a small event is checked whole; a large one, by its structure.
    const json = current !== null && current.complete && (text === null || isJson(text));
    const value = (document as Record<string, unknown> | null) ?? current?.openDocument ?? null;
    const whole = json && document !== null;
    // Only the last event with data says how the stream ended.
    if (dataLines > 0) cut = !(ended && (done || json));
    if (value !== null && !done) listener.onDocument({ value, whole });
    if (ended) {
      const named = (document as Record<string, unknown> | null)?.type;
      const type = json && typeof named === "string" ? named : null;
      listener.onFrame?.({ event: eventName, data: dataLines === 0 ? "none" : done ? "done" : json ? "json" : "other", type });
    }
    reset();
  }

  /** A line ended. */
  function lineEnd(): void {
    if (line === Line.Field) {
      if (field === "") dispatch(true);
      // A field with no colon: its name is the whole line, and its value is empty.
      else if (field === "data") startData();
      else if (field === "event") eventName = "";
    } else if (line === Line.Event && eventName !== null) eventName = copyString(eventName.trim());
    line = Line.Field;
    field = "";
  }

  /** Part of one line, with no line break in it. */
  function segment(piece: string): void {
    let at = 0;
    while (at < piece.length) {
      switch (line) {
        case Line.Field: {
          // The usual line, read without looking at each character.
          if (field === "" && piece.startsWith("data:", at)) {
            at += 5;
            startData();
            line = Line.DataStart;
            break;
          }
          const colon = piece.indexOf(":", at);
          const end = colon === -1 ? piece.length : colon;
          if (field.length + end - at > MAX_FIELD) {
            line = Line.Skip;
            at = piece.length;
            break;
          }
          field += piece.slice(at, end);
          if (colon === -1) {
            at = piece.length;
            break;
          }
          at = colon + 1;
          if (field === "data") {
            startData();
            line = Line.DataStart;
          } else if (field === "event") {
            eventName = "";
            line = Line.Event;
          } else line = Line.Skip;
          break;
        }
        case Line.DataStart:
          if (piece.charCodeAt(at) === 32) at += 1;
          line = Line.Data;
          break;
        case Line.Data:
          data(piece.slice(at));
          at = piece.length;
          break;
        case Line.Event:
          if (eventName !== null && eventName.length < MAX_EVENT_NAME) eventName = (eventName + piece.slice(at)).slice(0, MAX_EVENT_NAME);
          at = piece.length;
          break;
        case Line.Skip:
          at = piece.length;
          break;
      }
    }
  }

  return {
    push(text) {
      if (stopped) return;
      let at = 0;
      if (afterReturn) {
        afterReturn = false;
        if (text.charCodeAt(0) === 10) at = 1;
      }
      while (at < text.length && !stopped) {
        LINE_BREAK.lastIndex = at;
        if (!LINE_BREAK.test(text)) {
          segment(at === 0 ? text : text.slice(at));
          return;
        }
        const index = LINE_BREAK.lastIndex - 1;
        if (index > at) segment(text.slice(at, index));
        lineEnd();
        at = index + 1;
        if (text.charCodeAt(index) === 13) {
          if (at === text.length) afterReturn = true;
          else if (text.charCodeAt(at) === 10) at += 1;
        }
      }
    },
    end() {
      if (stopped) return;
      if (line === Line.Event && eventName !== null) eventName = eventName.trim();
      dispatch(false);
    },
    get overflow() {
      return overflow;
    },
    get cut() {
      return cut;
    },
    get stopped() {
      return stopped;
    },
  };
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
