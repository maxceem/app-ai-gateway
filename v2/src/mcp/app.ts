/**
 * The MCP endpoint, `/v2/mcp`, as an app the entry module mounts lazily, so
 * the tool table and the MCP SDK are evaluated by the first MCP request in an
 * isolate, never by a provider request (v1's `src/routes/mcp.ts`, ported).
 *
 * In order:
 * 1. The host must be the console's (404 otherwise). Without `CONSOLE_ORIGIN`,
 *    any secure host serves it (503 on an insecure one), with management keys
 *    only, since there is no OAuth. A `CONSOLE_ORIGIN` that is not valid
 *    answers 503.
 * 2. The browser origin must be one it serves (403).
 * 3. A preflight is answered here.
 * 4. The bearer gate (401) hands the caller to the server.
 *
 * A listed browser origin gets its CORS headers on every answer after the
 * origin check, refusals included, so a browser client can read why.
 */
import type { CfAuth } from "@maxceem/cf-auth";
import { Hono, type ExecutionContext as HonoExecutionContext } from "hono";
import { gatewayErrorOf } from "../auth/identity.ts";
import { allowedBrowserOrigins, consoleOrigin, secureOrigin, setting } from "../auth/settings.ts";
import { GatewayError } from "../core/errors.ts";
import { authenticateMcp } from "./auth.ts";
import { jsonRpcRefusal } from "./refusal.ts";
import { serveMcp } from "./server.ts";

type McpEnv = { Bindings: Env; Variables: { identity: Promise<CfAuth> } };

export const MCP_PATH = "/v2/mcp";

const NOT_FOUND = { error: { code: "not_found", message: "Nothing is served at this path." } };

/**
 * What a listed browser origin is told. `Mcp-Method` and `Mcp-Name` are
 * there because the 2026-07-28 revision requires them on a request, so a
 * browser client could not send one if its preflight left them out.
 */
function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
    "Access-Control-Expose-Headers": "WWW-Authenticate",
    Vary: "Origin",
  };
}

const app = new Hono<McpEnv>();

app.all(MCP_PATH, async (c) => {
  const own = new URL(c.req.url).origin;
  const configured = consoleOrigin(c.env);
  // Without a console origin, the request's own is used, and it must be a
  // secure one. A console origin that is set but not valid is refused, never
  // replaced with the request's own (v1's rules, and its answer).
  if (configured === null && (setting(c.env, "CONSOLE_ORIGIN") !== undefined || !secureOrigin(new URL(c.req.url)))) {
    throw new GatewayError(503, "invalid_request", "Configure a secure console origin");
  }
  const consoleAt = configured ?? own;
  if (own !== consoleAt) return c.json(NOT_FOUND, 404);
  // An origin is judged exactly: absent (not a browser), the console's own,
  // or one `MCP_ALLOWED_ORIGINS` lists. Anything else, `null` included, is refused.
  const origin = c.req.header("origin") ?? "";
  let cors: Record<string, string> | null = null;
  if (origin !== "" && origin !== consoleAt) {
    if (!allowedBrowserOrigins(c.env).includes(origin)) return jsonRpcRefusal(403, "This origin may not call the MCP endpoint");
    cors = corsHeaders(origin);
  }
  const answer = await (async () => {
    if (c.req.method === "OPTIONS") return new Response(null, { status: 204 });
    const auth = await authenticateMcp(c);
    if (auth instanceof Response) return auth;
    let executionCtx: HonoExecutionContext | undefined;
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = undefined;
    }
    return serveMcp(c.req.raw, { ...auth, env: c.env, origin: own, ...(executionCtx === undefined ? {} : { executionCtx }) });
  })();
  if (cors === null) return answer;
  // A fresh response, since one the SDK built may have immutable headers.
  const response = new Response(answer.body, answer);
  for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
  return response;
});

app.notFound((c) => c.json(NOT_FOUND, 404));

/** A cf-auth refusal becomes the gateway's own error; the entry module formats it. */
app.onError((error) => {
  throw gatewayErrorOf(error);
});

export default app;
