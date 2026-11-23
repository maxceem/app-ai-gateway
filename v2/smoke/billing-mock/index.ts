/**
 * A mock of the hosted billing service, for the v2 test deployment only
 * (plan D17), through a `BillingWorker` entrypoint, as the real service is:
 * the read the request path makes (`getTenantAccess`), and the billing page's
 * calls (plans, checkout, change, resume, cancel, trial).
 *
 * It holds no state and moves no money. Its checkout is a URL on `.invalid`,
 * which never resolves; a change, resume or cancel is acknowledged and
 * changes nothing.
 *
 * Plans come from the `PLANS` variable in this Worker's config: JSON mapping
 * an account (tenant) id to its plan's `limits`. Every other account gets the
 * default plan, which has no limits. Change the variable and redeploy to
 * change a plan.
 *
 * Deploy: `pnpm exec wrangler deploy -c smoke/billing-mock/wrangler.jsonc`.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

interface MockEnv {
  PLANS?: string;
}

/** The same shape the gateway reads (`src/contracts/billing.ts`). */
interface TenantAccess {
  plan: { planKey: string; planName: string; limits?: unknown; isDefault: boolean } | null;
  subscription: null;
}

function plans(env: MockEnv): Record<string, Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(env.PLANS ?? "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, Record<string, unknown>>) : {};
  } catch {
    return {};
  }
}

/** The plans on offer: the free default, and one paid plan whose prices are fixtures. */
const OFFERS = [
  { planKey: "free", name: "Free", description: "The default plan", features: ["No card needed"], trialDays: 0, prices: [] },
  {
    planKey: "smoke-pro",
    name: "Smoke Pro",
    description: "A paid plan for the smoke checks",
    features: ["More requests"],
    trialDays: 14,
    prices: [{ billingPeriod: "month", priceAmountCents: 1900, priceCurrency: "USD" }],
  },
];

/** A refusal as the real service throws it: its code in the error's name, which survives RPC. */
function refusal(code: string): Error {
  const error = new Error(code);
  error.name = `BillingHttpError:${code}`;
  return error;
}

function offered(planKey: string): void {
  if (!OFFERS.some((offer) => offer.planKey === planKey && offer.prices.length > 0)) throw refusal("billing_plan_not_found");
}

export class BillingWorker extends WorkerEntrypoint<MockEnv> {
  async listPlans(): Promise<{ plans: typeof OFFERS }> {
    return { plans: OFFERS };
  }

  async createCheckout(input: { tenantId: string; planKey: string }): Promise<{ url: string }> {
    offered(input.planKey);
    // `.invalid` never resolves: nothing can be bought here.
    return { url: `https://checkout.invalid/smoke/${encodeURIComponent(input.planKey)}` };
  }

  async changePlan(input: { planKey: string }): Promise<{ ok: true }> {
    offered(input.planKey);
    return { ok: true };
  }

  async resumeSubscription(input: { planKey: string }): Promise<{ ok: true }> {
    offered(input.planKey);
    return { ok: true };
  }

  async cancelSubscription(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async getTenantAccess(input: { serviceId: string; tenantId: string }): Promise<TenantAccess> {
    const limits = plans(this.env)[input.tenantId];
    // A default plan for every account: a plan with limits is still the
    // default one, so its months run from the account's creation day.
    return {
      plan: limits === undefined
        ? { planKey: "free", planName: "Free", isDefault: true }
        : { planKey: "smoke", planName: "Smoke", limits, isDefault: true },
      subscription: null,
    };
  }
}

export default {
  fetch(): Response {
    return new Response("Billing mock: reached only through its service binding.\n", { status: 404 });
  },
};
