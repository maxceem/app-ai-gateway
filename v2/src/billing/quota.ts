/**
 * What an account's plan allowance is right now: unmetered (self-hosted, no
 * plan limit, or billing unreadable), or a request limit and the period it is
 * counted over. Ported from v1's `src/billing/quota.ts`; v2 has no unclaimed
 * accounts (owner, 2026-11-19), so no free-window rule.
 */
import type { GatewayBillingAccess } from "../contracts/billing.ts";
import { GatewayError } from "../core/errors.ts";
import { ttlCache } from "../core/ttl-cache.ts";
import { billingPlanLimits } from "./access.ts";
import { freeSchedule, paidSchedule, planPeriod, type PlanPeriod, type PlanSchedule } from "./period.ts";

export type BillingQuota =
  | { kind: "unmetered"; access: GatewayBillingAccess }
  | { kind: "metered"; access: GatewayBillingAccess; limit: number; period: PlanPeriod };

function invalidSchedule(field: string): GatewayError {
  return new GatewayError(502, "billing_unavailable", `Invalid ${field} from billing data`);
}

function instant(value: string, field: string): number {
  const at = Date.parse(value.includes("T") || value.includes("Z") ? value : `${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(at)) throw invalidSchedule(field);
  return at;
}

/** When each account was created: the default plan's months run from that day. */
const accountCreated = ttlCache<string, number>({ name: "account-created", ttlMs: 60 * 60_000, maxEntries: 10_000 });

async function accountCreatedAt(env: Env, accountId: string): Promise<number> {
  const cached = accountCreated.get(accountId);
  if (cached !== undefined) return cached;
  const row = await env.DB.prepare("SELECT created_at FROM mgmt_organization WHERE id = ?")
    .bind(accountId)
    .first<{ created_at: string }>();
  if (row === null) throw invalidSchedule("account");
  const at = instant(row.created_at, "account creation time");
  accountCreated.set(accountId, at);
  return at;
}

/** The schedule a plan is counted on: the account's own for the default plan, the subscription's otherwise. */
function schedule(access: GatewayBillingAccess & { state: "billed" }, accountCreatedAtMs: number): PlanSchedule {
  if (access.plan?.isDefault !== false) return freeSchedule(accountCreatedAtMs);
  const subscription = access.subscription;
  if (!subscription) throw invalidSchedule("paid subscription schedule");
  const anchorAt = instant(subscription.billingAnchorAt, "billing anchor");
  const anchorDay = subscription.billingAnchorDay ?? new Date(anchorAt).getUTCDate();
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) throw invalidSchedule("billing anchor day");
  return paidSchedule(anchorAt, anchorDay, instant(subscription.createdAt, "subscription creation time"));
}

/**
 * The plan's request limit and its period. Throws `GatewayError` when billing
 * data cannot be turned into a period; admission then serves the request
 * uncounted, because that is our problem, not the app's.
 */
export async function billingQuotaFor(
  access: GatewayBillingAccess,
  env: Env,
  accountId: string,
  now: number = Date.now(),
): Promise<BillingQuota> {
  if (access.state !== "billed" || access.plan === null) return { kind: "unmetered", access };
  const limit = billingPlanLimits(access).maxRequestsPerMonth;
  if (limit === undefined) return { kind: "unmetered", access };
  const planSchedule = schedule(access, await accountCreatedAt(env, accountId));
  if (planSchedule.anchorAt > now) throw invalidSchedule("future billing anchor");
  return { kind: "metered", access, limit, period: planPeriod(planSchedule, now) };
}
