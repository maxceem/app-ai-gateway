import { Hono } from "hono";
import { asGatewayAuthError, isCfAuthError } from "../auth/identity";
import { ROUTE_NOT_FOUND } from "../core/errors";
import { authenticateMcp } from "../mcp/auth";
import { consoleHost, originDecision } from "../mcp/origin";
import { jsonRpcRefusal } from "../mcp/refusal";
import { serveMcp } from "../mcp/server";
import { requestScope, type RequestVariables } from "../middleware/request-scope";
import { managementScope } from "./admin/body";

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
export const mcpRoutes = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

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
    const auth = await authenticateMcp(c);
    if (auth instanceof Response) return auth;
    return serveMcp(c.req.raw, { scope: managementScope(c), auth });
  })();
  if (origin.cors === null) return answer;
  // A fresh response, since one the SDK built may have immutable headers.
  const response = new Response(answer.body, answer);
  for (const [name, value] of Object.entries(origin.cors)) response.headers.set(name, value);
  return response;
});

mcpRoutes.notFound((c) => c.json(ROUTE_NOT_FOUND, 404));

/**
 * As in the management app: a cf-auth rejection becomes the gateway's own
 * error, and the entry module formats and logs whatever is rethrown.
 */
mcpRoutes.onError((error) => {
  throw isCfAuthError(error) ? asGatewayAuthError(error) : error;
});
