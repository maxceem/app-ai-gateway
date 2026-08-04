import type { MiddlewareHandler } from "hono";
import { assertAppActive, loadAppConfig } from "../core/config";
import { verifyApiKey } from "../core/apikeys";
import { GatewayError } from "../core/errors";
import { verifyGatewayToken } from "../core/jwt";
import type { AppConfig, GatewayIdentity, Provider } from "../core/types";

export interface GatewayVariables {
  appConfig: AppConfig;
  identity: GatewayIdentity;
  authHeaderName: string;
  authDurationMs: number;
  limiterDurationMs: number;
}

function tokenFromHeader(value: string | undefined): string | null {
  if (!value) return null;
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : value.trim();
}

export function extractGatewayToken(
  headers: Headers,
  provider: Provider | undefined,
  customHeader: string | undefined,
): { token: string; headerName: string } {
  const candidates: string[] = ["authorization"];
  if (provider === "anthropic") candidates.push("x-api-key");
  if (provider === "gemini") candidates.push("x-goog-api-key");
  if (customHeader && !candidates.includes(customHeader.toLowerCase())) candidates.push(customHeader.toLowerCase());
  for (const name of candidates) {
    const token = tokenFromHeader(headers.get(name) ?? undefined);
    if (token) return { token, headerName: name };
  }
  throw new GatewayError(401, "auth_required", "A gateway access token is required");
}

export const gatewayAuth: MiddlewareHandler<{ Bindings: Env; Variables: GatewayVariables }> = async (c, next) => {
  const start = performance.now();
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadAppConfig(c.env, appId);
  assertAppActive(app);
  const rawProvider = c.req.param("provider");
  const provider = typeof rawProvider === "string" && ["openai", "anthropic", "xai", "gemini", "perplexity"].includes(rawProvider)
    ? (rawProvider as Provider)
    : undefined;
  const credential = extractGatewayToken(
    c.req.raw.headers,
    provider,
    app.authentication.type === "apple_app_attest"
      ? app.authentication.issuer.token_header
      : undefined,
  );
  let identity: GatewayIdentity;
  if (app.authentication.type === "api_key") {
    const hasEndUserId = c.req.raw.headers.has("x-end-user-id");
    const endUserId = c.req.header("x-end-user-id") ?? null;
    if (hasEndUserId && (endUserId === null || !/^[\x21-\x7e]{1,128}$/u.test(endUserId))) {
      throw new GatewayError(
        400,
        "invalid_request",
        "X-End-User-Id must be 1-128 printable ASCII characters",
      );
    }
    if (app.authentication.end_user.required && endUserId === null) {
      throw new GatewayError(400, "invalid_request", "X-End-User-Id is required");
    }
    identity = await verifyApiKey(credential.token, c.env, appId, endUserId);
  } else {
    identity = await verifyGatewayToken(credential.token, c.env.JWT_SECRET, appId);
  }
  c.set("appConfig", app);
  c.set("identity", identity);
  c.set("authHeaderName", credential.headerName);
  c.set("authDurationMs", performance.now() - start);
  await next();
};
