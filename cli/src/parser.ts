import { fail, MANAGEMENT_KEY_ENV, VERSION } from "./common.ts";

const secret = "key-prompt! key-stdin! browser! no-open!";
const browser = "no-open!";
/** A management key pasted in, or — the default — a login approved in a browser. */
const managementKey = "key-prompt! key-stdin! no-open!";
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
 * a browser, a hidden prompt, a private file, Wrangler, a wait — or that run
 * before there is a gateway to ask. Every other command is the gateway's,
 * built from the tool list it serves (see `./catalog.ts`), and one named here
 * always wins over a tool offered under the same words.
 */
export const commands = {
  "deployment setup": {
    args: 0,
    flags:
      "name cloudflare-account-id domain no-domain! version release-archive dry-run! yes!",
    summary: "Deploy your own gateway to your Cloudflare account",
  },
  "deployment connect": {
    args: 0,
    flags: `url cloud! ${managementKey}`,
    summary: "Connect this CLI to a gateway and sign in",
  },
  "deployment status": { args: 0, flags: "", summary: "Show the connected gateway" },
  "deployment update": {
    args: 0,
    flags: "version release-archive dry-run! yes!",
    summary: "Update your self-hosted gateway to this CLI's release",
  },
  "deployment domain": {
    args: 0,
    flags: "hostname release-archive dry-run! yes!",
    summary: "Move your self-hosted gateway to a custom domain",
  },
  "account claim": { args: 0, flags: browser, summary: "Claim this account as a person, in a browser" },
  "account login": { args: 0, flags: managementKey, summary: "Sign in through a browser" },
  "account logout": { args: 0, flags: "", summary: "Revoke this CLI's key and forget it" },
  "provider types": { args: 0, flags: "", summary: "List the provider types this gateway supports" },
  "provider add": {
    args: 0,
    flags: `type name slug provider-gateway base-url pricing route ${secret}`,
    summary: "Add a provider; its key goes in a hidden prompt or a browser",
  },
  "provider update": {
    args: 1,
    flags: `name status base-url clear-base-url! pricing clear-pricing! route clear-route! ${secret}`,
    summary: "Change a provider, by id or slug",
  },
  "provider rotate-key": { args: 1, flags: secret, summary: "Replace a provider's key" },
  "provider remove": { args: 1, flags: "yes!", summary: "Delete a provider, by id or slug" },
  "provider-gateway types": { args: 0, flags: "", summary: "List the provider gateway types this gateway supports" },
  "provider-gateway show": { args: 1, flags: "", summary: "Show a provider gateway, by id or name" },
  "provider-gateway add": {
    args: 0,
    flags: `type name cloudflare-account-id gateway-id ${secret}`,
    summary: "Add a provider gateway, such as a Cloudflare AI Gateway",
  },
  "provider-gateway update": { args: 1, flags: "name", summary: "Rename a provider gateway" },
  "provider-gateway rotate-key": { args: 1, flags: secret, summary: "Replace a provider gateway's token" },
  "provider-gateway remove": { args: 1, flags: "yes!", summary: "Delete a provider gateway" },
  "app add": {
    args: 0,
    flags:
      "type name team-id bundle-id attest-environments* verify-on providers* status file key-output dry-run!",
    summary: "Add an iOS or server app; a server app's key goes to a private file",
  },
  "app snippet": { args: 1, flags: "language provider endpoint output", summary: "Print a first request for an app" },
  "app conversations": { args: 1, flags: "from to output media!", summary: "Download an app's stored conversations" },
  "app key add": { args: 1, flags: "name key-output", summary: "Create a server app key, written to a private file" },
  "operation status": { args: 1, flags: "", summary: "Check a browser step this CLI opened" },
  "operation wait": { args: 1, flags: "timeout", summary: "Wait for a browser step this CLI opened" },
  "support send": { args: 0, flags: "type message message-stdin! context* yes!", summary: "Email human support" },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof commands;

/**
 * Every flag the table above can produce, by the type its declaration gives it.
 *
 * Written out rather than left as an index signature so that a command reading
 * `flags["team-id"]` gets a `string | undefined` and a misspelt flag name is a
 * type error. `provider` carries both types because it is repeatable on the
 * application commands and single-valued on `app snippet`.
 */
export interface Flags {
  json?: true;
  "no-input"?: true;
  help?: true;
  yes?: true;
  browser?: true;
  "no-open"?: true;
  "key-prompt"?: true;
  "key-stdin"?: true;
  "dry-run"?: true;
  cloud?: true;
  "no-domain"?: true;
  "clear-base-url"?: true;
  "clear-pricing"?: true;
  "clear-route"?: true;
  "all-providers"?: true;
  "message-stdin"?: true;
  media?: true;
  message?: string;
  context?: string | string[];
  name?: string;
  type?: string;
  slug?: string;
  status?: string;
  url?: string;
  version?: string;
  "release-archive"?: string;
  hostname?: string;
  domain?: string;
  "cloudflare-account-id"?: string;
  "gateway-id"?: string;
  "provider-gateway"?: string;
  "base-url"?: string;
  pricing?: string;
  route?: string;
  "team-id"?: string;
  "bundle-id"?: string;
  "attest-environments"?: string | string[];
  "verify-on"?: string;
  file?: string;
  "key-output"?: string;
  output?: string;
  language?: string;
  endpoint?: string;
  from?: string;
  to?: string;
  timeout?: string;
  /** One provider, as `app snippet` names it. */
  provider?: string;
  /** Every provider an app may use, as `app add` and the gateway's `app update` name them. */
  providers?: string | string[];
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
    ["domain", "no-domain"],
    ["base-url", "clear-base-url"],
    ["pricing", "clear-pricing"],
    ["route", "clear-route"],
    ["provider", "all-providers"],
    ["message", "message-stdin"],
    ...(command === "app snippet" ? [["provider", "endpoint"]] : []),
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
    command !== "account claim" &&
    command !== "account login" &&
    command !== "deployment connect"
  )
    fail("invalid_input", "--no-open requires --browser.");
  if (flags["no-open"] && (flags["key-prompt"] || flags["key-stdin"]))
    fail(
      "conflicting_flags",
      "--no-open only applies to browser authentication.",
    );
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
Login: account login and deployment connect open the browser; check that it shows the pairing code the terminal prints. --no-open prints the URL instead; --key-stdin or --key-prompt takes a management key.
Credentials: ${MANAGEMENT_KEY_ENV}, when set, is the management key for every command and overrides the saved login. account logout revokes the saved key.
Secrets: hidden prompt by default; --key-stdin reads one line. Provider --browser submits credentials directly to your gateway.
Browser operations: --json or --no-input returns pending; operation wait resumes.
Support: support send emails human support for the signed-in person, who gets the reply by email. Without a terminal it needs --yes: show the person the message first. Never put a key or token in it.
Gateway commands: every command not built into agw comes from the connected gateway, so a new gateway release brings its commands without an agw update. Their flags follow the gateway's arguments; JSON values are inline or @file.
No account is created by help, status, list, validation or dry runs.
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
