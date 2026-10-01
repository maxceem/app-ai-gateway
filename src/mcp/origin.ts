import type { Deployment } from "../policy/deployment";

/**
 * Where the MCP endpoint may be called from.
 *
 * The endpoint takes a bearer credential and never a cookie, so a page that
 * has none cannot act through it; what this adds is the rule every MCP server
 * reachable from a browser is asked to keep. The host has to be the console's
 * own, so a name pointed at this Worker for another purpose does not serve it.
 * An `Origin` is judged exactly — scheme, host and port — because a browser
 * sends the page's origin verbatim:
 *
 * - absent: a non-browser client, which is what almost every MCP client is;
 * - the console's own origin: a same-origin request, which needs no CORS;
 * - listed in `MCP_ALLOWED_ORIGINS`: a browser-based client the deployment
 *   chose to trust, answered with CORS headers and a preflight;
 * - anything else, `null` included: refused.
 *
 * Nothing here imports the MCP SDK. Its own helpers compare hostnames only,
 * port-agnostic and scheme-agnostic, which is looser than this needs.
 */

/**
 * The request's host is the console's own. The URL is the one the Worker was
 * asked for, so its host is the `Host` header.
 *
 * With `CLI_CONSOLE_ORIGIN` unset, the console's origin is the request's own —
 * the default the rest of the gateway shares — so every host passes and only
 * the `PUBLIC_API_URL` host is refused, by the entry module. The guides
 * recommend setting it on a deployment reachable through more than one name.
 */
export function consoleHost(request: Request, deployment: Deployment): boolean {
  return new URL(request.url).host === new URL(deployment.consoleOrigin()).host;
}

export type OriginDecision =
  /** `cors` is null for a request that needs none: no origin, or the console's own. */
  | { allowed: true; cors: Record<string, string> | null }
  | { allowed: false };

export function originDecision(origin: string | null, deployment: Deployment): OriginDecision {
  if (origin === null || origin === "") return { allowed: true, cors: null };
  if (origin === deployment.consoleOrigin()) return { allowed: true, cors: null };
  if (deployment.mcp.allowedOrigins.includes(origin)) return { allowed: true, cors: corsHeaders(origin) };
  return { allowed: false };
}

/**
 * What a listed browser origin is told, on its preflight and on every answer
 * after it. `Vary: Origin` because the value depends on who asked.
 *
 * `Mcp-Method` and `Mcp-Name` are there because the 2026-07-28 revision
 * requires them on a request (SEP-2243): the SDK refuses a modern request
 * without `Mcp-Method`, and a `tools/call` or `resources/read` without
 * `Mcp-Name`, so a browser client could not send one if its preflight left
 * them out.
 */
function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
    Vary: "Origin",
  };
}
