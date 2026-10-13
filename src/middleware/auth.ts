import type { MiddlewareHandler } from "hono";
import { authenticateRequest } from "../client-auth/client-auth";
import { assertAppActive, loadApp } from "../core/app-records";
import { GatewayError } from "../core/errors";
import { readBodyLimited } from "../providers/request-body";
import { noteUnsignedRequest } from "../client-auth/legacy";
import type { AppRecord, GatewayIdentity } from "../core/types";
import type { RequestVariables } from "./request-scope";

export interface GatewayVariables extends RequestVariables {
  app: AppRecord;
  identity: GatewayIdentity;
  /** The signed request's App Attest counter, which the route hands to the install's limiter. */
  assertionCounter: number | null;
}

/**
 * Authenticates a client call that is not a served request — `/me` — the same
 * way a served request is authenticated, without the provider read a served
 * request overlaps with it. Served requests authenticate inside
 * `../execution/serve`, which owns their whole sequence.
 */
export const gatewayAuth: MiddlewareHandler<{ Bindings: Env; Variables: GatewayVariables }> = async (c, next) => {
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadApp(c.env, appId);
  assertAppActive(app);
  const { identity, assertionCounter, responseHeaders, unsignedLegacy } = await authenticateRequest({
    env: c.env,
    app,
    request: c.req.raw,
    body: () => readBodyLimited(c.req.raw),
  });
  c.set("app", app);
  c.set("identity", identity);
  c.set("assertionCounter", assertionCounter);
  if (Object.keys(responseHeaders).length > 0) c.set("responseHeaders", responseHeaders);
  if (unsignedLegacy) c.executionCtx.waitUntil(noteUnsignedRequest(c.env.DB, app));
  await next();
  for (const [name, value] of Object.entries(responseHeaders)) c.res.headers.set(name, value);
};
