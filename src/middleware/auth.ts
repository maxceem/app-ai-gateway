import type { MiddlewareHandler } from "hono";
import { assertAppActive, endUserHeader, endUserIssuer, loadAppConfig } from "../core/config";
import { verifyApiKey } from "../core/apikeys";
import { GatewayError } from "../core/errors";
import { verifyGatewayToken } from "../core/jwt";
import { organizationProviders } from "../core/provider-store";
import { PROVIDER_REGISTRY, PROVIDER_SLUG_PATTERN } from "../core/providers";
import { lookup } from "../core/records";
import type { AppConfig, GatewayIdentity, ProviderType } from "../core/types";
import type { BillingVariables } from "../billing/gateway";

export interface GatewayVariables extends BillingVariables {
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
  provider: ProviderType | undefined,
  customHeader: string | undefined,
): { token: string; headerName: string } {
  const candidates: string[] = ["authorization"];
  if (provider) candidates.push(PROVIDER_REGISTRY[provider].auth.header);
  if (customHeader && !candidates.includes(customHeader.toLowerCase())) candidates.push(customHeader.toLowerCase());
  for (const name of candidates) {
    const token = tokenFromHeader(headers.get(name) ?? undefined);
    if (token) return { token, headerName: name };
  }
  throw new GatewayError(401, "auth_required", "A gateway access token is required");
}

/**
 * The end-user id an application asked its backend to send. Required whenever a
 * header source is configured: choosing one is the operator saying this
 * application has users, and accepting a request without one would file that
 * traffic under nobody while per-user limits and blocks quietly stopped
 * applying to it.
 */
function requiredEndUserId(headers: Headers, header: string): string {
  const value = headers.get(header);
  if (value === null) {
    throw new GatewayError(400, "invalid_request", `${header} is required`);
  }
  if (!/^[\x21-\x7e]{1,128}$/u.test(value)) {
    throw new GatewayError(
      400,
      "invalid_request",
      `${header} must be 1-128 printable ASCII characters`,
    );
  }
  return value;
}

export const gatewayAuth: MiddlewareHandler<{ Bindings: Env; Variables: GatewayVariables }> = async (c, next) => {
  const start = performance.now();
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadAppConfig(c.env, appId);
  assertAppActive(app);
  const rawProvider = c.req.param("provider");
  const provider = typeof rawProvider === "string" && PROVIDER_SLUG_PATTERN.test(rawProvider)
    ? lookup(await organizationProviders(c.env, app.organizationId), rawProvider)?.type
    : undefined;
  const credential = extractGatewayToken(
    c.req.raw.headers,
    provider,
    endUserIssuer(app.authentication)?.token_header,
  );
  /*
   * How the client proved itself and who it acts for are two different
   * questions, so they are answered separately. The credential above settles the
   * first; `end_user` settles the second, and only a header-sourced identity is
   * read from the request at all — an issuer-sourced or app-install one was
   * settled when the gateway token was minted, and is carried in its subject.
   */
  const header = endUserHeader(app.authentication);
  let identity: GatewayIdentity;
  if (header !== undefined) {
    identity = await verifyApiKey(
      credential.token,
      c.env,
      appId,
      requiredEndUserId(c.req.raw.headers, header),
    );
  } else if (app.authentication.type === "api_key" && app.authentication.end_user === undefined) {
    // No end users: the key is the whole identity, and `null` says so rather
    // than standing in for a user that does not exist.
    identity = await verifyApiKey(credential.token, c.env, appId, null);
  } else {
    identity = await verifyGatewayToken(credential.token, c.env.JWT_SECRET, appId);
  }
  c.set("appConfig", app);
  c.set("identity", identity);
  c.set("authHeaderName", credential.headerName);
  c.set("authDurationMs", performance.now() - start);
  await next();
};
