/**
 * The framer: turns a response body, as its text streams past, into the
 * documents the usage readers read, and the facts about how it ended.
 *
 * - A JSON body is one document, its root object, or, for a root array (a
 *   Gemini stream without SSE), one per object element.
 * - An SSE stream is one document per event: the event's `data:` lines, each
 *   without the field name and one space after it, joined with line breaks,
 *   as SSE does. Comments and other fields are never data. This is the one
 *   SSE parser in the gateway.
 *
 * Every byte is seen once, in order, so the framer always knows where a line
 * and an event start and end: nothing is ever read from the middle of one.
 * Each document's values are kept by the skimmer (`./skim.ts`) at declared
 * paths only, as they arrive, so nothing large is held.
 *
 * A document is whole when its JSON closed, with nothing but space after it.
 * One that was not whole holds only the values that were whole when it
 * stopped. An event's blank line says the event ended, which only the
 * stream-closing check needs.
 */
import { Skimmer, type PathTree } from "./skim.ts";

export interface BodyDocument {
  /** The document's declared values. */
  readonly value: Record<string, unknown>;
  /** Its JSON closed, with nothing but space after it. */
  readonly whole: boolean;
}

/** One SSE event that ended (its blank line came), as the stream-closing check reads it. */
export interface SseFrame {
  readonly event: string | null;
  /** `none`: no data line. `done`: exactly `[DONE]`. `json`: a whole JSON value. `other`: anything else. */
  readonly data: "none" | "done" | "json" | "other";
  /** The data's `type`, when the data is a whole JSON object naming one. */
  readonly type: string | null;
}

export interface FramerListener {
  readonly onDocument: (document: BodyDocument) => void;
  readonly onFrame?: (frame: SseFrame) => void;
}

export interface Framer {
  push(text: string): void;
  /** A value was too large to keep. */
  readonly overflow: boolean;
  /** The body ended: an event or document still open was cut. */
  end(): void;
}

export function isEventStream(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/event-stream");
}

/** The framer for a body of `contentType`, keeping the values `tree` declares. */
export function framer(contentType: string, tree: PathTree, listener: FramerListener): Framer {
  return isEventStream(contentType) ? sseFramer(tree, listener) : jsonFramer(tree, listener);
}

function jsonFramer(tree: PathTree, listener: FramerListener): Framer {
  const skimmer = new Skimmer(tree, { arrayDocuments: true, onDocument: (value) => listener.onDocument({ value, whole: true }) });
  return {
    push: (text) => skimmer.push(text),
    get overflow() {
      return skimmer.overflow;
    },
    end() {
      skimmer.end();
      const open = skimmer.openDocument;
      if (open !== null) listener.onDocument({ value: open, whole: false });
    },
  };
}

/** A field name longer than this is no field the framer reads. */
const MAX_FIELD = 16;
const MAX_EVENT_NAME = 128;
const DONE = "[DONE]";

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

function sseFramer(tree: PathTree, listener: FramerListener): Framer {
  let line: Line = Line.Field;
  let field = "";
  /** A carriage return ended the last piece; it belongs to a line break if a line feed follows. */
  let pendingReturn = false;
  // The event being read.
  let skimmer: Skimmer | null = null;
  let document: Record<string, unknown> | null = null;
  let dataLines = 0;
  let dataLength = 0;
  let dataStart = "";
  let eventName: string | null = null;
  let overflow = false;

  function data(text: string): void {
    if (text === "") return;
    dataLength += text.length;
    if (dataStart.length < DONE.length + 1) dataStart += text.slice(0, DONE.length + 1 - dataStart.length);
    skimmer ??= new Skimmer(tree, { onDocument: (value) => (document = value) });
    skimmer.push(text);
  }

  function reset(): void {
    if ((skimmer as Skimmer | null)?.overflow === true) overflow = true;
    skimmer = null;
    document = null;
    dataLines = 0;
    dataLength = 0;
    dataStart = "";
    eventName = null;
  }

  /** The event ends: `ended` when its blank line came, false when the stream stopped inside it. */
  function dispatch(ended: boolean): void {
    if (dataLines === 0 && eventName === null) return reset();
    const current = skimmer as Skimmer | null;
    current?.end();
    const done = dataLength === DONE.length && dataStart === DONE;
    const json = current !== null && current.complete;
    const value = (document as Record<string, unknown> | null) ?? (current?.openDocument ?? null);
    // The data's JSON closing is what makes it whole: the event's blank line only says the event ended.
    if (value !== null && !done) listener.onDocument({ value, whole: json && document !== null });
    if (ended) {
      const type = json && document !== null && typeof (document as Record<string, unknown>).type === "string" ? ((document as Record<string, unknown>).type as string) : null;
      listener.onFrame?.({ event: eventName, data: dataLines === 0 ? "none" : done ? "done" : json ? "json" : "other", type });
    }
    reset();
  }

  /** A line ended. */
  function lineEnd(): void {
    if (line === Line.Field && field === "") dispatch(true);
    else if (line === Line.Field) {
      // A field with no colon: its name is the whole line, and its value is empty.
      if (field === "data") {
        if (dataLines > 0) data("\n");
        dataLines += 1;
      } else if (field === "event") eventName = "";
    }
    line = Line.Field;
    field = "";
  }

  function push(text: string): void {
    let at = 0;
    if (pendingReturn) {
      pendingReturn = false;
      if (text[0] !== "\n" && line === Line.Data) data("\r");
    }
    while (at < text.length) {
      switch (line) {
        case Line.Field: {
          // The usual line, read without looking at each character.
          if (field === "" && text.startsWith("data:", at)) {
            at += 5;
            if (dataLines > 0) data("\n");
            dataLines += 1;
            line = Line.DataStart;
            break;
          }
          const character = text[at]!;
          if (character === "\n") {
            lineEnd();
            at += 1;
          } else if (character === "\r") {
            if (at + 1 < text.length && text[at + 1] !== "\n") field += character;
            at += 1;
          } else if (character === ":") {
            at += 1;
            if (field === "data") {
              if (dataLines > 0) data("\n");
              dataLines += 1;
              line = Line.DataStart;
            } else if (field === "event") {
              eventName = "";
              line = Line.Event;
            } else line = Line.Skip;
          } else {
            field += character;
            at += 1;
            if (field.length > MAX_FIELD) line = Line.Skip;
          }
          break;
        }
        case Line.DataStart:
          if (text[at] === " ") at += 1;
          line = Line.Data;
          break;
        case Line.Data: {
          const feed = text.indexOf("\n", at);
          if (feed === -1) {
            const ends = text.endsWith("\r");
            data(text.slice(at, ends ? text.length - 1 : text.length));
            pendingReturn = ends;
            at = text.length;
          } else {
            data(text.slice(at, feed > at && text[feed - 1] === "\r" ? feed - 1 : feed));
            at = feed;
            lineEnd();
            at += 1;
          }
          break;
        }
        case Line.Event: {
          const feed = text.indexOf("\n", at);
          const piece = text.slice(at, feed === -1 ? text.length : feed);
          if (eventName !== null && eventName.length < MAX_EVENT_NAME) eventName = (eventName + piece).slice(0, MAX_EVENT_NAME);
          if (feed === -1) at = text.length;
          else {
            eventName = eventName?.trim() ?? null;
            lineEnd();
            at = feed + 1;
          }
          break;
        }
        case Line.Skip: {
          const feed = text.indexOf("\n", at);
          if (feed === -1) at = text.length;
          else {
            lineEnd();
            at = feed + 1;
          }
          break;
        }
      }
    }
  }

  return {
    push,
    get overflow() {
      return overflow;
    },
    end() {
      if (line === Line.Event && eventName !== null) eventName = eventName.trim();
      dispatch(false);
    },
  };
}
