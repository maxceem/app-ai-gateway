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
 *   in different pieces. This is the gateway's SSE parser for reading usage
 *   as a stream goes by; stored conversations split whole, finished streams
 *   into events with their own small splitter (`../conversations/record.ts`).
 *
 * Every byte is seen once, in order, so the framer always knows where a line
 * and an event start and end: nothing is ever read from the middle of one.
 * Each document's values are kept by the skimmer (`./skim.ts`) at declared
 * paths only, as they arrive, so nothing large is held. Its contract, tested
 * against a parser that reads the whole text at once: for any body, split
 * into pieces anywhere, it gives the same documents, frames and facts.
 *
 * A document is whole when its root object closed, with nothing but space
 * after it, every bracket matching its kind. A closing frame, and whether the
 * answer ended whole, also need its data to be valid JSON.
 * One that was not whole holds only the values that were whole when it
 * stopped. How the body ended is reported as facts (`cut`, `overflow`,
 * `stopped`), for the reader to judge the whole reading by.
 *
 * What the framer holds after a `push()` returns (a line's field name, an
 * event's name, the data it keeps to check, its last frame's data) goes
 * through `keep` (`./keep.ts`) at the end of the push: nothing it holds
 * shares memory with a piece of the body, and nothing it dropped is copied.
 * A listener that holds a frame past a push calls its `settle`.
 */
import { keep } from "./keep.ts";
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
  /** `none`: no data line. `done`: `[DONE]`. `json`: valid JSON. `other`: anything else. */
  readonly data: "none" | "done" | "json" | "other";
  /** The data's `type`, when the data is a valid JSON object naming one. */
  readonly type: string | null;
  /** Whether the data is `[DONE]`, told without judging the data. The framer's frames always say. */
  readonly isDone?: boolean;
  /**
   * Keeps what the frame holds past the push it came in (`keep`). Whoever
   * holds a frame when a push returns calls it; a frame dropped before then
   * is never copied.
   */
  settle?(): void;
}

export interface FramerListener {
  readonly onDocument: (document: BodyDocument) => void;
  readonly onFrame?: (frame: SseFrame) => void;
}

export interface FramerOptions {
  /**
   * The most events read: an SSE stream's, or a JSON array's elements, each
   * counted as it starts, before any of it is read. Past it the framer stops.
   */
  readonly maxEvents?: number;
}

export interface Framer {
  push(text: string): void;
  /** The body ended. */
  end(): void;
  /** A declared value was too large to keep: the reading lacks it. */
  readonly overflow: boolean;
  /**
   * The answer did not end whole: the JSON body did not close, or an SSE
   * event with data was cut or not valid JSON. `[DONE]` never clears it.
   */
  readonly cut: boolean;
  /** More events came than `maxEvents`: the framer stopped reading, and nothing after was read. */
  readonly stopped: boolean;
  /**
   * The body is not JSON the framer can read any further (a binary answer,
   * say): nothing more pushed is read, so there is no need to decode it.
   */
  readonly failed: boolean;
}

export function isEventStream(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/event-stream");
}

/** The framer for a body of `contentType`, keeping the values `tree` declares. */
export function framer(contentType: string, tree: PathTree, listener: FramerListener, options: FramerOptions = {}): Framer {
  const maxEvents = options.maxEvents ?? Number.POSITIVE_INFINITY;
  return isEventStream(contentType) ? new SseFramer(tree, listener, maxEvents) : jsonFramer(tree, listener, maxEvents);
}

function jsonFramer(tree: PathTree, listener: FramerListener, maxEvents: number): Framer {
  let events = 0;
  let stopped = false;
  let cut = false;
  const skimmer = new Skimmer(tree, {
    arrayDocuments: true,
    onElement() {
      events += 1;
      if (events > maxEvents) stopped = true;
      return !stopped;
    },
    onDocument: (value) => listener.onDocument({ value, whole: true }),
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
      if (open !== null) listener.onDocument({ value: open, whole: false });
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
    get failed() {
      return !stopped && skimmer.failed;
    },
  };
}

/** A field name longer than this is no field the framer reads. */
export const MAX_FIELD = 16;
export const MAX_EVENT_NAME = 128;
const DONE = "[DONE]";
/** The data an event keeps whole, to check that a small one, a closing event say, is valid JSON. */
const MAX_CHECKED_DATA = 64 * 1024;
const LINE_BREAK = /[\r\n]/gu;

/** Where the framer is inside the current line. */
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

/** The event being read: open once a `data:` or `event:` line starts it. */
interface OpenEvent {
  skimmer: Skimmer | null;
  /** The data's root object, once it closed. */
  document: Record<string, unknown> | null;
  dataLines: number;
  dataLength: number;
  /** The data, kept while it is small, to check it is valid JSON. */
  checked: string[] | null;
  /** How many of `checked` are already kept (`keep`); the rest came in this push. */
  settled: number;
  /** The value of its `event:` line, so far. */
  name: string | null;
}

/**
 * The SSE framer, one explicit state machine:
 *
 * - `line` and `field`: where the framer is in the current line;
 * - `afterReturn`: the last piece ended with a carriage return, so a line feed
 *   starting the next is part of the same break;
 * - `event`: the event being read, or null between events;
 * - the facts, and the count of events.
 *
 * Text is cut into line pieces at line breaks; each piece moves the line
 * state, and each break ends a line, which may end an event.
 */
class SseFramer implements Framer {
  private line: Line = Line.Field;
  private field = "";
  private afterReturn = false;
  private event: OpenEvent | null = null;
  private events = 0;
  overflow = false;
  stopped = false;
  /** An SSE stream is read line by line to its end: it never stops being readable. */
  readonly failed = false;
  /** The last event with data (not a whole `[DONE]`), and whether it ended. */
  private last: { readonly ended: boolean; readonly frame: EventEnd } | null = null;

  get cut(): boolean {
    return this.last !== null && !(this.last.ended && this.last.frame.json());
  }

  private readonly tree: PathTree;
  private readonly listener: FramerListener;
  private readonly maxEvents: number;

  constructor(tree: PathTree, listener: FramerListener, maxEvents: number) {
    this.tree = tree;
    this.listener = listener;
    this.maxEvents = maxEvents;
  }

  push(text: string): void {
    if (this.stopped || text === "") return;
    this.read(text);
    this.settle();
  }

  /** What the framer holds when this push returns, kept past it; nothing it dropped is copied. */
  private settle(): void {
    const event = this.event;
    if (event?.checked != null) {
      for (let index = event.settled; index < event.checked.length; index += 1) event.checked[index] = keep(event.checked[index]!);
      event.settled = event.checked.length;
    }
    this.last?.frame.settle();
  }

  private read(text: string): void {
    let at = 0;
    if (this.afterReturn) {
      this.afterReturn = false;
      if (text.charCodeAt(0) === 10) at = 1;
    }
    while (at < text.length && !this.stopped) {
      LINE_BREAK.lastIndex = at;
      if (!LINE_BREAK.test(text)) {
        this.piece(at === 0 ? text : text.slice(at));
        return;
      }
      const index = LINE_BREAK.lastIndex - 1;
      if (index > at) this.piece(text.slice(at, index));
      if (this.stopped) return;
      this.lineEnd();
      at = index + 1;
      if (text.charCodeAt(index) === 13) {
        if (at === text.length) this.afterReturn = true;
        else if (text.charCodeAt(at) === 10) at += 1;
      }
    }
  }

  end(): void {
    if (this.stopped) return;
    // A last line with no break after it still counts as a line, but its event never ended.
    if (this.line !== Line.Field || this.field !== "") this.lineEnd();
    if (!this.stopped) this.dispatch(false);
  }

  /** Opens the event a `data:` or `event:` line starts, counting it first. False when that is past the limit. */
  private open(): OpenEvent | null {
    if (this.event !== null) return this.event;
    this.events += 1;
    if (this.events > this.maxEvents) {
      this.stopped = true;
      return null;
    }
    this.event = { skimmer: null, document: null, dataLines: 0, dataLength: 0, checked: [], settled: 0, name: null };
    return this.event;
  }

  /** A `data:` line starts. */
  private startData(): boolean {
    const event = this.open();
    if (event === null) return false;
    if (event.dataLines > 0) this.data("\n");
    event.dataLines += 1;
    return true;
  }

  private data(text: string): void {
    const event = this.event!;
    if (text === "") return;
    event.dataLength += text.length;
    if (event.checked !== null) {
      if (event.dataLength > MAX_CHECKED_DATA) event.checked = null;
      // Kept as a slice while this push lasts; `settle` keeps it past the push.
      else event.checked.push(text);
    }
    event.skimmer ??= new Skimmer(this.tree, { onDocument: (value) => (event.document = value) });
    event.skimmer.push(text);
  }

  /** Part of one line, with no line break in it. */
  private piece(text: string): void {
    let at = 0;
    while (at < text.length && !this.stopped) {
      switch (this.line) {
        case Line.Field: {
          // The usual line, read without looking at each character.
          if (this.field === "" && text.startsWith("data:", at)) {
            at += 5;
            if (this.startData()) this.line = Line.DataStart;
            break;
          }
          const colon = text.indexOf(":", at);
          const end = colon === -1 ? text.length : colon;
          if (this.field.length + end - at > MAX_FIELD) {
            this.line = Line.Skip;
            at = text.length;
            break;
          }
          this.field = keep(this.field + text.slice(at, end));
          if (colon === -1) {
            at = text.length;
            break;
          }
          at = colon + 1;
          if (this.field === "data") {
            if (this.startData()) this.line = Line.DataStart;
          } else if (this.field === "event") {
            const event = this.open();
            if (event !== null) {
              event.name = "";
              this.line = Line.Event;
            }
          } else this.line = Line.Skip;
          break;
        }
        case Line.DataStart:
          if (text.charCodeAt(at) === 32) at += 1;
          this.line = Line.Data;
          break;
        case Line.Data:
          this.data(text.slice(at));
          at = text.length;
          break;
        case Line.Event: {
          const event = this.event!;
          if (event.name !== null && event.name.length < MAX_EVENT_NAME) {
            event.name = keep((event.name + text.slice(at)).slice(0, MAX_EVENT_NAME));
          }
          at = text.length;
          break;
        }
        case Line.Skip:
          at = text.length;
          break;
      }
    }
  }

  /** A line ended. */
  private lineEnd(): void {
    if (this.line === Line.Field) {
      if (this.field === "") this.dispatch(true);
      // A field with no colon: its name is the whole line, and its value is empty.
      else if (this.field === "data") this.startData();
      else if (this.field === "event") {
        const event = this.open();
        if (event !== null) event.name = "";
      }
    } else if (this.line === Line.Event && this.event?.name != null) {
      this.event.name = keep(this.event.name.trim());
    }
    this.line = Line.Field;
    this.field = "";
  }

  /** The event ends: `ended` when its blank line came, false when the stream stopped inside it. */
  private dispatch(ended: boolean): void {
    const event = this.event;
    if (event === null) return;
    this.event = null;
    const skimmer = event.skimmer;
    skimmer?.end();
    if (skimmer?.overflow === true) this.overflow = true;
    const text = event.checked === null ? null : event.checked.join("");
    // `[DONE]` is read as before: space before it on any line does not matter.
    const done = text !== null && text.endsWith(DONE) && text.split("\n").map((part) => part.trimStart()).join("\n") === DONE;
    const structural = skimmer !== null && skimmer.complete;
    const frame = new EventEnd(event.name, event.dataLines, done, structural, text, event.document);
    const value = event.document ?? skimmer?.openDocument ?? null;
    // An event with data says whether the answer ended whole. A whole `[DONE]` says nothing about
    // the events before it; one the stream stopped inside (no blank line after it) was cut.
    if (event.dataLines > 0 && (!done || !ended)) this.last = { ended, frame };
    // A document is whole when its root object closed with nothing but space after it.
    if (value !== null && !done) this.listener.onDocument({ value, whole: event.document !== null && structural });
    if (ended) this.listener.onFrame?.(frame);
  }
}

/**
 * How an event ended, as the stream-closing check reads it. Whether its data
 * is valid JSON is judged only when asked, once: a small event is parsed
 * whole, a large one judged by its structure. Parsing every event would cost
 * more than reading it, and only the last one is ever asked.
 */
class EventEnd implements SseFrame {
  readonly event: string | null;
  readonly isDone: boolean;
  private readonly lines: number;
  private readonly done: boolean;
  private readonly structural: boolean;
  private text: string | null;
  private readonly document: Record<string, unknown> | null;
  private verdict: boolean | undefined;

  constructor(event: string | null, lines: number, done: boolean, structural: boolean, text: string | null, document: Record<string, unknown> | null) {
    this.event = event;
    this.lines = lines;
    this.done = done;
    this.isDone = done;
    this.structural = structural;
    this.text = text;
    this.document = document;
  }

  private settled = false;

  /** Keeps the data past the push it came in, while it may still be asked. Once. */
  settle(): void {
    if (this.settled) return;
    this.settled = true;
    if (this.text !== null) this.text = keep(this.text);
  }

  json(): boolean {
    if (this.verdict === undefined) {
      this.verdict = this.structural && (this.text === null || isJson(this.text));
      this.text = null;
    }
    return this.verdict;
  }

  get data(): SseFrame["data"] {
    return this.lines === 0 ? "none" : this.done ? "done" : this.json() ? "json" : "other";
  }

  get type(): string | null {
    const named = this.document?.type;
    return this.json() && typeof named === "string" ? named : null;
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
