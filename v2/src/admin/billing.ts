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
  invalidateBillingAccess,
  planFeatures,
  readBillingForConsole,
  subscriptionActions,
} from "../billing/access.ts";
import { billingBinding, type BillingRuntime } from "../billing/contract.ts";
import { billingQuotaFor } from "../billing/quota.ts";
import { consoleOrigin } from "../auth/settings.ts";
import {
  BillingCancelRequestSchema,
  BillingChangeRequestSchema,
  BillingCheckoutRequestSchema,
  BillingResumeRequestSchema,
  BillingTrialRequestSchema,
  PLAN_LIMIT_KEYS,
  type BillingPeriod,
  type GatewayBillingAccess,
  type PlanAllowance,
  type PlanLimits,
} from "../contracts/billing.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { withDeadline } from "../core/background.ts";
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
export async function planAllowance(
  env: Env,
  accountId: string,
  access: GatewayBillingAccess,
  /** How long the limiter object may take: a stalled one shows as no figure (Sol 7b-8). */
  limiterDeadlineMs: number = ALLOWANCE_DEADLINE_MS,
): Promise<PlanAllowance | null> {
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
    used = await withDeadline(env.ACCOUNT_LIMITER.getByName(accountId).usage(quota.period.periodId), limiterDeadlineMs, "reading the allowance");
  } catch (error) {
    // The count lives in the account's limiter object; one that cannot answer
    // shows as no figure, and the billing page still loads (Sol 7b-8).
    log("warn", "billing_allowance_unreadable", { account: accountId, error: errorFacts(error) });
    return null;
  }
  return { ...quota.period, used, limit: quota.limit };
}

/** How long the billing page waits for the account's limiter object. */
const ALLOWANCE_DEADLINE_MS = 1_000;

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
function consoleReturnUrls(c: AdminContext, planKey: string, accountId: string): { successUrl: string; cancelUrl: string } {
  const origin = consoleOrigin(c.env) ?? new URL(c.req.url).origin;
  return {
    // The apps page announces a completed checkout for this plan on this
    // account, then strips the marker. Naming the account keeps a return read
    // in another account's console from announcing that account's plan.
    successUrl: `${origin}/v2/apps?checkout=success&plan=${encodeURIComponent(planKey)}&account=${encodeURIComponent(accountId)}`,
    // Passed to the billing service, which keeps it with the checkout; the
    // provider itself has no page it sends an abandoned checkout back to.
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

/** The subscription the console showed when the dialog opened. */
interface ShownSubscription {
  readonly subscriptionId: string | null;
  readonly subscriptionStatus: string | null;
  readonly subscriptionPeriod: BillingPeriod | null;
  /** Left out by a client that does not send it: then the other three decide. */
  readonly subscriptionUpdatedAt?: string | null | undefined;
}

/**
 * The subscription a write acts on is the one the console showed when the
 * dialog opened: the same id, status and period, and unchanged since
 * (`updatedAt`, when the client sends it). It is read afresh from the
 * billing service: one replaced, ended or moved to another period since is
 * refused before anything is asked of it (Sol 7b-8). Billing that cannot be
 * read answers 503, as any settings write does.
 */
async function requireShownSubscription(c: AdminContext, accountId: string, shown: ShownSubscription): Promise<void> {
  const access = await readBillingForConsole(c.env, accountId);
  if (access.state !== "billed") {
    throw new GatewayError(503, "billing_unavailable", "The subscription could not be read; try again shortly");
  }
  const current = access.subscription;
  const same =
    (current?.subscriptionId ?? null) === shown.subscriptionId &&
    (current?.status ?? null) === shown.subscriptionStatus &&
    (current?.billingPeriod ?? null) === shown.subscriptionPeriod &&
    (shown.subscriptionUpdatedAt === undefined || (current?.updatedAt ?? null) === shown.subscriptionUpdatedAt);
  if (!same) {
    throw new GatewayError(409, "subscription_changed", "The subscription changed since the page was read; reload it");
  }
}

/** How long a read of the plans on offer may take; past it the read answers 502 `billing_unavailable`. */
export const BILLING_CATALOG_DEADLINE_MS = 3_000;

/**
 * The plans on offer, read with a deadline: a billing service that hangs
 * answers `billing_unavailable` rather than leaving the console waiting
 * (Sol 7b-8). A read only, so cutting it off changes nothing.
 */
export function readCatalog(runtime: BillingRuntime, deadlineMs: number = BILLING_CATALOG_DEADLINE_MS) {
  return rpc(() => withDeadline(Promise.resolve(runtime.listPlans({ serviceId: BILLING_SERVICE_ID })), deadlineMs, "reading the plans"));
}

/**
 * The price a change is made at is the one the console showed: the billing
 * service's catalog is read afresh, and a price changed since is refused
 * before the change, which bills at once (Sol 7b-8). A plan or period the
 * catalog does not sell is the billing service's `billing_not_found`.
 */
async function requireShownPrice(
  runtime: BillingRuntime,
  planKey: string,
  billingPeriod: BillingPeriod,
  shown: { readonly priceAmountCents: number; readonly priceCurrency: string },
): Promise<void> {
  const { plans } = await readCatalog(runtime);
  const price = plans.find((plan) => plan.planKey === planKey)?.prices.find((entry) => entry.billingPeriod === billingPeriod);
  if (price === undefined) throw new GatewayError(404, "billing_not_found", "The requested plan was not found");
  if (price.priceAmountCents !== shown.priceAmountCents || price.priceCurrency.toLowerCase() !== shown.priceCurrency.toLowerCase()) {
    throw new GatewayError(409, "price_changed", "The plan's price changed since it was shown; reload the page");
  }
}

export async function listBillingPlans(c: AdminContext): Promise<Response> {
  const runtime = billingCaller(c);
  const { plans } = await readCatalog(runtime);
  return c.json({ plans } satisfies OperationResponse<"listBillingPlans">);
}

export async function getBillingStatus(c: AdminContext): Promise<Response> {
  billingCaller(c);
  const accountId = c.get("actor").accountId;
  // The billing page asks the billing service directly: after a checkout or a
  // change, a cached plan would show the old one. That read is the console's
  // own and never touches app traffic's (Sol 7b-8).
  const access = await readBillingForConsole(c.env, accountId);
  return c.json({
    access,
    limits: enforcedLimits(access),
    features: planFeatures(access),
    allowance: await planAllowance(c.env, accountId, access),
    actions: subscriptionActions(access),
  } satisfies OperationResponse<"getBillingStatus">);
}

/** How long starting a checkout may take: the billing service asks the payment provider for it. */
export const BILLING_CHECKOUT_DEADLINE_MS = 10_000;

export async function startCheckout(c: AdminContext): Promise<Response> {
  const runtime = billingManager(c);
  const input = await parseBody(c, BillingCheckoutRequestSchema);
  const accountId = c.get("actor").accountId;
  // Each checkout is the billing service's own: keeping one per account, and
  // reconciling a second one paid, is its job, not this gateway's.
  const created = rpc(() =>
    runtime.createCheckout({
      serviceId: BILLING_SERVICE_ID,
      tenantId: accountId,
      planKey: input.planKey,
      billingPeriod: input.billingPeriod,
      ...consoleReturnUrls(c, input.planKey, accountId),
    }),
  );
  // A billing service that does not answer in time may still have made the
  // checkout: the answer says the outcome is unknown, so the person checks
  // Billing before trying again.
  const result = await withDeadline(created, BILLING_CHECKOUT_DEADLINE_MS, "starting the checkout").catch((error: unknown) => {
    if (error instanceof GatewayError) throw error;
    log("warn", "billing_checkout_slow", { account: accountId, deadlineMs: BILLING_CHECKOUT_DEADLINE_MS });
    throw new GatewayError(
      504,
      "billing_outcome_unknown",
      "The billing service did not answer in time, so the checkout may or may not have been started. Check Billing before trying again",
    );
  });
  const url = paymentPage(c.env, result.url);
  invalidateBillingAccess(accountId);
  return c.json({ url } satisfies OperationResponse<"startCheckout">);
}

export async function changePlan(c: AdminContext): Promise<Response> {
  const runtime = billingManager(c);
  const input = await parseBody(c, BillingChangeRequestSchema);
  const accountId = c.get("actor").accountId;
  await requireShownSubscription(c, accountId, input);
  await requireShownPrice(runtime, input.planKey, input.billingPeriod, input.price);
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
  const input = await parseBody(c, BillingResumeRequestSchema);
  const accountId = c.get("actor").accountId;
  await requireShownSubscription(c, accountId, input);
  // A resume can charge at once, like a change: the billing service resumes on
  // the plan's current price for this plan and period, so the price shown in
  // the confirmation must still be that price (Sol 7b-8).
  await requireShownPrice(runtime, input.planKey, input.billingPeriod, input.price);
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
  const accountId = c.get("actor").accountId;
  await requireShownSubscription(c, accountId, input);
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
