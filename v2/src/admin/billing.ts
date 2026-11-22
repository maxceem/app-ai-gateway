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
  BillingCancelRequestSchema,
  BillingChangeRequestSchema,
  BillingCheckoutRequestSchema,
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
  let used: number;
  try {
    used = await env.ACCOUNT_LIMITER.getByName(accountId).usage(quota.period.periodId);
  } catch (error) {
    // The count lives in the account's limiter object; one that cannot answer
    // shows as no figure, and the billing page still loads (Sol 7b-8).
    log("warn", "billing_allowance_unreadable", { account: accountId, error: errorFacts(error) });
    return null;
  }
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
 * Where the billing provider sends the person back: the console's own pages,
 * built here from the console's canonical origin and fixed paths. Nothing the
 * caller sends decides them, so a checkout can never be turned into a redirect
 * elsewhere (Sol 7b-8). A deployment without a separate console serves it on
 * its own origin.
 */
function consoleReturnUrls(c: AdminContext, planKey: string): { successUrl: string; cancelUrl: string } {
  const origin = consoleOrigin(c.env) ?? new URL(c.req.url).origin;
  return {
    // The apps page announces a completed checkout for this plan, then strips the marker.
    successUrl: `${origin}/v2/apps?checkout=success&plan=${encodeURIComponent(planKey)}`,
    cancelUrl: `${origin}/v2/billing`,
  };
}

/** The billing provider's hosts, where a checkout or payment page may be: Lemon Squeezy's unless set. */
const DEFAULT_PAYMENT_HOSTS = ["lemonsqueezy.com"];

/** `BILLING_PAYMENT_HOSTS`: a comma-separated list of hosts; each also covers its subdomains. */
function paymentHosts(env: Env): string[] {
  const raw = (env as unknown as { BILLING_PAYMENT_HOSTS?: string }).BILLING_PAYMENT_HOSTS;
  const hosts = (raw ?? "").split(",").map((host) => host.trim().toLowerCase()).filter((host) => host !== "");
  return hosts.length > 0 ? hosts : DEFAULT_PAYMENT_HOSTS;
}

/**
 * A page the billing service answered for the person to open (a checkout, or
 * where a payment method is confirmed): only an HTTPS page on a configured
 * payment host is passed on. Anything else is the billing service's fault,
 * logged and answered as unavailable, never sent to the browser.
 */
export function paymentPage(env: Env, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    log("error", "billing_payment_page_refused", { reason: "not_a_url" });
    throw new GatewayError(502, "billing_unavailable", "The billing service is unavailable; try again shortly");
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = paymentHosts(env).some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (parsed.protocol !== "https:" || !allowed) {
    log("error", "billing_payment_page_refused", { reason: parsed.protocol !== "https:" ? "not_https" : "host_not_allowed" });
    throw new GatewayError(502, "billing_unavailable", "The billing service is unavailable; try again shortly");
  }
  return parsed.toString();
}

/**
 * The account a write acts on is the one the console showed: one selected in
 * another tab since is refused, never acted on in its place (Sol 7b-8).
 */
function requireShownAccount(c: AdminContext, accountId: string): string {
  const selected = c.get("actor").accountId;
  if (accountId !== selected) {
    throw new GatewayError(409, "account_changed", "The console's account is no longer the one selected; reload the page");
  }
  return selected;
}

/**
 * The subscription a write acts on is the one the console showed. It is read
 * afresh from the billing service: one replaced or ended since is refused
 * before anything is asked of it (Sol 7b-8). Billing that cannot be read
 * answers 503, as any settings write does.
 */
async function requireShownSubscription(env: Env, accountId: string, subscriptionId: string | null): Promise<void> {
  invalidateBillingAccess(accountId);
  const access = await getBillingAccess(env, accountId);
  if (access.state !== "billed" || access.stale === true) {
    throw new GatewayError(503, "billing_unavailable", "The subscription could not be read; try again shortly");
  }
  if ((access.subscription?.subscriptionId ?? null) !== subscriptionId) {
    throw new GatewayError(409, "subscription_changed", "The subscription changed since the page was read; reload it");
  }
}

/** How long a checkout page stays payable: the billing service issues each for an hour. */
export const CHECKOUT_LIFETIME_MS = 60 * 60_000;

/** How long a request preparing a checkout holds the account's slot before another may take it over. */
const CHECKOUT_CLAIM_MS = 60_000;

interface OpenCheckout {
  plan_key: string;
  billing_period: string;
  url: string | null;
  claim_id: string;
  expires_at: number;
}

/**
 * The account's one open checkout (Sol 7b-8). Either this request takes the
 * account's slot (no open checkout, or the last one expired) and prepares the
 * page, or it answers the open one: the same page for the same plan and
 * period, a refusal for any other, so the account never holds two payable
 * checkouts at once. Taking the slot is one statement, so two tabs cannot both.
 */
async function openCheckout(
  env: Env,
  accountId: string,
  planKey: string,
  billingPeriod: string,
  prepare: () => Promise<string>,
): Promise<string> {
  const now = Date.now();
  const claim = crypto.randomUUID();
  const taken = await env.DB.prepare(
    `INSERT INTO billing_open_checkout (account_id, plan_key, billing_period, url, claim_id, expires_at)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5)
     ON CONFLICT (account_id) DO UPDATE SET
       plan_key = excluded.plan_key, billing_period = excluded.billing_period,
       url = NULL, claim_id = excluded.claim_id, expires_at = excluded.expires_at
     WHERE billing_open_checkout.expires_at <= ?6
     RETURNING claim_id`,
  )
    .bind(accountId, planKey, billingPeriod, claim, now + CHECKOUT_CLAIM_MS, now)
    .first<{ claim_id: string }>();
  if (taken?.claim_id !== claim) {
    const open = await env.DB.prepare("SELECT plan_key, billing_period, url, claim_id, expires_at FROM billing_open_checkout WHERE account_id = ?")
      .bind(accountId)
      .first<OpenCheckout>();
    if (open && open.plan_key === planKey && open.billing_period === billingPeriod && open.url !== null) return open.url;
    if (open && open.url === null) {
      throw new GatewayError(409, "checkout_in_progress", "A checkout is being prepared for this account; try again in a moment");
    }
    const until = open ? new Date(open.expires_at).toISOString() : "shortly";
    throw new GatewayError(409, "checkout_open", `A checkout for another plan is open until ${until}; finish it or try again then`);
  }
  let url: string;
  try {
    url = await prepare();
  } catch (error) {
    // Nothing was issued: the slot is given back for the next attempt.
    await env.DB.prepare("DELETE FROM billing_open_checkout WHERE account_id = ? AND claim_id = ?").bind(accountId, claim).run();
    throw error;
  }
  await env.DB.prepare("UPDATE billing_open_checkout SET url = ?, expires_at = ? WHERE account_id = ? AND claim_id = ?")
    .bind(url, Date.now() + CHECKOUT_LIFETIME_MS, accountId, claim)
    .run();
  return url;
}

export async function listBillingPlans(c: AdminContext): Promise<Response> {
  const runtime = billingCaller(c);
  const { plans } = await rpc(() => runtime.listPlans({ serviceId: BILLING_SERVICE_ID }));
  return c.json({ plans } satisfies OperationResponse<"listBillingPlans">);
}

export async function getBillingStatus(c: AdminContext): Promise<Response> {
  billingCaller(c);
  const accountId = c.get("actor").accountId;
  // The billing page asks the billing service every time: after a checkout or
  // a change, a cached plan would show the old one (Sol 7b-8).
  invalidateBillingAccess(accountId);
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
  const accountId = requireShownAccount(c, input.accountId);
  const url = await openCheckout(c.env, accountId, input.planKey, input.billingPeriod, async () => {
    const result = await rpc(() =>
      runtime.createCheckout({
        serviceId: BILLING_SERVICE_ID,
        tenantId: accountId,
        planKey: input.planKey,
        billingPeriod: input.billingPeriod,
        ...consoleReturnUrls(c, input.planKey),
      }),
    );
    return paymentPage(c.env, result.url);
  });
  invalidateBillingAccess(accountId);
  return c.json({ url } satisfies OperationResponse<"startCheckout">);
}

export async function changePlan(c: AdminContext): Promise<Response> {
  const runtime = billingManager(c);
  const input = await parseBody(c, BillingChangeRequestSchema);
  const accountId = requireShownAccount(c, input.accountId);
  await requireShownSubscription(c.env, accountId, input.subscriptionId);
  const result = await rpc(() =>
    runtime.changePlan({ serviceId: BILLING_SERVICE_ID, tenantId: accountId, planKey: input.planKey, billingPeriod: input.billingPeriod }),
  );
  invalidateBillingAccess(accountId);
  return c.json({
    ok: true,
    ...(result.requiredActionUrl === undefined ? {} : { requiredActionUrl: paymentPage(c.env, result.requiredActionUrl) }),
  } satisfies OperationResponse<"changePlan">);
}

export async function resumeSubscription(c: AdminContext): Promise<Response> {
  const runtime = billingManager(c);
  const input = await parseBody(c, BillingChangeRequestSchema);
  const accountId = requireShownAccount(c, input.accountId);
  await requireShownSubscription(c.env, accountId, input.subscriptionId);
  const result = await rpc(() =>
    runtime.resumeSubscription({ serviceId: BILLING_SERVICE_ID, tenantId: accountId, planKey: input.planKey, billingPeriod: input.billingPeriod }),
  );
  invalidateBillingAccess(accountId);
  return c.json({
    ok: true,
    ...(result.requiredActionUrl === undefined ? {} : { requiredActionUrl: paymentPage(c.env, result.requiredActionUrl) }),
  } satisfies OperationResponse<"resumeSubscription">);
}

export async function cancelSubscription(c: AdminContext): Promise<Response> {
  const runtime = billingManager(c);
  const input = await parseBody(c, BillingCancelRequestSchema);
  const accountId = requireShownAccount(c, input.accountId);
  await requireShownSubscription(c.env, accountId, input.subscriptionId);
  await rpc(() => runtime.cancelSubscription({ serviceId: BILLING_SERVICE_ID, tenantId: accountId }));
  invalidateBillingAccess(accountId);
  return c.json({ ok: true } satisfies OperationResponse<"cancelSubscription">);
}

export async function startTrial(c: AdminContext): Promise<Response> {
  const runtime = billingManager(c);
  const input = await parseBody(c, BillingTrialRequestSchema);
  const accountId = requireShownAccount(c, input.accountId);
  const access = await rpc(() => runtime.startTrial({ serviceId: BILLING_SERVICE_ID, tenantId: accountId, planKey: input.planKey }));
  invalidateBillingAccess(accountId);
  return c.json({ plan: access.plan, subscription: access.subscription } satisfies OperationResponse<"startTrial">);
}
