/**
 * The MCP tools as `agw` builds its commands from them, and a call of one
 * (v1's, ported). Reached only through a dynamic import from the CLI routes,
 * so the tool table is evaluated by the first request that asks for it.
 */
import { z } from "zod";
import type { CliTool, CliToolCallResponse, CliToolCatalogResponse } from "../contracts/cli.ts";
import { GatewayError } from "../core/errors.ts";
import { runTool, type ToolCaller } from "./run.ts";
import { toolsFor, type McpTool } from "./tools.ts";

/** The header every tool call answers with, so a CLI holding another revision refreshes. */
export const TOOLS_REVISION_HEADER = "Agw-Tools-Revision";

function describe(tool: McpTool): CliTool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    // The same document MCP's `tools/list` advertises for the tool.
    inputSchema: z.toJSONSchema(tool.input, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>,
    annotations: { ...tool.annotations },
    cli: tool.cli,
  };
}

async function hex(text: string, bytes: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The part of a tool a CLI must not hold an outdated copy of when it runs it:
 * whether it destroys, and what it needs of the CLI. A new description, an
 * added optional argument or a new view leaves it as it is.
 */
function guardOf(tool: CliTool): string {
  return JSON.stringify({ destructive: tool.annotations.destructiveHint === true, requires: [...(tool.cli.requires ?? [])].sort() });
}

/**
 * Built once per isolate for each set of tools a deployment offers: the table
 * is code, and only what the environment binds (a help desk) changes the set.
 * A failed build is forgotten.
 */
const built = new Map<string, Promise<CliToolCatalogResponse>>();

export function cliToolCatalog(env: Env, offered: readonly McpTool[] = toolsFor(env)): Promise<CliToolCatalogResponse> {
  const key = offered.map((tool) => tool.name).join(",");
  const cached = built.get(key);
  if (cached !== undefined) return cached;
  const building = (async () => {
    const tools = await Promise.all(
      offered.map(async (tool) => {
        const entry = describe(tool);
        return { ...entry, guard: await hex(guardOf(entry), 6) };
      }),
    );
    return { revision: await hex(JSON.stringify(tools), 8), tools };
  })().catch((error: unknown) => {
    built.delete(key);
    throw error;
  });
  built.set(key, building);
  return building;
}

/**
 * Runs one tool for the CLI, through {@link runTool}: the same path an MCP
 * `tools/call` takes. A refusal is thrown for the HTTP surface to answer, and
 * carries the catalog's revision, since one caused by an outdated list is
 * exactly the answer that should make a CLI fetch it again.
 */
export async function callCliTool(
  name: string,
  input: Record<string, unknown>,
  caller: ToolCaller,
  /** The tool's `guard` in the caller's list, when it sent one. */
  guard?: string,
): Promise<{ response: CliToolCallResponse; revision: string }> {
  const offered = toolsFor(caller.env);
  const { revision, tools } = await cliToolCatalog(caller.env, offered);
  try {
    const tool = offered.find((candidate) => candidate.name === name);
    if (!tool) throw new GatewayError(404, "tool_not_found", `This deployment has no tool named ${name}`);
    const current = tools.find((entry) => entry.name === name)?.guard;
    if (guard !== undefined && current !== undefined && guard !== current) {
      throw new GatewayError(409, "tool_changed", `${name} has changed in a way that needs a fresh look before it runs; nothing ran`);
    }
    const { result, summary } = await runTool(tool, input, caller);
    return { response: { tool: tool.name, summary, result: result as Record<string, unknown> }, revision };
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    const headers = new Headers(error.headers);
    headers.set(TOOLS_REVISION_HEADER, revision);
    throw error.withHeaders(headers);
  }
}
