import type { Handler } from "hono";
import { execute } from "../execution/execute";
import type { ExecutionVariables } from "../execution/plan";
import type { GatewayVariables } from "../middleware/auth";

export const executionHandler: Handler<{
  Bindings: Env;
  Variables: GatewayVariables & ExecutionVariables;
}> = (c) => execute(c.get("executionPlan"), {
  env: c.env,
  app: c.get("appConfig"),
  identity: c.get("identity"),
  appVersion: c.req.header("x-app-version") ?? null,
  authDurationMs: c.get("authDurationMs"),
  limiterDurationMs: c.get("limiterDurationMs"),
  waitUntil: (promise) => c.executionCtx.waitUntil(promise),
});
