import { Hono, type Context } from "hono";
import { clientOf, endingOf, recordManagementCall, refusalOf, type CallEnding } from "../analytics/management";
import { asGatewayAuthError, isCfAuthError } from "../auth/identity";
import { ROUTE_NOT_FOUND } from "../core/errors";
import { requestIdOf } from "../core/request-id";
import { authenticateMcp } from "../mcp/auth";
import { consoleHost, originDecision } from "../mcp/origin";
import { jsonRpcRefusal } from "../mcp/refusal";
import { serveMcp } from "../mcp/server";
import { presentedCredential } from "../middleware/management-analytics";
import { requestScope, type RequestVariables } from "../middleware/request-scope";
import { managementScope } from "./admin/body";

type McpEnv = { Bindings: Env; Variables: RequestVariables };

/**
 * The MCP endpoint, `/mcp` on the console host, as an app the entry module
 * mounts lazily through `./lazy` — so the tool table, the operation catalog
 * behind it and the MCP SDK behind that are evaluated by the first MCP request
 * in an isolate, never by a proxied one.
 *
 * In order: the host has to be the console's (404 otherwise, as the endpoint is
 * not there), the browser origin has to be one it serves (403), a preflight is
 * answered here, and then the bearer gate (401) hands the caller to the server.
 * A listed browser origin gets its CORS headers on every answer after the
 * origin check, refusals included, so a browser client can read why it was
 * refused.
 */
export const mcpRoutes = new Hono<McpEnv>();

// An app of its own with its own `Context`, like the management app, so the
// request scope is opened again here.
mcpRoutes.use("*", requestScope);

mcpRoutes.all("/mcp", async (c) => {
  const deployment = c.get("deployment");
  if (!consoleHost(c.req.raw, deployment)) return c.json(ROUTE_NOT_FOUND, 404);
  const origin = originDecision(c.req.header("origin") ?? null, deployment);
  if (!origin.allowed) return jsonRpcRefusal(403, "This origin may not call the MCP endpoint");
  const answer = await (async () => {
    if (c.req.method === "OPTIONS") return new Response(null, { status: 204 });
    const started = Date.now();
    let auth: Awaited<ReturnType<typeof authenticateMcp>>;
    try {
      auth = await authenticateMcp(c);
    } catch (error) {
      // A gate that failed rather than refused — the database unreachable, say —
      // is answered by the entry module, and counted here as what it answers.
      recordGateRefusal(c, refusalOf(isCfAuthError(error) ? asGatewayAuthError(error) : error), started);
      throw error;
    }
    if (auth instanceof Response) {
      recordGateRefusal(c, { ...endingOf(auth.status), code: "auth_required" }, started);
      return auth;
    }
    return serveMcp(c.req.raw, { scope: managementScope(c), auth });
  })();
  if (origin.cors === null) return answer;
  // A fresh response, since one the SDK built may have immutable headers.
  const response = new Response(answer.body, answer);
  for (const [name, value] of Object.entries(origin.cors)) response.headers.set(name, value);
  return response;
});

/**
 * A call the bearer gate refused or failed on, for management analytics: no
 * tool ran and no account is known, only the credential it presented. A tool
 * call that got through is recorded by the server, per tool.
 */
function recordGateRefusal(c: Context<McpEnv>, ending: CallEnding, started: number): void {
  if (c.env.MANAGEMENT_ANALYTICS === undefined) return;
  const userAgent = c.req.header("user-agent");
  recordManagementCall(c.env, {
    accountId: null,
    channel: "mcp",
    credential: presentedCredential(c),
    identity: null,
    operation: null,
    tool: null,
    kind: null,
    ...ending,
    client: clientOf(userAgent),
    clientVersion: null,
    requestId: requestIdOf(c.req.header("cf-ray")),
    durationMs: Date.now() - started,
  });
}

mcpRoutes.notFound((c) => c.json(ROUTE_NOT_FOUND, 404));

/**
 * As in the management app: a cf-auth rejection becomes the gateway's own
 * error, and the entry module formats and logs whatever is rethrown.
 */
mcpRoutes.onError((error) => {
  throw isCfAuthError(error) ? asGatewayAuthError(error) : error;
});
