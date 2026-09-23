import type { MiddlewareHandler } from "hono";
import { authenticateRequest } from "../core/app-auth";
import { assertAppActive, loadApp } from "../core/config";
import { GatewayError } from "../core/errors";
import type { AppRecord, GatewayIdentity } from "../core/types";
import type { RequestVariables } from "./request-scope";

export interface GatewayVariables extends RequestVariables {
  app: AppRecord;
  identity: GatewayIdentity;
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
  const { identity } = await authenticateRequest({ env: c.env, app, headers: c.req.raw.headers });
  c.set("app", app);
  c.set("identity", identity);
  await next();
};
