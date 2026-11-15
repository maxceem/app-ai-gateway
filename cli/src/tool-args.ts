/**
 * A tool's arguments, read from a command line by its input's JSON Schema.
 *
 * Every input field is a flag named after it — `team_id` is `--team-id`, and
 * `fromDate` is `--from-date` — except the ones the gateway names as
 * positional. What a value means is the schema's: a boolean is a bare flag, a
 * number is read as one, an array of plain values is a flag given once per
 * value, and anything structured is JSON, written inline or read from a file
 * with `@path`. Nothing here judges a value beyond reading it: the gateway
 * checks every argument, in its own words, exactly as it checks an agent's.
 */

import { readFile } from "node:fs/promises";
import { CliError, fail } from "./common.ts";
import type { CliTool } from "./catalog.ts";

/** What one input field takes on a command line. */
export type FieldKind = "boolean" | "number" | "integer" | "string" | "list" | "json";

export interface Field {
  /** The input field's own name, as the gateway takes it. */
  name: string;
  /** The flag it is given as, without the dashes. */
  flag: string;
  kind: FieldKind;
  /** For a `list`, what each value is. */
  item?: Exclude<FieldKind, "list" | "json">;
  /** Values the field allows, where the schema lists them. */
  choices?: string[];
  description?: string;
  required: boolean;
  positional: boolean;
  shortcut: boolean;
}

/** Flags every tool command takes, beside its own. */
export const GLOBAL_FLAGS = ["json", "no-input", "yes", "help", "input"] as const;

type Schema = Record<string, unknown>;

const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `team_id` and `fromDate` as flags: `team-id`, `from-date`. */
export function flagName(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/_/gu, "-")
    .toLowerCase();
}

/** The variants of a schema, without the `null` one a nullable field adds. */
function variants(schema: Schema): Schema[] {
  const list = (schema.anyOf ?? schema.oneOf) as unknown;
  if (Array.isArray(list)) return list.filter(isSchema).flatMap(variants).filter((v) => v.type !== "null");
  if (Array.isArray(schema.type)) {
    return (schema.type as unknown[]).filter((t) => t !== "null").map((type) => ({ ...schema, type }));
  }
  return [schema];
}

function scalar(schema: Schema): Exclude<FieldKind, "list" | "json"> | undefined {
  if (schema.const !== undefined || Array.isArray(schema.enum)) return "string";
  switch (schema.type) {
    case "boolean":
    case "number":
    case "integer":
    case "string":
      return schema.type;
    default:
      return undefined;
  }
}

function choicesOf(schemas: Schema[]): string[] | undefined {
  const values = schemas.flatMap((schema) =>
    Array.isArray(schema.enum) ? schema.enum : schema.const !== undefined ? [schema.const] : [],
  );
  return values.length > 0 && values.length === new Set(values).size ? values.map(String) : undefined;
}

function kindOf(schema: Schema): Pick<Field, "kind" | "item" | "choices"> {
  const options = variants(schema);
  const kinds = new Set(options.map(scalar));
  if (options.length > 0 && kinds.size === 1 && !kinds.has(undefined)) {
    const kind = [...kinds][0]!;
    // A literal `true`, as an "all of them" switch is declared, is a bare flag too.
    if (kind === "string" && options.every((option) => option.const === true)) return { kind: "boolean" };
    const choices = choicesOf(options);
    return choices ? { kind, choices } : { kind };
  }
  if (options.length === 1 && options[0]!.type === "array" && isSchema(options[0]!.items)) {
    const items = variants(options[0]!.items);
    const item = items.length > 0 && items.every((entry) => scalar(entry) === scalar(items[0]!)) ? scalar(items[0]!) : undefined;
    if (item && item !== "boolean") {
      const choices = choicesOf(items);
      return choices ? { kind: "list", item, choices } : { kind: "list", item };
    }
  }
  return { kind: "json" };
}

/** Every field of a tool's input, positional ones first in their order, then shortcuts, then the rest. */
export function fieldsOf(tool: CliTool): Field[] {
  const schema = tool.inputSchema as Schema;
  const properties = isSchema(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const positional = tool.cli.args ?? [];
  const shortcuts = new Set(tool.cli.shortcuts ?? []);
  const fields = Object.entries(properties)
    .filter((entry): entry is [string, Schema] => isSchema(entry[1]))
    .map(([name, property]): Field => ({
      name,
      flag: flagName(name),
      ...kindOf(property),
      ...(typeof property.description === "string" ? { description: property.description } : {}),
      required: required.has(name),
      positional: positional.includes(name),
      shortcut: shortcuts.has(name),
    }));
  const rank = (field: Field) =>
    field.positional ? positional.indexOf(field.name) : field.shortcut ? 100 : field.required ? 200 : 300;
  return fields.sort((a, b) => rank(a) - rank(b));
}

export interface ToolInvocation {
  input: Record<string, unknown>;
  json: boolean;
  noInput: boolean;
  yes: boolean;
  help: boolean;
}

/** A JSON value as given: inline, `@path` for a file, `@-` for standard input. */
export async function jsonValue(flag: string, text: string, stdin: () => Promise<string>): Promise<unknown> {
  let source = text;
  if (text.startsWith("@")) {
    const path = text.slice(1);
    try {
      source = path === "-" ? await stdin() : await readFile(path, "utf8");
    } catch {
      fail("invalid_input", `--${flag}: cannot read ${path === "-" ? "standard input" : path}.`);
    }
  }
  try {
    return JSON.parse(source);
  } catch {
    fail("invalid_input", `--${flag} takes JSON, inline or as @file.`, `Run the command with --help to see what --${flag} holds.`);
  }
}

function scalarValue(field: Pick<Field, "flag">, kind: Exclude<FieldKind, "list" | "json">, text: string): unknown {
  if (kind === "number" || kind === "integer") {
    const number = Number(text);
    // Sent as typed when it is not a number, so the gateway refuses it in its own words.
    return text.trim() !== "" && Number.isFinite(number) ? number : text;
  }
  if (kind === "boolean") {
    if (text === "true") return true;
    if (text === "false") return false;
    fail("invalid_input", `--${field.flag} is true or false.`);
  }
  return text;
}

/**
 * The values one list flag gives: a JSON array as the whole list, otherwise
 * comma-separated values, so `--providers a,b` and `--providers a --providers
 * b` say the same. A value holding a comma is written in a JSON array.
 */
export function listValues(field: Pick<Field, "flag" | "item">, text: string): unknown[] {
  if (text.trimStart().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON after all: a value that starts with a bracket.
    }
  }
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => scalarValue(field, field.item ?? "string", part));
}

/**
 * Reads one command line — everything after the command's words — into the
 * tool's arguments. `--input` gives them all as one JSON object, and every
 * flag and positional argument is laid over it.
 */
export async function readInvocation(
  tool: CliTool,
  argv: readonly string[],
  stdin: () => Promise<string>,
): Promise<ToolInvocation> {
  const fields = fieldsOf(tool);
  const byFlag = new Map(fields.filter((field) => !(GLOBAL_FLAGS as readonly string[]).includes(field.flag)).map((field) => [field.flag, field]));
  const positional = fields.filter((field) => field.positional).sort(
    (a, b) => (tool.cli.args ?? []).indexOf(a.name) - (tool.cli.args ?? []).indexOf(b.name),
  );
  const invocation: ToolInvocation = { input: {}, json: false, noInput: false, yes: false, help: false };
  const given: Record<string, unknown> = {};
  const words: string[] = [];
  let base: unknown;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "-h" || token === "--help") {
      invocation.help = true;
      continue;
    }
    if (token === "-y") {
      invocation.yes = true;
      continue;
    }
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const match = /^--([a-z][a-z0-9-]*)(?:=([\s\S]*))?$/u.exec(token);
    const name = match?.[1];
    if (!match || !name) fail("unknown_flag", `Unknown flag ${token.split("=")[0]}.`, `Run agw ${tool.cli.command} --help.`);
    const inline = match[2];
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) fail("missing_value", `--${name} requires a value.`);
      index++;
      return next;
    };
    if (name === "json" || name === "no-input" || name === "yes") {
      if (inline !== undefined) fail("invalid_input", `--${name} does not take a value.`);
      if (name === "json") invocation.json = true;
      else if (name === "no-input") invocation.noInput = true;
      else invocation.yes = true;
      continue;
    }
    if (name === "input") {
      if (base !== undefined) fail("duplicate_flag", "--input may only be supplied once.");
      base = await jsonValue("input", value(), stdin);
      if (typeof base !== "object" || base === null || Array.isArray(base))
        fail("invalid_input", "--input takes a JSON object of the command's arguments.");
      continue;
    }
    const field = byFlag.get(name);
    if (!field) fail("unknown_flag", `Unknown flag --${name} for agw ${tool.cli.command}.`, `Run agw ${tool.cli.command} --help.`);
    if (field.kind === "list") {
      const list = (given[field.name] ??= []) as unknown[];
      list.push(...listValues(field, value()));
      continue;
    }
    if (Object.hasOwn(given, field.name)) fail("duplicate_flag", `--${field.flag} may only be supplied once.`);
    if (field.kind === "boolean" && inline === undefined) given[field.name] = true;
    else if (field.kind === "json") given[field.name] = await jsonValue(field.flag, value(), stdin);
    else given[field.name] = scalarValue(field, field.kind, value());
  }
  if (invocation.help) return invocation;
  if (words.length > positional.length)
    fail(
      "invalid_arguments",
      `agw ${tool.cli.command} takes ${positional.length === 0 ? "no arguments" : positional.map((field) => `<${field.flag}>`).join(" ")}; got ${words.length}.`,
      `Run agw ${tool.cli.command} --help.`,
    );
  words.forEach((word, index) => {
    const field = positional[index]!;
    if (Object.hasOwn(given, field.name)) fail("duplicate_flag", `<${field.flag}> was given twice.`);
    given[field.name] = field.kind === "json" || field.kind === "list" ? word : scalarValue(field, field.kind, word);
  });
  invocation.input = { ...(base as Record<string, unknown> | undefined), ...given };
  return invocation;
}

/** The required fields a call still lacks, once anything the CLI fills in is in. */
export function missingFields(tool: CliTool, input: Record<string, unknown>): Field[] {
  return fieldsOf(tool).filter((field) => field.required && (input[field.name] === undefined || input[field.name] === null));
}

/** Refuses a call that lacks a required argument, naming how to give it. */
export function requireFields(tool: CliTool, input: Record<string, unknown>): void {
  const missing = missingFields(tool, input);
  if (missing.length === 0) return;
  const named = missing.map((field) => (field.positional ? `<${field.flag}>` : `--${field.flag}`));
  throw new CliError(
    "missing_value",
    `agw ${tool.cli.command} needs ${named.join(", ")}.`,
    `Run agw ${tool.cli.command} --help.`,
    2,
  );
}
