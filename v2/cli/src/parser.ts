import { fail, MANAGEMENT_KEY_ENV, VERSION } from "./common.ts";

const secret = "key-prompt! key-stdin! browser! no-open!";
/** How a person signs in: a browser on this machine, or a code approved anywhere. */
const signIn = "no-open! device!";
const common = "json! no-input!";

export interface CommandSpec {
  /** How many positional resource arguments the command requires. */
  args: number;
  /** Space-separated flag names; `!` marks a boolean, `*` a repeatable value. */
  flags: string;
  /** One line for `agw --help`. */
  summary: string;
}

/**
 * The commands this CLI implements itself: the ones that need this machine —
 * a browser, a hidden prompt, a private file, a wait — or that run before
 * there is a gateway to ask. Every other command is the gateway's, built from
 * the tool list it serves (see `./catalog.ts`), and one named here always
 * wins over a tool offered under the same words.
 */
export const commands = {
  "deployment connect": {
    args: 0,
    flags: `url cloud! ${signIn}`,
    summary: "Connect this CLI to a gateway and sign in",
  },
  "deployment status": { args: 0, flags: "", summary: "Show the connected gateway and who is signed in" },
  "account login": { args: 0, flags: signIn, summary: "Sign in through a browser, or with a code on another device" },
  "account logout": { args: 0, flags: "", summary: "End this CLI's sign-in and forget it" },
  "provider add": {
    args: 0,
    flags: `type name slug base-url pricing ${secret}`,
    summary: "Add a provider; its key goes in a hidden prompt, stdin or a browser",
  },
  "provider rotate-key": { args: 1, flags: secret, summary: "Replace a provider's key, by id or slug" },
  "app add": {
    args: 0,
    flags: "type name team-id bundle-id user-header file key-output dry-run!",
    summary: "Add an iOS or server app; a server app's key goes to a private file",
  },
  "app key add": { args: 1, flags: "name key-output", summary: "Create a server app key, written to a private file" },
  "app conversations": {
    args: 1,
    flags: "from to output media!",
    summary: "Download an app's stored conversations into a folder",
  },
  "app update": {
    args: 1,
    flags: "name status operations revision",
    summary: "Rename an app, turn it on or off, or apply a JSON patch",
  },
  "operation wait": { args: 1, flags: "timeout", summary: "Wait for a browser step this CLI opened" },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof commands;

/**
 * Every flag the table above can produce, by the type its declaration gives it,
 * so a misspelt flag name is a type error.
 */
export interface Flags {
  json?: true;
  "no-input"?: true;
  help?: true;
  yes?: true;
  browser?: true;
  "no-open"?: true;
  device?: true;
  "key-prompt"?: true;
  "key-stdin"?: true;
  "dry-run"?: true;
  cloud?: true;
  name?: string;
  type?: string;
  slug?: string;
  status?: string;
  url?: string;
  "base-url"?: string;
  pricing?: string;
  "team-id"?: string;
  "bundle-id"?: string;
  "user-header"?: string;
  file?: string;
  "key-output"?: string;
  operations?: string;
  revision?: string;
  timeout?: string;
  from?: string;
  to?: string;
  output?: string;
  media?: true;
}

export type ParseResult =
  | { help: true; scope: string; version?: never; command?: never; flags?: never; args?: never; words?: never }
  | { version: true; help?: never; command?: never; flags?: never; args?: never; words?: never }
  | { command: CommandName; flags: Flags; args: string[]; help?: never; version?: never; words?: never }
  /**
   * No built-in command: the words a command of the gateway's may be, which
   * only its tool list can resolve.
   */
  | { words: string[]; help?: never; version?: never; command?: never; flags?: never; args?: never };

/** A repeatable flag's values, whichever way this command declared it. */
export function flagList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

type FlagType = "boolean" | "multiple" | "string";

export function parse(argv: string[]): ParseResult {
  const words: string[] = [];
  for (const token of argv) {
    if (token.startsWith("-")) break;
    words.push(token);
  }
  const command = (Object.keys(commands) as CommandName[])
    .sort((a, b) => b.length - a.length)
    .find((c) => words.slice(0, c.split(" ").length).join(" ") === c);
  const help = argv.includes("--help") || argv.includes("-h");
  if (!command) {
    if (argv.length === 1 && argv[0] === "--version") return { version: true };
    if (help || !argv.length) return { help: true, scope: words.join(" ") };
    return { words };
  }
  const spec: CommandSpec = commands[command];
  const types: Record<string, FlagType> = Object.fromEntries(
    `${common} help! ${spec.flags}`
      .trim()
      .split(/\s+/)
      .map((f): [string, FlagType] => [
        f.replace(/[!*]$/, ""),
        f.endsWith("!") ? "boolean" : f.endsWith("*") ? "multiple" : "string",
      ]),
  );
  // Built loose and named once: the parser discovers flags by string, and the
  // declared `Flags` shape is what every command reads them through.
  const collected: Record<string, string | string[] | true> = {};
  const args: string[] = [];
  for (let i = command.split(" ").length; i < argv.length; i++) {
    let token = argv[i]!;
    if (token === "-h") token = "--help";
    if (token === "-y") token = "--yes";
    if (!token.startsWith("-")) {
      args.push(token);
      continue;
    }
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(token);
    if (!match || !types[match[1]!])
      fail(
        "unknown_flag",
        `Unknown flag ${token.split("=")[0]} for ${command}.`,
        // Resources are addressed positionally throughout, so the one mistake
        // worth answering with more than the help text is naming one as a flag.
        spec.args && ["id", "app", "app-id"].includes(match?.[1] ?? "")
          ? `Pass the identifier as an argument: agw ${command}${" <id>".repeat(spec.args)}.`
          : undefined,
      );
    const name = match[1]!;
    const inline = match[2];
    const type = types[name]!;
    if (Object.hasOwn(collected, name) && type !== "multiple")
      fail("duplicate_flag", `--${name} may only be supplied once.`);
    if (type === "boolean") {
      if (inline !== undefined)
        fail("invalid_input", `--${name} does not take a value.`);
      collected[name] = true;
    } else {
      const value = inline ?? argv[++i];
      if (!value || value.startsWith("--"))
        fail("missing_value", `--${name} requires a value.`);
      if (type === "multiple") {
        const existing = collected[name];
        const list = Array.isArray(existing) ? existing : [];
        list.push(value);
        collected[name] = list;
      } else collected[name] = value;
    }
  }
  const flags = collected as Flags;
  if (flags.help) return { help: true, scope: command };
  if (args.length !== spec.args)
    fail(
      "invalid_arguments",
      `${command} requires ${spec.args} resource argument(s).`,
    );
  for (const group of [
    ["key-prompt", "key-stdin", "browser"],
    ["url", "cloud"],
    ["no-open", "device"],
    ["file", "name"],
    ["file", "type"],
  ]) {
    if (group.filter((k) => collected[k] !== undefined).length > 1)
      fail(
        "conflicting_flags",
        group.map((k) => `--${k}`).join(" and ") + " conflict.",
      );
  }
  if (flags["key-prompt"] && flags["no-input"])
    fail("conflicting_flags", "--key-prompt cannot be used with --no-input.");
  if (
    flags["no-open"] &&
    !flags.browser &&
    command !== "account login" &&
    command !== "deployment connect"
  )
    fail("invalid_input", "--no-open requires --browser.");
  return { command, flags, args };
}

/** One line of `agw --help`: a command as it is typed, and what it does. */
export interface HelpEntry {
  usage: string;
  summary: string;
}

/** A built-in command's flags, as its help lists them. */
function flagLine(spec: CommandSpec): string {
  return spec.flags
    .split(" ")
    .filter(Boolean)
    .map(
      (f) =>
        "--" +
        f.replace(/[!*]$/, "") +
        (f.endsWith("!") ? "" : " <value>") +
        (f.endsWith("*") ? " (repeatable)" : ""),
    )
    .join(" ");
}

/** The built-in commands under `scope`, all of them for an empty one. */
export function builtInEntries(scope = ""): HelpEntry[] {
  return Object.entries(commands)
    .filter(([c]) => !scope || c === scope || c.startsWith(scope + " "))
    .map(([c, s]) => ({ usage: `agw ${c}${" <id>".repeat(s.args)}`, summary: s.summary }));
}

/** `agw <command> --help` for a built-in command. */
export function builtInHelp(command: CommandName): string {
  const spec: CommandSpec = commands[command];
  const flags = flagLine(spec);
  return `agw ${command}${" <id>".repeat(spec.args)}${flags ? " [flags]" : ""}\n${spec.summary}\n${flags ? `\n  ${flags}\n` : ""}\n${HELP_NOTES}`;
}

/** What every command shares, said once at the end of `agw --help`. */
export const HELP_NOTES = `--json: one JSON document on stdout; --no-input: never prompt; --help, -h: help for any command.
Sign-in: account login and deployment connect open a browser on this machine; --device, or a machine with no browser, shows a link and a short code to approve in any browser. The sign-in renews itself; account logout ends it.
Credentials: ${MANAGEMENT_KEY_ENV}, when set, is the management key for every command and overrides the saved sign-in. Use it in CI and scripts.
Secrets: hidden prompt by default; --key-stdin reads one line; provider --browser has a person type the key in the console instead.
New app keys: written to a private file (--key-output, or one agw picks), never printed.
Gateway commands: every command not built into agw comes from the connected gateway, so a new gateway release brings its commands without an agw update. Their flags follow the gateway's arguments; JSON values are inline or @file.
`;

/** `agw --help`, or the help for every command under `scope`, as an aligned list. */
export function commandList(entries: readonly HelpEntry[], heading = `agw ${VERSION} — App AI Gateway`): string {
  const sorted = [...entries].sort((a, b) => a.usage.localeCompare(b.usage));
  const width = Math.min(44, Math.max(0, ...sorted.map((entry) => entry.usage.length)) + 2);
  const lines = sorted.map((entry) =>
    entry.usage.length + 2 > width
      ? `  ${entry.usage}\n  ${" ".repeat(width)}${entry.summary}`
      : `  ${entry.usage.padEnd(width)}${entry.summary}`,
  );
  return `${heading}\n\n${lines.join("\n")}\n\nRun agw <command> --help for its arguments and flags.\n\n${HELP_NOTES}`;
}
