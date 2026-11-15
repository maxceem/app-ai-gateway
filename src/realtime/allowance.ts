import { admitAppTraffic, getAppTrafficBillingAccess } from "../billing/gateway";
import { billingQuotaFor } from "../billing/quota";
import { allowanceExhausted } from "../billing/allowance-admission";
import { GatewayError } from "../core/errors";
import type { Deployment } from "../policy/deployment";

/**
 * Checks the organization's plan allowance before a realtime session opens,
 * and again while it stays open.
 *
 * It follows the same rule as every request from an app: billing we cannot
 * read, or a counter that does not answer in time, never ends a session. Only
 * a missing plan, or an allowance known to be used up, refuses it. Each
 * generation is still counted when it starts, by admission.
 *
 * `checkUsage: false` skips the used-up check, for a session whose current
 * generation admission has already allowed to finish.
 */
export async function requireRealtimeAllowance(
  env: Env,
  deployment: Deployment,
  organizationId: string,
  waitUntil: (promise: Promise<unknown>) => void,
  checkUsage = true,
): Promise<void> {
  const access = await getAppTrafficBillingAccess(deployment, organizationId, new Map(), waitUntil);
  const quota = await billingQuotaFor(access, env, organizationId);
  admitAppTraffic(quota.access, organizationId);
  if (!checkUsage || quota.kind !== "metered") return;
  const counter = env.ORG_QUOTA.getByName(organizationId);
  if (await allowanceExhausted(counter, organizationId, { periodId: quota.period.periodId, limit: quota.limit }, waitUntil)) {
    throw new GatewayError(429, "billing_request_quota_exceeded", "Request allowance exhausted");
  }
}
