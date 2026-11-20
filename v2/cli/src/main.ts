import { Writable } from "node:stream";
import {
  FileCatalogCache,
  findTool,
  missingFeatures,
  ToolCatalog,
  type CachedCatalog,
  type CatalogCache,
  type CliTool,
} from "./catalog.ts";
import { appAdd, appKeyAdd, appUpdate, providerAdd, providerRotateKey, waitFor } from "./commands.ts";
import { operationPath } from "../../src/contracts/catalog.ts";
import { CLOUD, CliError, origin, VERSION } from "./common.ts";
import { Context, type ContextIo, type Notice } from "./context.ts";
import { CliErrorDetailsSchema } from "./errors.ts";
import {
  argumentsAfter,
  contextFlags,
  readStdin,
  resolveTool,
  runGatewayCommand,
} from "./gateway-commands.ts";
import { humanResult, type OutputContext } from "./human.ts";
import { refuseOlderGateway } from "./oauth.ts";
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
import type { CommandResult, DeploymentStatusResult } from "./results.ts";
import { StateStore } from "./state.ts";
import { styleFor, type Style } from "./style.ts";
import { clean, humanToolResult, mentions, toolHelp, usageLine } from "./tool-output.ts";
import { Transport } from "./transport.ts";

/** Anything stdout can be pointed at, including the test suite's own sinks. */
export interface OutputSink {
  write(text: string, callback?: (error?: Error | null) => void): unknown;
}

export interface MainOptions {
  store?: Pick<StateStore, "read" | "update" | "keyOutput" | "handoffFile">;
  transport?: Pick<Transport, "request" | "postForm">;
  stdout?: OutputSink;
  stderr?: OutputSink;
  /** The browser, the loopback listener, the clock and the environment; `stderr` is the option above. */
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

/** The required positional argument a parsed command carries. */
const first = (args: readonly string[]): string => args[0] ?? "";

/** `agw deployment status`: the selected gateway, and who commands run as. */
async function deploymentStatus(ctx: Context): Promise<DeploymentStatusResult> {
  const credential = ctx.environmentKey ? "environment" : ctx.active?.login ? "oauth" : null;
  const base: DeploymentStatusResult = { url: ctx.url, connected: true, credential, signedIn: false };
  if (!credential) {
    await ctx.checkGateway();
    return base;
  }
  try {
    return { ...base, signedIn: true, ...(await ctx.session()) };
  } catch (error) {
    // A sign-in that ended is "not signed in"; a refused AGW_MANAGEMENT_KEY is an error to fix.
    const ended = error instanceof CliError && (error.code === "login_required" || error.details?.status === 401);
    if (credential === "oauth" && ended) return base;
    throw error;
  }
}

export async function execute(parsed: ParsedCommand, ctx: Context): Promise<CommandResult> {
  const { command, flags, args } = parsed;
  switch (command) {
    case "deployment connect":
      if (!flags.cloud && flags.url === undefined) ctx.say(`Connecting to the hosted gateway, ${CLOUD}. Use --url for your own.`);
      return ctx.connect(flags.cloud ? CLOUD : origin(flags.url ?? CLOUD));
    case "deployment status":
      return deploymentStatus(ctx);
    case "account login":
      return ctx.login();
    case "account logout":
      return ctx.logout();
    case "provider add":
      return providerAdd(ctx, flags);
    case "provider rotate-key":
      return providerRotateKey(ctx, first(args), flags);
    case "app add":
      return appAdd(ctx, flags);
    case "app key add":
      return appKeyAdd(ctx, first(args), flags);
    case "app update":
      return appUpdate(ctx, first(args), flags);
    case "operation wait": {
      const seconds = flags.timeout === undefined ? 300 : Number(flags.timeout);
      if (!Number.isInteger(seconds) || seconds < 1) throw new CliError("invalid_input", "--timeout must be a whole number of seconds.");
      return waitFor(ctx, first(args), seconds);
    }
  }
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
  if (
    list && catalog && words.length && !catalog.fresh &&
    !findTool(list.tools, words, builtIn) && !listed(list.tools).length && !builtInEntries(scope).length
  ) {
    list = await catalog.refresh().catch(() => list);
  }
  const tool = list && words.length ? findTool(list.tools, words, builtIn) : undefined;
  if (tool && list) {
    const help = toolHelp(tool, list.tools, style);
    return missingFeatures(tool).length === 0
      ? help
      : `${style.warn(`This command needs a newer agw than ${VERSION}: npm install -g @maxceem/agw`)}\n\n${help}`;
  }
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
      onMissing: () => refuseOlderGateway(ctx.client.transport, url),
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

/**
 * Where a result came from. The stored account describes the stored sign-in,
 * so it is named only for a command that ran as that sign-in, not as
 * `AGW_MANAGEMENT_KEY`.
 */
function outputContext(ctx: Context): OutputContext {
  const account = ctx.environmentKey ? undefined : ctx.active?.account?.id;
  return { url: ctx.url, ...(account === undefined ? {} : { accountId: account }) };
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
  let ctx: Context | undefined;
  try {
    const parsed = parse(argv);
    if (parsed.version) {
      stdout.write(VERSION + "\n");
      return 0;
    }
    const open = async (): Promise<Context> => {
      const state = await states.read();
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
      const outcome = await runGatewayCommand(ctx, catalog, resolved, argumentsAfter(resolved, argv), stdin);
      const tool = outcome.tool;
      // The list as it stands now: reading the line or the answer may have refreshed it.
      const list = await catalog.load();
      if ("help" in outcome) {
        await write(stdout, toolHelp(tool, list.tools, styleFor(stdout)));
        return 0;
      }
      const context = outputContext(ctx);
      // The result is printed as the gateway answered it, with no schema of
      // this release's to drop fields by: what keeps a credential out of it is
      // the gateway, which redacts every value named like one before any tool
      // answers (`src/mcp/run.ts`).
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
      // Only now, with the result written: a gateway that changed costs the
      // next run a fresh list, never this run its output.
      await catalog.observe(outcome.revision);
      return 0;
    }
    const result = await execute(parsed, ctx);
    const context = outputContext(ctx);
    const rendered = result;
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
    return 0;
  } catch (error) {
    const e =
      error instanceof CliError
        ? error
        : new CliError(
            "internal_error",
            "The command could not complete.",
            "Check what the command changed before running it again.",
            4,
          );
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
    // stays clean for the command's own output, so redirecting it never
    // writes half a report of a failure.
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
    return e.exitCode;
  }
}
