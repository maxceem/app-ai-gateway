import { Writable } from "node:stream";
import { styleText } from "node:util";

/**
 * The three tones human output is allowed to use, and nothing else.
 *
 * Colour here carries meaning rather than decoration: one bold headline per
 * command, dim for the parts a reader skims past (labels, table headers, the
 * frame around a code block), and an accent only on a word that names a state.
 * Identifiers, names, URLs, dates and numbers stay in the terminal's own
 * colour, because those are the things that get read and copied.
 */
export interface Style {
  /** Whether anything below actually emits escape sequences. */
  readonly enabled: boolean;
  /** The one line that says what the command did. */
  headline(text: string): string;
  /** A key/value label, a table header, a frame: present but not read. */
  dim(text: string): string;
  /** A failure. */
  alert(text: string): string;
  /** Something the reader has to act on, and a handoff that is still waiting. */
  warn(text: string): string;
  /** Colours a word that names a state, and leaves every other word alone. */
  state(value: string): string;
  /** A block of code or configuration, framed and muted as one thing. */
  code(text: string, language: string): string[];
  /** An indented JSON document, with the structure marked and the data plain. */
  json(value: unknown): string;
}

/** Words that mean a state, and what each one means. Nothing else is coloured. */
const STATES = new Map<string, "green" | "yellow" | "red">([
  ["active", "green"],
  ["ready", "green"],
  ["completed", "green"],
  ["yes", "green"],
  ["pending", "yellow"],
  ["failed", "red"],
  ["expired", "red"],
  ["blocked", "red"],
  ["inactive", "red"],
  ["disabled", "red"],
  ["revoked", "red"],
  ["no", "red"],
]);

/**
 * Whether this destination gets colour.
 *
 * `NO_COLOR` and `FORCE_COLOR` are read here rather than left to `styleText`
 * alone, because that module decides once at startup and this CLI is also run
 * in-process by its own tests. Everything else — is it a terminal, does it
 * support enough colours — is `styleText`'s own judgement, asked by giving it
 * the sink the text is about to be written to.
 */
export function colorEnabled(
  sink: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env["NO_COLOR"]) return false;
  // An injected sink is a plain object rather than a stream, so a test sees
  // exactly what a pipe sees: no colour, and output that stays byte-exact.
  // Checked before `FORCE_COLOR` so that a variable in the surrounding shell
  // cannot reach into a sink that is not a terminal at all.
  if (!(sink instanceof Writable)) return false;
  if (env["FORCE_COLOR"] && env["FORCE_COLOR"] !== "0") return true;
  // A pipe or a file is never coloured, whatever terminal is beyond it.
  if (!("isTTY" in sink && sink.isTTY === true)) return false;
  // What is left is a terminal's own capability, which is `styleText`'s
  // judgement to make: it is handed the very sink the text is written to.
  return styleText("dim", "?", { stream: sink, validateStream: true }) !== "?";
}

/** Colour off, for every caller that has not been handed a terminal. */
export const plain: Style = style(false);

/** The style for one destination, decided once for the whole command. */
export const styleFor = (sink: unknown): Style => style(colorEnabled(sink));

export function style(enabled: boolean): Style {
  // Validation already happened in `colorEnabled`: this only paints.
  const paint = (
    format: "bold" | "dim" | "red" | "yellow" | "green",
    text: string,
  ): string => (enabled ? styleText(format, text, { validateStream: false }) : text);
  const self: Style = {
    enabled,
    headline: (text) => paint("bold", text),
    dim: (text) => paint("dim", text),
    alert: (text) => paint("red", text),
    warn: (text) => paint("yellow", text),
    state: (value) => {
      const tone = STATES.get(value.toLowerCase());
      return tone ? paint(tone, value) : value;
    },
    code: (text, language) => {
      const rule = `── ${language} ──`;
      return [
        self.dim(rule),
        ...text.split("\n").map((line) => self.dim(line)),
        self.dim("─".repeat(rule.length)),
      ];
    },
    json: (value) =>
      JSON.stringify(value, null, 2)
        .split("\n")
        .map((line) => jsonLine(line, paint))
        .join("\n"),
  };
  return self;
}

/**
 * One line of `JSON.stringify(value, null, 2)`, marked up by hand.
 *
 * Line by line rather than over the whole document: that formatter puts one
 * key and one scalar on a line, so the line itself is the only structure this
 * needs. Keys are what a reader scans for, punctuation is what they skip, and
 * a number, a boolean or null is data that reads differently from a string.
 */
function jsonLine(
  line: string,
  paint: (format: "bold" | "dim" | "green", text: string) => string,
): string {
  const match = /^(\s*)(?:("(?:[^"\\]|\\.)*")(: ))?(.*?)(,?)$/.exec(line);
  if (!match) return line;
  const [, indent = "", key, colon, value = "", comma = ""] = match;
  const painted =
    value === ""
      ? ""
      : /^[[\]{}]+$/.test(value)
        ? paint("dim", value)
        : value.startsWith('"')
          ? value
          : paint("green", value);
  return (
    indent +
    (key && colon ? paint("bold", key) + paint("dim", colon) : "") +
    painted +
    (comma ? paint("dim", comma) : "")
  );
}
