/**
 * Running a command the gateway describes rather than this CLI: resolving its
 * words against the tool list, reading its arguments, asking before a
 * deletion, and calling the tool.
 */

import { stdin as processStdin } from "node:process";
import { commandWords, findTool, type CachedCatalog, type CliTool, type ToolCatalog } from "./catalog.ts";
import { CliError, fail } from "./common.ts";
import type { Context } from "./context.ts";
import { canPrompt, confirm } from "./input.ts";
import { commands, type Flags } from "./parser.ts";
import { fieldsOf, readInvocation, requireFields, type ToolInvocation } from "./tool-args.ts";
import { clean, usageLine } from "./tool-output.ts";

/** The header a tool call answers with the gateway's tool list revision in. */
const REVISION_HEADER = "agw-tools-revision";

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
  return { tool, list };
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

/**
 * Runs one gateway command. `argv` is the command line after the command's
 * words; the help it asks for is returned as text instead of a result.
 */
export async function runGatewayCommand(
  ctx: Context,
  catalog: ToolCatalog,
  tool: CliTool,
  argv: readonly string[],
  stdin: () => Promise<string> = readStdin,
): Promise<GatewayCommandResult | { help: true }> {
  const invocation = await readInvocation(tool, argv, stdin);
  if (invocation.help) return { help: true };
  await consent(tool, invocation, ctx.flags);
  const input = { ...invocation.input };
  // A deletion names what it deletes twice; once the person has agreed, the
  // CLI says it the second time for them.
  const confirmField = tool.cli.confirm;
  if (confirmField && input.confirm === undefined && input[confirmField] !== undefined) input.confirm = input[confirmField];
  requireFields(tool, input);
  let answer;
  try {
    answer = await ctx.call("callCliTool", { params: { tool: tool.name }, body: input });
  } catch (error) {
    if (error instanceof CliError) error.message = flagsIn(tool, error.message);
    // The gateway no longer has this tool: the list kept here is older than it.
    if (error instanceof CliError && error.code === "not_found" && error.details?.status === 404 && !catalog.fresh) {
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
  await catalog.observe(answer.headers?.get(REVISION_HEADER));
  return { tool, summary: answer.data.summary, result: answer.data.result };
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
