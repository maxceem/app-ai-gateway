import { Writable } from "node:stream";
import { appCommand } from "./apps.ts";
import {
  FileCatalogCache,
  findTool,
  missingFeatures,
  ToolCatalog,
  type CachedCatalog,
  type CatalogCache,
  type CliTool,
} from "./catalog.ts";
import { conversationsCommand } from "./conversations.ts";
import { operationPath } from "../../src/contracts/catalog.ts";
import { CLOUD, CliError, origin, VERSION } from "./common.ts";
import { Context, noticeText, type ContextIo, type Notice } from "./context.ts";
import { deploymentCommand } from "./deployment.ts";
import { CliErrorDetailsSchema } from "./errors.ts";
import {
  argumentsAfter,
  contextFlags,
  readStdin,
  resolveTool,
  runGatewayCommand,
} from "./gateway-commands.ts";
import { humanResult, type OutputContext } from "./human.ts";
import {
  builtInEntries,
  builtInHelp,
  commandList,
  commands,
  parse,
  type CommandName,
  type HelpEntry,
  type ParseResult,
} from "./parser.ts";
import { required, resourceCommand } from "./resources.ts";
import type { CommandResult, RenderedResult } from "./results.ts";
import { StateStore } from "./state.ts";
import { supportCommand } from "./support.ts";
import { styleFor, type Style } from "./style.ts";
import { clean, humanToolResult, mentions, toolHelp, usageLine } from "./tool-output.ts";
import { Transport } from "./transport.ts";
import { positive } from "./usage.ts";
import { versionNotice } from "./versions.ts";

/** Anything stdout can be pointed at, including the test suite's own sinks. */
export interface OutputSink {
  write(text: string, callback?: (error?: Error | null) => void): unknown;
}

export interface MainOptions {
  store?: Pick<
    StateStore,
    "read" | "write" | "reserve" | "directory" | "keyOutput" | "vaultKey"
  >;
  transport?: Pick<Transport, "request">;
  stdout?: OutputSink;
  stderr?: OutputSink;
  /** The browser, the loopback listener and the environment; `stderr` is the option above. */
  io?: Partial<Omit<ContextIo, "stderr">>;
  /**
   * Where the gateway's tool list is kept between runs: the cache directory,
   * unless a test hands in a store of its own, which then keeps it in memory.
   */
  catalogCache?: CatalogCache;
  /** Standard input, for an `@-` value. */
  stdin?: () => Promise<string>;
}

type ParsedCommand = Extract<ParseResult, { command: string }>;

/** A tool list kept for the life of one process, for runs that must not touch the cache directory. */
export class MemoryCatalogCache implements CatalogCache {
  private readonly kept = new Map<string, CachedCatalog>();
  async read(url: string): Promise<CachedCatalog | undefined> {
    return this.kept.get(url);
  }
  async write(catalog: CachedCatalog): Promise<void> {
    this.kept.set(catalog.url, catalog);
  }
}

export async function execute(parsed: ParsedCommand, ctx: Context): Promise<CommandResult> {
  const { command, flags, args } = parsed;
  if (command.startsWith("provider"))
    return resourceCommand(ctx, command, args, flags);
  if (command === "app conversations") return conversationsCommand(ctx, args[0] ?? "", flags);
  if (command.startsWith("app ")) return appCommand(ctx, command, args, flags);
  if (command === "support send") return supportCommand(ctx, flags);
  if (command.startsWith("operation "))
    return command === "operation wait"
      ? ctx.wait(args[0] ?? "", positive(flags.timeout ?? 300))
      : ctx.poll(args[0] ?? "");
  if (command === "account login")
    return flags["key-stdin"] || flags["key-prompt"] ? ctx.keyLogin() : ctx.browserLogin();
  if (command === "account claim") return ctx.operation("claim", {});
  if (command === "account logout") return ctx.logout();
  if (command === "deployment connect") {
    const url = flags.cloud
      ? CLOUD
      : origin(
          flags.url ?? (await required(flags, "url", "Deployment HTTPS URL")),
        );
    if (flags["key-stdin"] || flags["key-prompt"]) return ctx.keyLogin(url);
    if (ctx.environmentKey) return ctx.connectWithEnvironment(url);
    return ctx.browserLogin(url);
  }
  if (command === "deployment status") {
    const { data } = await ctx.publicCall("getCliCapabilities");
    return {
      url: ctx.url,
      authenticated: Boolean(ctx.managementKey),
      ...data,
      connected: true,
    };
  }
  return deploymentCommand(ctx, command, flags);
}

const builtIn = (command: string): boolean => Object.hasOwn(commands, command);

/**
 * `--help` for whatever `scope` names: a built-in command, a gateway command,
 * or every command under a group. Gateway commands come from the tool list,
 * so a help asked for while the gateway cannot be reached — and nothing is
 * kept — lists the built-in ones and says so.
 */
async function helpFor(scope: string, catalog: ToolCatalog | undefined, style: Style): Promise<string> {
  if (builtIn(scope)) return builtInHelp(scope as CommandName);
  let list: CachedCatalog | undefined;
  try {
    list = await catalog?.load();
  } catch {
    list = undefined;
  }
  const words = scope ? scope.split(" ") : [];
  const listed = (tools: readonly CliTool[]): HelpEntry[] =>
    tools
      .filter((entry) => !builtIn(entry.cli.command) && missingFeatures(entry).length === 0)
      .filter((entry) => !scope || entry.cli.command === scope || entry.cli.command.startsWith(scope + " "))
      .map((entry) => ({ usage: usageLine(entry), summary: clean(mentions(entry.cli.summary ?? entry.title, tools)) }));
  // Help for a command the kept list does not have looks on the gateway once,
  // as running it would.
  if (list && catalog && words.length && !catalog.fresh && !findTool(list.tools, words, builtIn) && !listed(list.tools).length) {
    list = await catalog.refresh().catch(() => list);
  }
  const tool = list && words.length ? findTool(list.tools, words, builtIn) : undefined;
  if (tool && list) return toolHelp(tool, list.tools, style);
  const entries = [...builtInEntries(scope), ...listed(list?.tools ?? [])];
  if (!entries.length)
    throw new CliError(
      "unknown_command",
      list ? "Unknown help topic." : "Unknown help topic, or a command of a gateway agw could not reach.",
      "Run agw --help to list every command.",
    );
  const text = commandList(entries);
  return list ? text : `${text}\nThe gateway's own commands are listed once agw can reach it.\n`;
}

/** The selected gateway's tool list, asked for with the transport every other request takes. */
function catalogFor(ctx: Context, cache: CatalogCache): ToolCatalog {
  const url = ctx.url;
  return new ToolCatalog(
    {
      url,
      fetchList: async (timeoutMs) =>
        (await ctx.client.transport.request(url, operationPath("listCliTools"), { timeoutMs })).data,
    },
    cache,
  );
}

/** Writes the whole of `text`, waiting for a real stream to take it. */
async function write(stdout: OutputSink, text: string): Promise<void> {
  if (stdout instanceof Writable) {
    await new Promise<void>((resolve, reject) =>
      stdout.write(text, (error) => (error ? reject(error) : resolve())),
    );
  } else {
    // Lightweight injected sinks are synchronous; real streams acknowledge flush.
    stdout.write(text);
  }
}

function outputContext(ctx: Context): OutputContext {
  return {
    url: ctx.url,
    ...(ctx.active?.account?.id === undefined ? {} : { accountId: ctx.active.account.id }),
    ...(ctx.active?.deployment?.id === undefined
      ? {}
      : { deploymentId: ctx.active.deployment.id }),
  };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  {
    store,
    transport = new Transport(),
    stdout = process.stdout,
    stderr = process.stderr,
    io = {},
    catalogCache,
    stdin = readStdin,
  }: MainOptions = {},
): Promise<number> {
  const json = argv.includes("--json");
  const cache = catalogCache ?? (store ? new MemoryCatalogCache() : new FileCatalogCache());
  const states = store ?? new StateStore();
  // What the run noticed, which either envelope carries; empty until a command runs.
  let notices: Notice[] = [];
  // The run's context, once a command has one, and the command it runs: a
  // failure is explained with both.
  let ctx: Context | undefined;
  let command: string | undefined;
  try {
    const parsed = parse(argv);
    if (parsed.version) {
      stdout.write(VERSION + "\n");
      return 0;
    }
    const open = async (): Promise<Context> => {
      const state = await states.read((line) => stderr.write(line + "\n"));
      const context = new Context(states, state, transport, parsed.flags ?? contextFlags(argv), { ...io, stderr });
      notices = context.notices;
      return context;
    };
    if (parsed.help) {
      // Help never fails for want of a readable state: it lists what it can.
      const context = await open().catch(() => undefined);
      await write(stdout, await helpFor(parsed.scope, context && catalogFor(context, cache), styleFor(stdout)));
      return 0;
    }
    ctx = await open();
    if (parsed.words) {
      const catalog = catalogFor(ctx, cache);
      const { tool: resolved } = await resolveTool(catalog, parsed.words);
      command = resolved.cli.command;
      const outcome = await runGatewayCommand(ctx, catalog, resolved, argumentsAfter(resolved, argv), stdin);
      const tool = outcome.tool;
      // The list as it stands now: reading the line or the answer may have refreshed it.
      const list = await catalog.load();
      if ("help" in outcome) {
        await write(stdout, toolHelp(tool, list.tools, styleFor(stdout)));
        return 0;
      }
      const context = outputContext(ctx);
      const text = json
        ? JSON.stringify({
            schemaVersion: 1,
            ok: true,
            context,
            summary: outcome.summary,
            result: outcome.result,
            ...(notices.length ? { notices } : {}),
          }) + "\n"
        : humanToolResult(tool, outcome.summary, outcome.result, list.tools, styleFor(stdout));
      await write(stdout, text);
      return 0;
    }
    command = parsed.command;
    const result = await execute(parsed, ctx);
    const context = outputContext(ctx);
    const rendered: RenderedResult = ctx.onboarding
      ? { ...result, ...ctx.onboarding }
      : result;
    // `notices` only when there is one, so the envelope of an ordinary run is
    // what it has always been.
    const output = {
      schemaVersion: 1,
      ok: true,
      context,
      result: rendered,
      ...(notices.length ? { notices } : {}),
    };
    const text = json
      ? JSON.stringify(output) + "\n"
      : humanResult(parsed.command, rendered, context, styleFor(stdout));
    // No command-wide lock: each state write takes the lock for itself, so a
    // command that waits on a browser handoff for minutes does not hold one.
    await write(stdout, text);
    await ctx.acknowledgeOutput();
    return 0;
  } catch (error) {
    const e =
      error instanceof CliError
        ? error
        : new CliError(
            "internal_error",
            "The command could not complete.",
            "Inspect account/resource status before retrying a mutation.",
            4,
          );
    // Said after the failure, not instead of it: the gateway's own explanation
    // comes first, and a release difference is only a possible cause.
    const mismatch = ctx && command && error instanceof CliError
      ? await versionNotice(ctx, command, error)
      : undefined;
    if (mismatch) notices.push(mismatch);
    // Parsed on the way out for the same reason every response is: only the
    // fields this envelope declares may reach stdout. Fail-closed — details
    // that do not parse are dropped rather than printed, and never turn a
    // reportable failure into a crash inside the reporter.
    const details = e.details ? CliErrorDetailsSchema.safeParse(e.details) : undefined;
    const reported = {
      code: e.code,
      message: e.message,
      nextAction: e.nextAction,
      ...(details?.success ? { details: details.data } : {}),
    };
    if (json) {
      stdout.write(
        JSON.stringify({
          schemaVersion: 1,
          ok: false,
          error: reported,
          ...(notices.length ? { notices } : {}),
        }) + "\n",
      );
      return e.exitCode;
    }
    // Text failures go to stderr, where a shell already expects them: stdout
    // stays clean for the command's own output, so `agw app snippet ... > f`
    // writes a snippet or an empty file, never half a report of a failure.
    // `--json` keeps its one document on stdout, which is what agents read.
    const style = styleFor(stderr);
    const lines = [
      style.alert(`Error: ${e.message}`),
      style.warn(`Next: ${e.nextAction}`),
      style.dim(`Code: ${e.code}`),
    ];
    // Every declared detail field is a string, a number or a boolean, so each
    // one is a line of its own rather than a nested document.
    for (const [key, value] of Object.entries(reported.details ?? {}))
      lines.push(`  ${style.dim(`${key}:`)} ${String(value)}`);
    stderr.write(lines.join("\n") + "\n");
    if (mismatch) stderr.write(noticeText(mismatch, style));
    return e.exitCode;
  }
}
