import { Hono } from "hono";
import type { GatewayVariables } from "../middleware/auth";

export const meRoutes = new Hono<{ Bindings: Env; Variables: GatewayVariables }>();

meRoutes.get("/", async (c) => {
  const app = c.get("appConfig");
  const identity = c.get("identity");
  const status = await c.env.USER_LIMITER
    .getByName(`${app.id}:${identity.userId}`)
    .getStatus(Date.now());
  return c.json({
    user_id: identity.userId,
    // Observability, not a quota: the caller's own settled spend this UTC month,
    // and whether an operator has blocked them. The gateway's only allowance is
    // organization-wide and is reported on the rejection that spends it.
    monthly_cost_usd: status.monthlyCostMicrousd / 1_000_000,
    blocked: status.blocked,
  });
});
