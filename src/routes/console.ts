import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { GatewayError } from "../core/errors";
import {
  CONSOLE_COOKIE,
  CONSOLE_SESSION_TTL_SECONDS,
  issueConsoleSession,
  verifyConsoleSession,
} from "../core/session";
import { bearerToken, secureEqual, type AdminVariables } from "../middleware/admin";

export const consoleRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

function cookieOptions(c: { req: { url: string } }, maxAge: number) {
  // Safari refuses Secure cookies over plain http, which `wrangler dev` serves.
  const secure = new URL(c.req.url).protocol === "https:";
  return {
    httpOnly: true,
    secure,
    sameSite: "Strict" as const,
    path: "/",
    maxAge,
  };
}

function environment(env: Env) {
  return {
    environment: env.ENVIRONMENT ?? "production",
    gateway_id: env.CF_AIG_GATEWAY_ID,
  };
}

consoleRoutes.post("/session", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
  const token = typeof body === "object" && body !== null ? (body as Record<string, unknown>).token : undefined;
  if (typeof token !== "string" || token.length === 0 || !(await secureEqual(token, c.env.ADMIN_TOKEN))) {
    throw new GatewayError(401, "auth_required", "A valid admin token is required");
  }
  const session = await issueConsoleSession(c.env.JWT_SECRET);
  setCookie(c, CONSOLE_COOKIE, session.token, cookieOptions(c, CONSOLE_SESSION_TTL_SECONDS));
  return c.json({ authenticated: true, expires_at: session.expiresAt, ...environment(c.env) });
});

consoleRoutes.get("/session", async (c) => {
  const token = bearerToken(c.req.header("authorization"));
  if (token) {
    if (!(await secureEqual(token, c.env.ADMIN_TOKEN))) {
      throw new GatewayError(401, "auth_required", "A valid admin token is required");
    }
    return c.json({ authenticated: true, expires_at: null, ...environment(c.env) });
  }
  const cookie = getCookie(c, CONSOLE_COOKIE);
  if (!cookie) throw new GatewayError(401, "auth_required", "A valid console session is required");
  const session = await verifyConsoleSession(cookie, c.env.JWT_SECRET);
  return c.json({ authenticated: true, expires_at: session.expiresAt, ...environment(c.env) });
});

consoleRoutes.delete("/session", (c) => {
  deleteCookie(c, CONSOLE_COOKIE, cookieOptions(c, 0));
  return c.json({ authenticated: false });
});
