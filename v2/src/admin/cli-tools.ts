/**
 * The CLI's tool catalog over HTTP: the MCP tools `agw` builds its commands
 * from, and a call of one (v1's `/v1/cli/tools`, ported).
 *
 * The tool code is imported on first use, so no other management request
 * evaluates the tool table.
 */
import type { Context, ExecutionContext as HonoExecutionContext } from "hono";
import { CliToolCallRequestSchema } from "../contracts/cli.ts";
import type { AdminVariables } from "./actor.ts";
import { parseBody } from "./apps.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

/** The list is the same for every caller of one deployment, so it needs no credential. */
export async function listCliTools(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { cliToolCatalog } = await import("../mcp/cli-catalog.ts");
  return c.json(await cliToolCatalog(c.env));
}

/**
 * Runs one tool as the caller. A read needs any credential; a change needs
 * what that change needs over the API. A refusal is an HTTP error with the
 * gateway's code. Every answer carries the catalog's revision.
 */
export async function callCliTool(c: AdminContext): Promise<Response> {
  const input = await parseBody(c, CliToolCallRequestSchema);
  const { callCliTool: call, TOOLS_REVISION_HEADER } = await import("../mcp/cli-catalog.ts");
  let executionCtx: HonoExecutionContext | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = undefined;
  }
  const { response, revision } = await call(
    c.req.param("tool") ?? "",
    input,
    {
      state: c.get("authState"),
      actor: c.get("actor"),
      identity: c.get("identity"),
      env: c.env,
      origin: new URL(c.req.url).origin,
      ...(executionCtx === undefined ? {} : { executionCtx }),
    },
    c.req.header("agw-tool-guard"),
  );
  return c.json(response, 200, { [TOOLS_REVISION_HEADER]: revision });
}
