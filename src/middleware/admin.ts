import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { GatewayError } from "../core/errors";
import {
  CONSOLE_COOKIE,
  CONSOLE_REQUEST_HEADER,
  verifyConsoleSession,
  type ConsoleSession,
} from "../core/session";

export interface AdminVariables {
  adminAuthMethod: "token" | "session";
  consoleSession?: ConsoleSession;
}

export async function secureEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const left = new Uint8Array(aHash);
  const right = new Uint8Array(bHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export function bearerToken(header: string | undefined): string {
  const value = header ?? "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

export const adminAuth: MiddlewareHandler<{ Bindings: Env; Variables: AdminVariables }> = async (
  c,
  next,
) => {
  const token = bearerToken(c.req.header("authorization"));
  if (token) {
    if (!(await secureEqual(token, c.env.ADMIN_TOKEN))) {
      throw new GatewayError(401, "auth_required", "A valid admin token is required");
    }
    c.set("adminAuthMethod", "token");
    await next();
    return;
  }

  const cookie = getCookie(c, CONSOLE_COOKIE);
  if (!cookie) {
    throw new GatewayError(401, "auth_required", "A valid admin token is required");
  }
  // SameSite=Strict already blocks cross-site sends; also requiring a header that
  // a cross-origin form post cannot set keeps the cookie useless outside fetch.
  if (c.req.header(CONSOLE_REQUEST_HEADER) !== "1") {
    throw new GatewayError(401, "auth_required", "Console requests must set the console request header");
  }
  const session = await verifyConsoleSession(cookie, c.env.JWT_SECRET);
  c.set("adminAuthMethod", "session");
  c.set("consoleSession", session);
  await next();
};
