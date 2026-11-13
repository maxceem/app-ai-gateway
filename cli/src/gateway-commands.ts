/**
 * Running a command the gateway describes rather than this CLI: resolving its
 * words against the tool list, reading its arguments, asking before a
 * deletion, and calling the tool.
 */

import { stdin as processStdin } from "node:process";
import { commandWords, findTool, missingFeatures, type CachedCatalog, type CliTool, type ToolCatalog } from "./catalog.ts";
import { CliError, fail, VERSION } from "./common.ts";
import type { Context } from "./context.ts";
import { canPrompt, confirm } from "./input.ts";
import { commands, type Flags } from "./parser.ts";
import { fieldsOf, readInvocation, requireFields, type ToolInvocation } from "./tool-args.ts";
import { clean, usageLine } from "./tool-output.ts";

/** The header a tool call answers with the gateway's tool list revision in. */
const REVISION_HEADER = "agw-tools-revision";

/** The header a tool call sends the tool's guard in. */
const GUARD_HEADER = "agw-tool-guard";

const builtIn = (command: string): boolean => Object.hasOwn(commands, command);

/** Everything standard input holds, for an `@-` value. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of processStdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The tool `words` name, from the kept list or, when it has no such command
 * and was not fetched in this run, from the gateway's current one.
 */
export async function resolveTool(
  catalog: ToolCatalog,
  words: readonly string[],
): Promise<{ tool: CliTool; list: CachedCatalog }> {
  let list = await catalog.load();
  let tool = findTool(list.tools, words, builtIn);
  if (!tool && !catalog.fresh) {
    list = await catalog.refresh();
    tool = findTool(list.tools, words, builtIn);
  }
  if (!tool)
    fail(
      "unknown_command",
      `Unknown command: agw ${clean(words.join(" "))}.`,
      "Run agw --help to list every command this gateway offers.",
    );
  supported(tool);
  return { tool, list };
}

/** Refuses a tool that needs a feature of `agw` this release does not have. */
function supported(tool: CliTool): void {
  if (missingFeatures(tool).length > 0)
    fail(
      "cli_outdated",
      `agw ${tool.cli.command} needs a newer agw than ${VERSION}.`,
      "Update agw: npm install -g @maxceem/agw",
    );
}

/** Standard input, read at most once however many times a command line is read. */
function once(read: () => Promise<string>): () => Promise<string> {
  let text: Promise<string> | undefined;
  return () => (text ??= read());
}

/** The flags a context reads, from a command line no built-in command parsed. */
export function contextFlags(argv: readonly string[]): Flags {
  return {
    ...(argv.includes("--json") ? { json: true } : {}),
    ...(argv.includes("--no-input") ? { "no-input": true } : {}),
    ...(argv.includes("--yes") || argv.includes("-y") ? { yes: true } : {}),
  };
}

export interface GatewayCommandResult {
  tool: CliTool;
  summary: string;
  result: Record<string, unknown>;
}

/**
 * Asks before a tool the gateway marks as destructive: on a terminal, for the
 * word yes; anywhere else, only `--yes` goes ahead, which an agent passes once
 * the person it acts for has agreed.
 */
async function consent(tool: CliTool, invocation: ToolInvocation, flags: Flags): Promise<void> {
  if (!tool.annotations.destructiveHint || invocation.yes) return;
  if (!canPrompt(flags) || invocation.json)
    fail(
      "confirmation_required",
      `agw ${clean(tool.cli.command)} cannot be undone and needs confirmation.`,
      "Show the person what it deletes, then run it again with --yes once they agree.",
      4,
    );
  const subject = (tool.cli.args ?? [])
    .map((name) => invocation.input[name])
    .filter((value) => typeof value === "string")
    .join(" ");
  await confirm(`${clean(tool.title)}${subject ? ` ${clean(subject)}` : ""}? This cannot be undone.`, flags);
}

/** Refusals of a command line that a newer list of the same tool may not make. */
const STALE_LINE = new Set(["unknown_flag", "invalid_arguments"]);

/**
 * The command line read against the tool, or — when the list kept here does
 * not know a flag or an argument and was not fetched in this run — against the
 * same tool in the gateway's current list, once.
 */
async function invocationOf(
  catalog: ToolCatalog,
  tool: CliTool,
  argv: readonly string[],
  stdin: () => Promise<string>,
): Promise<{ tool: CliTool; invocation: ToolInvocation }> {
  try {
    return { tool, invocation: await readInvocation(tool, argv, stdin) };
  } catch (error) {
    if (!(error instanceof CliError) || !STALE_LINE.has(error.code) || catalog.fresh) throw error;
    const current = (await catalog.refresh().catch(() => undefined))?.tools.find((entry) => entry.name === tool.name);
    if (!current || current.cli.command !== tool.cli.command) throw error;
    // The newer description may need what this release lacks.
    supported(current);
    return { tool: current, invocation: await readInvocation(current, argv, stdin) };
  }
}

/**
 * Runs one gateway command. `argv` is the command line after the command's
 * words; the help it asks for is returned as text instead of a result. The
 * tool is answered with too, since a list fetched on the way may hold a newer
 * description of it.
 *
 * A call carries the tool's guard, and the gateway refuses it with
 * `tool_changed`, before anything runs, when the tool has since become
 * destructive or come to need more of this CLI. That is the one refusal
 * answered here rather than reported: the line is read again against the
 * gateway's current description, what it needs and whether to ask are decided
 * again, and the call is sent once more. A release that changes neither
 * leaves the guard as it was, so nothing about it costs a request.
 */
export async function runGatewayCommand(
  ctx: Context,
  catalog: ToolCatalog,
  given: CliTool,
  argv: readonly string[],
  stdin: () => Promise<string> = readStdin,
): Promise<GatewayCommandResult | { help: true; tool: CliTool }> {
  const read = once(stdin);
  let { tool, invocation } = await invocationOf(catalog, given, argv, read);
  if (invocation.help) return { help: true, tool };
  let answer;
  try {
    answer = await send(ctx, catalog, tool, invocation);
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "tool_changed") throw error;
    const current = (await catalog.refresh()).tools.find((entry) => entry.name === tool.name);
    if (!current) throw error;
    supported(current);
    tool = current;
    invocation = await readInvocation(tool, argv, read);
    answer = await send(ctx, catalog, tool, invocation);
  }
  await catalog.observe(answer.headers?.get(REVISION_HEADER));
  return { tool, summary: answer.data.summary, result: answer.data.result };
}

/**
 * One call of a tool: its arguments completed and checked, the person's
 * consent where it destroys, and its guard sent beside it. A refusal is read
 * for the revision it carries, and said with the flags a person typed.
 */
async function send(ctx: Context, catalog: ToolCatalog, tool: CliTool, invocation: ToolInvocation) {
  const input = { ...invocation.input };
  // A deletion names what it deletes twice; once the person has agreed, the
  // CLI says it the second time for them.
  const confirmField = tool.cli.confirm;
  if (confirmField && input.confirm === undefined && input[confirmField] !== undefined) input.confirm = input[confirmField];
  // What is missing is said before anybody is asked to agree to it.
  requireFields(tool, input);
  await consent(tool, invocation, ctx.flags);
  try {
    return await ctx.call("callCliTool", {
      params: { tool: tool.name },
      body: input,
      ...(tool.guard === undefined ? {} : { headers: { [GUARD_HEADER]: tool.guard } }),
    });
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    error.message = flagsIn(tool, error.message);
    await catalog.observe(error.headers?.get(REVISION_HEADER));
    // The gateway no longer has this tool: the list kept here is older than it.
    if (error.code === "tool_not_found") {
      // At most once a run, and not at all when the revision already fetched it.
      await catalog.refresh().catch(() => {});
      throw new CliError(
        error.code,
        error.message,
        `The gateway's commands changed; run agw --help, or ${usageLine(tool)} --help.`,
        error.exitCode,
        error.details,
      );
    }
    throw error;
  }
}

/**
 * The gateway's refusal with the argument it names written as the flag a
 * person typed: `team_id: …` reads `--team-id: …`, a positional `app: …`
 * reads `<app>: …`.
 */
export function flagsIn(tool: CliTool, message: string): string {
  const fields = fieldsOf(tool);
  return message.replace(/(^|: )([A-Za-z][A-Za-z0-9_]*)(?=: )/u, (whole, before: string, name: string) => {
    const field = fields.find((candidate) => candidate.name === name);
    if (!field) return whole;
    return `${before}${field.positional ? `<${field.flag}>` : `--${field.flag}`}`;
  });
}

/** The words a command line names a gateway command with, as many as the tool's command has. */
export function argumentsAfter(tool: CliTool, argv: readonly string[]): string[] {
  return argv.slice(commandWords(tool).length);
}
