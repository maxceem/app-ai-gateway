/**
 * The billing page's operations (`/v2/admin/billing/*`), v1's, ported: the
 * plans on offer, the account's plan and allowance, and the subscription
 * actions a person takes about it.
 *
 * Only on a hosted deployment, which binds the billing service: everywhere
 * else each answers 404 before reading a body. Each needs a person signed in
 * to the console, because a key that could buy or cancel would hand over more
 * than itself. Reading is any member's; buying, changing and cancelling is an
 * owner's or an admin's.
 *
 * Nothing here moves money itself: the billing service does, on its own
 * checkout pages and with the provider it holds.
 */
import type { Context } from "hono";
import {
  BILLING_SERVICE_ID,
  billingPlanLimits,
  billingRpcError,
  getBillingAccess,
  invalidateBillingAccess,
  planFeatures,
  subscriptionActions,
} from "../billing/access.ts";
import { billingBinding, type BillingRuntime } from "../billing/contract.ts";
import { billingQuotaFor } from "../billing/quota.ts";
import { consoleOrigin } from "../auth/settings.ts";
import {
  BillingCheckoutRequestSchema,
  BillingPlanSelectionSchema,
  BillingTrialRequestSchema,
  PLAN_LIMIT_KEYS,
  type GatewayBillingAccess,
  type PlanAllowance,
  type PlanLimits,
} from "../contracts/billing.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { requireAdminRole, requireConsoleSession, type AdminVariables } from "./actor.ts";
import { parseBody } from "./apps.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

/** The billing service, or the 404 every billing operation answers on a deployment without one. */
function binding(c: AdminContext): BillingRuntime {
  const value = billingBinding(c.env);
  if (value === null) throw new GatewayError(404, "not_found", "This deployment has no billing");
  return value;
}

/** A person in the console, on a deployment with billing. */
function billingCaller(c: AdminContext): BillingRuntime {
  const runtime = binding(c);
  requireConsoleSession(c.get("authState"));
  return runtime;
}

/** A person who may buy, change or cancel what pays for the account. */
function billingManager(c: AdminContext): BillingRuntime {
  const runtime = billingCaller(c);
  requireAdminRole(c.get("actor"));
  return runtime;
}

async function rpc<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw billingRpcError(error);
  }
}

/**
 * This period's requests against the plan's allowance: the count the request
 * path keeps in the account's limiter object. Null when nothing is counted (no
 * plan limit, or billing not readable). A schedule billing data cannot be
 * turned into is shown as no figure, never as an error: the page still loads.
 */
export async function planAllowance(env: Env, accountId: string, access: GatewayBillingAccess): Promise<PlanAllowance | null> {
  let quota;
  try {
    quota = await billingQuotaFor(access, env, accountId);
  } catch (error) {
    log("warn", "billing_allowance_unreadable", { account: accountId, error: errorFacts(error) });
    return null;
  }
  if (quota.kind === "unmetered") return null;
  const used = await env.ACCOUNT_LIMITER.getByName(accountId).usage(quota.period.periodId);
  return { ...quota.period, used, limit: quota.limit };
}

/** The plan's ceilings as this gateway enforces them; a misconfigured one is left out rather than failing the page. */
function enforcedLimits(access: GatewayBillingAccess): PlanLimits {
  const limits: PlanLimits = {};
  for (const key of PLAN_LIMIT_KEYS) {
    try {
      const value = billingPlanLimits(access, [key])[key];
      if (value !== undefined) limits[key] = value;
    } catch {
      // Shown as unlimited here; the write that meets it refuses with 502.
    }
  }
  return limits;
}

/**
 * Where the billing provider may send the person back: a console page only.
 * Anything else would let a link turn a checkout into a redirect elsewhere.
 */
function consoleReturnUrl(c: AdminContext, url: string | undefined, field: string): string | undefined {
  if (url === undefined) return undefined;
  const allowed = new Set([new URL(c.req.url).origin, ...(consoleOrigin(c.env) === null ? [] : [consoleOrigin(c.env)!])]);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GatewayError(400, "invalid_request", `${field} must be a console page`);
  }
  if (!allowed.has(parsed.origin)) throw new GatewayError(400, "invalid_request", `${field} must be a console page`);
  return parsed.toString();
}

export async function listBillingPlans(c: AdminContext): Promise<Response> {
  const runtime = billingCaller(c);
  const { plans } = await rpc(() => runtime.listPlans({ serviceId: BILLING_SERVICE_ID }));
  return c.json({ plans } satisfies OperationResponse<"listBillingPlans">);
}

export async function getBillingStatus(c: AdminContext): Promise<Response> {
  billingCaller(c);
  const accountId = c.get("actor").accountId;
  const access = await getBillingAccess(c.env, accountId);
  return c.json({
    access,
    limits: enforcedLimits(access),
    features: planFeatures(access),
    allowance: await planAllowance(c.env, accountId, access),
    actions: subscriptionActions(access),
  } satisfies OperationResponse<"getBillingStatus">);
}

export async function startCheckout(c: AdminContext): Promise<Response> {
  const runtime = billingManager(c);
  const input = await parseBody(c, BillingCheckoutRequestSchema);
  const accountId = c.get("actor").accountId;
  const successUrl = consoleReturnUrl(c, input.successUrl, "successUrl");
  const cancelUrl = consoleReturnUrl(c, input.cancelUrl, "cancelUrl");
  const result = await rpc(() =>
    runtime.createCheckout({
      serviceId: BILLING_SERVICE_ID,
      tenantId: accountId,
      planKey: input.planKey,
      billingPeriod: input.billingPeriod,
      ...(successUrl === undefined ? {} : { successUrl }),
      ...(cancelUrl === undefined ? {} : { cancelUrl }),
    }),
  );
  invalidateBillingAccess(accountId);
  return c.json({ url: result.url } satisfies OperationResponse<"startCheckout">);
}

export async function changePlan(c: AdminContext): Promise<Response> {
  const runtime = billingManager(c);
  const input = await parseBody(c, BillingPlanSelectionSchema);
  const accountId = c.get("actor").accountId;
  const result = await rpc(() =>
    runtime.changePlan({ serviceId: BILLING_SERVICE_ID, tenantId: accountId, planKey: input.planKey, billingPeriod: input.billingPeriod }),
  );
  invalidateBillingAccess(accountId);
  return c.json({
    ok: true,
    ...(result.requiredActionUrl === undefined ? {} : { requiredActionUrl: result.requiredActionUrl }),
  } satisfies OperationResponse<"changePlan">);
}

export async function resumeSubscription(c: AdminContext): Promise<Response> {
  const runtime = billingManager(c);
  const input = await parseBody(c, BillingPlanSelectionSchema);
  const accountId = c.get("actor").accountId;
  const result = await rpc(() =>
    runtime.resumeSubscription({ serviceId: BILLING_SERVICE_ID, tenantId: accountId, planKey: input.planKey, billingPeriod: input.billingPeriod }),
  );
  invalidateBillingAccess(accountId);
  return c.json({
    ok: true,
    ...(result.requiredActionUrl === undefined ? {} : { requiredActionUrl: result.requiredActionUrl }),
  } satisfies OperationResponse<"resumeSubscription">);
}

export async function cancelSubscription(c: AdminContext): Promise<Response> {
  const runtime = billingManager(c);
  const accountId = c.get("actor").accountId;
  await rpc(() => runtime.cancelSubscription({ serviceId: BILLING_SERVICE_ID, tenantId: accountId }));
  invalidateBillingAccess(accountId);
  return c.json({ ok: true } satisfies OperationResponse<"cancelSubscription">);
}

export async function startTrial(c: AdminContext): Promise<Response> {
  const runtime = billingManager(c);
  const input = await parseBody(c, BillingTrialRequestSchema);
  const accountId = c.get("actor").accountId;
  const access = await rpc(() => runtime.startTrial({ serviceId: BILLING_SERVICE_ID, tenantId: accountId, planKey: input.planKey }));
  invalidateBillingAccess(accountId);
  return c.json({ plan: access.plan, subscription: access.subscription } satisfies OperationResponse<"startTrial">);
}
