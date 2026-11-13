/**
 * How a command built from the gateway's tool list looks to a person: its
 * result, and its help.
 *
 * Everything shown here came from the gateway — descriptions, summaries,
 * values — and a value may be anything somebody typed into an app's name. So
 * every piece is cleaned before it is written: control characters, escape
 * sequences included, become spaces, and a cell is cut to a width a table can
 * hold. Colour is only ever added here, around text already cleaned.
 *
 * The gateway words its tool descriptions and summaries for agents, naming
 * other tools (`list_apps`); a terminal reads the command each one is
 * instead (`agw app list`).
 */

import type { CliTool } from "./catalog.ts";
import type { Style } from "./style.ts";
import { fieldsOf, type Field } from "./tool-args.ts";

/** One line of remote text, safe for a terminal. */
export function clean(text: string): string {
  return text.replace(/\p{C}/gu, " ").replace(/\s+/gu, " ").trim();
}

/** Remote text cut to `width` characters. */
function cut(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

/** `list_apps` in a sentence as `agw app list`, for every tool the list names. */
export function mentions(text: string, tools: readonly CliTool[]): string {
  const names = tools.map((tool) => tool.name).sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const commands = new Map(tools.map((tool) => [tool.name, `agw ${tool.cli.command}`]));
  const pattern = new RegExp(`\\b(${names.map((name) => name.replace(/[^a-z0-9_]/gu, "")).join("|")})\\b`, "gu");
  return text.replace(pattern, (name) => commands.get(name) ?? name);
}

/** Words wrapped at `width`, each line after the first indented by `indent`. */
function wrap(text: string, width: number, indent = ""): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = indent + word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A dotted path into a value; `$1`, `$2` read the keys a `*` matched on the way to it. */
function valueAt(row: Row, path: string): unknown {
  if (/^\$\d+$/u.test(path)) return row.keys[Number(path.slice(1)) - 1];
  let value: unknown = row.value;
  for (const segment of path.split(".")) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

/** A value as one table cell or one line. */
function cell(value: unknown, width: number): string {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string" || typeof value === "number") return cut(clean(String(value)), width);
  if (Array.isArray(value) && value.every((item) => typeof item !== "object" || item === null))
    return value.length === 0 ? "-" : cut(clean(value.map(String).join(", ")), width);
  return cut(clean(JSON.stringify(value)), width);
}

interface Row {
  value: unknown;
  /** The keys each `*` in the path matched. */
  keys: string[];
}

/** The rows at `path`: an array's items, or with `*` every entry of what it reaches. */
function rowsAt(result: unknown, path: string): Row[] | undefined {
  let rows: Row[] = [{ value: result, keys: [] }];
  for (const segment of path ? path.split(".") : []) {
    rows = rows.flatMap((row): Row[] => {
      if (segment === "*") {
        if (Array.isArray(row.value)) return row.value.map((value, index) => ({ value, keys: [...row.keys, String(index)] }));
        if (isRecord(row.value)) return Object.entries(row.value).map(([key, value]) => ({ value, keys: [...row.keys, key] }));
        return [];
      }
      return isRecord(row.value) && row.value[segment] !== undefined ? [{ value: row.value[segment], keys: row.keys }] : [];
    });
  }
  if (rows.length === 0) return undefined;
  const expanded = rows.flatMap((row) =>
    Array.isArray(row.value) ? row.value.map((value) => ({ value, keys: row.keys })) : [row],
  );
  return expanded.every((row) => isRecord(row.value)) ? expanded : undefined;
}

/** Words a label spells in capitals. */
const ACRONYMS = new Set(["id", "url", "api", "ios", "usd"]);

/** `key=Label` as its key and label; a bare key is labelled after its last part. */
function column(spec: string): { key: string; label: string } {
  const at = spec.indexOf("=");
  if (at > 0) return { key: spec.slice(0, at), label: spec.slice(at + 1) };
  const words = spec.split(".").at(-1)!.replace(/_/gu, " ").replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase().split(" ");
  const label = words.map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word)).join(" ");
  return { key: spec, label: label.charAt(0).toUpperCase() + label.slice(1) };
}

function table(headers: string[], rows: string[][], style: Style): string[] {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]!.length)));
  const line = (cells: string[], tone: (text: string) => string) =>
    cells.map((text, index) => tone(text) + (index === cells.length - 1 ? "" : " ".repeat(widths[index]! + 2 - text.length))).join("").trimEnd();
  return [line(headers, style.dim), ...rows.map((row) => line(row, style.state))];
}

function kv(entries: [string, string][], style: Style): string[] {
  const width = Math.max(0, ...entries.map(([label]) => label.length + 1));
  return entries.map(([label, value]) => style.dim(`${label}:`.padEnd(width + 1)) + style.state(value));
}

/** Without a view: the result's plain fields, then a table of its first list of objects. */
function generic(result: Record<string, unknown>, style: Style): string[] {
  const lines = kv(
    Object.entries(result)
      .filter(([, value]) => value === null || typeof value !== "object" || (Array.isArray(value) && value.every((item) => typeof item !== "object")))
      .map(([key, value]) => [column(key).label, cell(value, 120)]),
    style,
  );
  const list = Object.entries(result).find(([, value]) => Array.isArray(value) && value.length > 0 && value.every(isRecord));
  if (list) {
    const items = list[1] as Record<string, unknown>[];
    const keys = Object.keys(items[0]!).filter((key) => items.some((item) => item[key] !== null && typeof item[key] !== "object")).slice(0, 7);
    lines.push("", ...table(keys.map((key) => column(key).label), items.map((item) => keys.map((key) => cell(item[key], 40))), style));
  }
  return lines;
}

/** A tool's result as a person reads it: its summary, then its table or its fields. */
export function humanToolResult(
  tool: CliTool,
  summary: string,
  result: Record<string, unknown>,
  tools: readonly CliTool[],
  style: Style,
): string {
  const lines = [style.headline(cut(clean(mentions(summary, tools)), 2000))];
  const view = tool.cli.view;
  let body: string[] | undefined;
  if (view?.rows !== undefined) {
    const rows = rowsAt(result, view.rows);
    if (rows) {
      const columns = (view.columns ?? Object.keys((rows[0]?.value as object | undefined) ?? {})).map(column);
      body = rows.length === 0
        ? []
        : table(columns.map((entry) => entry.label), rows.map((row) => columns.map((entry) => cell(valueAt(row, entry.key), 48))), style);
    }
  } else if (view?.record !== undefined) {
    const record = view.record ? valueAt({ value: result, keys: [] }, view.record) : result;
    if (isRecord(record)) {
      const columns = (view.columns ?? Object.keys(record)).map(column);
      body = kv(
        columns
          .map((entry): [string, unknown] => [entry.label, valueAt({ value: record, keys: [] }, entry.key)])
          .filter(([, value]) => value !== undefined)
          .map(([label, value]) => [label, cell(value, 200)]),
        style,
      );
    }
  }
  body ??= generic(result, style);
  if (body.length > 0) lines.push("", ...body);
  const root: Row = { value: result, keys: [] };
  for (const path of view?.notes ?? []) {
    const entries = valueAt(root, path);
    if (!Array.isArray(entries) || entries.length === 0) continue;
    lines.push("", ...entries.map((entry) => `- ${cut(clean(noteText(entry)), 500)}`));
  }
  if (view?.document) {
    const document = valueAt(root, view.document);
    if (document !== undefined) lines.push("", style.json(printable(document)));
  }
  return lines.join("\n") + "\n";
}

/** A note as one line: a string as it is, an object by its message. */
function noteText(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (isRecord(entry) && typeof entry.message === "string") return entry.message;
  return JSON.stringify(entry);
}

/**
 * A document safe to print as JSON. `JSON.stringify` escapes the C0 controls
 * but writes C1 controls and bidirectional overrides as they are, and either
 * can rewrite what a terminal shows; those become U+FFFD.
 */
function printable(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/[\p{Cc}\p{Cf}]/gu, "\uFFFD");
  if (Array.isArray(value)) return value.map(printable);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [printable(key) as string, printable(entry)]));
  return value;
}

/** What a field takes, as its help line shows it. */
function placeholder(field: Field): string {
  if (field.kind === "boolean") return "";
  if (field.choices && field.choices.length <= 6) return ` <${field.choices.join("|")}>`;
  if (field.kind === "json") return " <json|@file>";
  if (field.kind === "list") return ` <${field.item === "string" ? "value" : field.item}>…`;
  return field.kind === "string" ? " <value>" : ` <${field.kind}>`;
}

/** The command line, with its positional arguments. */
export function usageLine(tool: CliTool): string {
  const args = fieldsOf(tool)
    .filter((field) => field.positional)
    .map((field) => (field.required ? `<${field.flag}>` : `[${field.flag}]`));
  return ["agw", clean(tool.cli.command), ...args].join(" ");
}

/** `agw <command> --help` for a command built from a tool. */
export function toolHelp(tool: CliTool, tools: readonly CliTool[], style: Style): string {
  const text = (value: string) => clean(mentions(value, tools));
  const fields = fieldsOf(tool);
  const section = (title: string, entries: [string, string][]): string[] => {
    if (entries.length === 0) return [];
    // One description column per section, at most a third of the way in; a
    // name too long for it gets a line of its own above its description.
    const column = 2 + Math.min(28, Math.max(...entries.map(([name]) => name.length)) + 2);
    const indent = " ".repeat(column);
    return [
      "",
      style.headline(title),
      ...entries.flatMap(([name, description]) => {
        const head = `  ${name}`;
        if (!description) return [head];
        const body = wrap(description, 78 - column);
        return head.length + 2 > column
          ? [head, ...body.map((line) => indent + line)]
          : [head.padEnd(column) + body[0], ...body.slice(1).map((line) => indent + line)];
      }),
    ];
  };
  const describe = (field: Field) =>
    [field.description ? text(field.description) : "", field.kind === "list" ? "Repeat the flag, or separate values with commas." : "", field.required && !field.positional ? "Required." : ""]
      .filter(Boolean)
      .join(" ");
  const flagEntry = (field: Field): [string, string] => [`--${field.flag}${placeholder(field)}`, describe(field)];
  const filled = new Set(tool.cli.confirm ? ["confirm"] : []);
  const lines = [
    `${style.headline(usageLine(tool))}${fields.some((field) => !field.positional) ? " [flags]" : ""}`,
    text(tool.cli.summary ?? tool.title),
    "",
    ...wrap(text(tool.description), 78),
    ...section("Arguments", fields.filter((field) => field.positional).map((field) => [`<${field.flag}>`, describe(field)])),
    ...section("Shortcuts", fields.filter((field) => field.shortcut && !field.positional).map(flagEntry)),
    ...section("Flags", fields.filter((field) => !field.shortcut && !field.positional && !filled.has(field.name)).map(flagEntry)),
    ...section("Every command", [
      ["--input <json|@file>", "All arguments as one JSON object; flags and arguments override it."],
      ["--json", "One JSON document on stdout, for scripts and agents."],
      ["--no-input", "Never prompt."],
      ...(tool.annotations.destructiveHint ? ([["--yes, -y", "Confirm without being asked. Only once the person has agreed."]] as [string, string][]) : []),
    ]),
  ];
  return lines.join("\n") + "\n";
}
