import { Hono } from "hono";
import type { UserLimiter } from "../do/UserLimiter";
import type { GatewayVariables } from "../middleware/auth";

export const meRoutes = new Hono<{ Bindings: Env; Variables: GatewayVariables }>();

meRoutes.get("/", async (c) => {
  const app = c.get("appConfig");
  const identity = c.get("identity");
  const limiter = c.env.USER_LIMITER.getByName(`${app.id}:${identity.userId}`) as DurableObjectStub<UserLimiter>;
  const status = await limiter.getStatus(Date.now());
  return c.json({
    user_id: identity.userId,
    limits: {
      requests_today: status.requestsToday,
      requests_remaining:
        app.limits.perUser.requestsPerDay === null
          ? null
          : Math.max(0, app.limits.perUser.requestsPerDay - status.requestsToday),
      monthly_cost_usd: status.monthlyCostMicrousd / 1_000_000,
      monthly_budget_usd:
        app.limits.perUser.monthlyBudgetMicrousd === null
          ? null
          : app.limits.perUser.monthlyBudgetMicrousd / 1_000_000,
      blocked: status.blocked,
    },
  });
});
