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

async function build(tools: readonly McpTool[]): Promise<CliToolCatalogResponse> {
  const described = tools.map(describe);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(described)));
  const revision = [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { revision, tools: described };
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
): Promise<{ response: CliToolCallResponse; revision: string }> {
  const tool = offered(caller.scope).find((candidate) => candidate.name === name);
  if (!tool) throw new GatewayError(404, "not_found", `This deployment has no tool named ${name}`);
  const [{ result, summary }, catalog] = await Promise.all([
    runTool(tool, input, caller),
    cliToolCatalog(caller.scope),
  ]);
  return {
    response: { tool: tool.name, summary, result: result as Record<string, unknown> },
    revision: catalog.revision,
  };
}
