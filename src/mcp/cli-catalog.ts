import { z } from "zod";
import type { CliTool, CliToolCallResponse, CliToolCatalogResponse } from "../contracts/cli";
import { GatewayError } from "../core/errors";
import type { OperationCaller } from "../management/executor";
import type { ManagementScope } from "../management/scope";
import { CLI_HINTS, fallbackHint } from "./cli-hints";
import { runTool } from "./run";
import { MCP_TOOLS, type McpTool } from "./tools";

/**
 * The MCP tools as `agw` builds its commands from them, and a call of one.
 *
 * Reached only through a dynamic import from the CLI routes, so the tool
 * table is evaluated by the first request that asks for it, never by any
 * other management request.
 */

/** The header every tool call answers with, so a CLI holding another revision refreshes. */
export const TOOLS_REVISION_HEADER = "Agw-Tools-Revision";

/** The tools this deployment offers, which `tools/list` would list for it. */
function offered(scope: ManagementScope): McpTool[] {
  return MCP_TOOLS.filter((tool) => !tool.available || tool.available(scope));
}

function describe(tool: McpTool): CliTool {
  const hint = CLI_HINTS[tool.name] ?? fallbackHint(tool.name);
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    // The same document MCP's `tools/list` advertises for the tool.
    inputSchema: z.toJSONSchema(tool.input, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>,
    annotations: { ...tool.annotations },
    cli: tool.shortcuts?.length ? { ...hint, shortcuts: [...tool.shortcuts] } : hint,
  };
}

/**
 * One catalog per set of offered tools, which is fixed for the life of a
 * deployment: the tables are code, and availability is the deployment's.
 */
const built = new Map<string, Promise<CliToolCatalogResponse>>();

export function cliToolCatalog(scope: ManagementScope): Promise<CliToolCatalogResponse> {
  const tools = offered(scope);
  const key = tools.map((tool) => tool.name).join(",");
  let catalog = built.get(key);
  if (!catalog) {
    catalog = build(tools).catch((error: unknown) => {
      built.delete(key);
      throw error;
    });
    built.set(key, catalog);
  }
  return catalog;
}

async function hex(text: string, bytes: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The part of a tool a CLI must not hold an outdated copy of when it runs it:
 * whether it destroys, and what it needs of the CLI. A description, an added
 * optional argument or a new view leaves it as it is.
 */
function guardOf(tool: CliTool): string {
  return JSON.stringify({ destructive: tool.annotations.destructiveHint === true, requires: [...(tool.cli.requires ?? [])].sort() });
}

async function build(tools: readonly McpTool[]): Promise<CliToolCatalogResponse> {
  const described = await Promise.all(tools.map(async (tool) => {
    const entry = describe(tool);
    return { ...entry, guard: await hex(guardOf(entry), 6) };
  }));
  return { revision: await hex(JSON.stringify(described), 8), tools: described };
}

/**
 * Runs one tool for the CLI: the tool the deployment offers by that name,
 * with its arguments exactly as sent, through {@link runTool} — the same path
 * an MCP `tools/call` takes, refusals included, which are thrown for the
 * HTTP surface to answer as errors.
 */
export async function callCliTool(
  name: string,
  input: Record<string, unknown>,
  caller: OperationCaller,
  /** The tool's `guard` in the caller's list, when it sent one. */
  guard?: string,
): Promise<{ response: CliToolCallResponse; revision: string }> {
  const { revision, tools } = await cliToolCatalog(caller.scope);
  try {
    const tool = offered(caller.scope).find((candidate) => candidate.name === name);
    if (!tool) throw new GatewayError(404, "tool_not_found", `This deployment has no tool named ${name}`);
    const current = tools.find((entry) => entry.name === name)?.guard;
    if (guard !== undefined && current !== undefined && guard !== current) {
      throw new GatewayError(409, "tool_changed", `${name} has changed in a way that needs a fresh look before it runs; nothing ran`);
    }
    // An argument the tool no longer takes would otherwise be dropped on the
    // way to its operation, and the call run without it: a renamed filter,
    // say. Refused instead, and the revision tells the CLI to read the list.
    const unknown = Object.keys(input).find((key) => !Object.hasOwn(tool.input.shape, key));
    if (unknown !== undefined) {
      throw new GatewayError(400, "invalid_request", `${unknown}: not an argument of ${name}; nothing ran`);
    }
    const { result, summary } = await runTool(tool, input, caller);
    return { response: { tool: tool.name, summary, result: result as Record<string, unknown> }, revision };
  } catch (error) {
    // A refusal carries the revision too: one caused by an out-of-date list is
    // exactly the answer that should make a CLI fetch it again.
    if (!(error instanceof GatewayError)) throw error;
    throw new GatewayError(
      error.status,
      error.code,
      error.message,
      { ...Object.fromEntries(new Headers(error.headers)), [TOOLS_REVISION_HEADER]: revision },
      { reason: error.reason, userId: error.userId, data: error.data, field: error.field, cause: error.cause },
    );
  }
}
