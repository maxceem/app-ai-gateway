/**
 * A mock of the hosted billing service, for the v2 test deployment only
 * (plan D17). It answers the one read the gateway makes, `getTenantAccess`,
 * through a `BillingWorker` entrypoint, as the real service does.
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

export class BillingWorker extends WorkerEntrypoint<MockEnv> {
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
