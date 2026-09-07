import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BillingPage } from "./billing";
import { renderAuthenticated } from "@/test/render";
import type { BillingAccess, EntitledPlan, SubscriptionState } from "@/lib/types";

const PLANS = [
  {
    planKey: "free",
    name: "Free",
    description: "Get started at no cost",
    features: ["1,000 requests per month"],
    trialDays: 0,
    // A default plan is not purchasable, so it carries no price rows at all.
    prices: [],
  },
  {
    planKey: "pro",
    name: "Pro",
    description: "For production workloads",
    features: ["Unlimited apps", "Priority support"],
    trialDays: 14,
    prices: [
      { billingPeriod: "month", priceAmountCents: 2000, priceCurrency: "USD" },
      { billingPeriod: "year", priceAmountCents: 20000, priceCurrency: "USD" },
    ],
  },
];

const PAID_PLAN: EntitledPlan = { planKey: "pro", planName: "Pro", isDefault: false };
const FREE_PLAN: EntitledPlan = {
  planKey: "free",
  planName: "Free",
  limits: { maxRequestsPerMonth: 1000 },
  isDefault: true,
};

const subscription = (overrides: Partial<SubscriptionState> = {}): SubscriptionState => ({
  status: "active",
  planKey: "pro",
  planName: "Pro",
  billingPeriod: "month",
  renewsAt: null,
  endsAt: null,
  trialEndsAt: null,
  source: "lemon_squeezy",
  ...overrides,
});

const billed = (
  plan: EntitledPlan | null,
  sub: SubscriptionState | null = null,
): BillingAccess => ({ state: "billed", plan, subscription: sub });

function stubBilling(access: BillingAccess, checkoutUrl = "https://checkout.example/session") {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/billing/plans")) {
      return new Response(JSON.stringify({ plans: PLANS }), { status: 200 });
    }
    if (url.includes("/billing/checkout")) {
      return new Response(JSON.stringify({ url: checkoutUrl }), { status: 200 });
    }
    if (init?.method === "POST") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ access }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderBilling(role: "owner" | "member" = "owner") {
  return renderAuthenticated(<BillingPage />, {
    capabilities: { billing: true },
    session: { role },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("BillingPage", () => {
  it("shows the current plan and renewal date", async () => {
    stubBilling(billed(PAID_PLAN, subscription({ renewsAt: "2026-10-01T00:00:00.000Z" })));
    renderBilling();

    expect(await screen.findByText("Active")).toBeTruthy();
    expect(await screen.findByText(/renews/i)).toBeTruthy();
  });

  it("lists plans with prices for the selected billing period", async () => {
    stubBilling(billed(FREE_PLAN));
    renderBilling();

    expect(await screen.findByText("Pro")).toBeTruthy();
    expect(await screen.findByText("$20/mo")).toBeTruthy();

    await userEvent.click(screen.getByRole("tab", { name: /yearly/i }));
    expect(await screen.findByText("$200/yr")).toBeTruthy();
  });

  /**
   * The default plan has no price rows on either period, and nothing to buy. A
   * dash and a dead Subscribe button would read as a broken paid plan.
   */
  it("renders a price-less plan as Free on both periods, with nothing to buy", async () => {
    stubBilling(billed(FREE_PLAN));
    renderBilling();

    const freeCard = () =>
      screen.getByText("Get started at no cost").closest("[data-slot=card]") as HTMLElement;
    await screen.findByText("Get started at no cost");

    for (const tab of ["monthly", "yearly"]) {
      await userEvent.click(screen.getByRole("tab", { name: new RegExp(tab, "iu") }));
      // The plan title and its price both read "Free"; neither period shows a
      // dash, which is how a paid plan says it has no price for that period.
      await waitFor(() => expect(within(freeCard()).getAllByText("Free")).toHaveLength(2));
      expect(within(freeCard()).queryByRole("button", { name: /subscribe/iu })).toBeNull();
    }
  });

  it("marks the entitled plan as current, default plans included", async () => {
    stubBilling(billed(FREE_PLAN));
    renderBilling();

    expect(await screen.findByText("Current")).toBeTruthy();
  });

  it("says traffic moved to the default plan when a subscription ends", async () => {
    stubBilling(billed(FREE_PLAN, subscription({ status: "expired" })));
    renderBilling();

    expect(await screen.findByText(/subscription has ended/i)).toBeTruthy();
    expect(await screen.findByText(/Free plan \(1,000 requests\/month\)/)).toBeTruthy();
  });

  it("stays quiet for a fresh organization on the default plan", async () => {
    stubBilling(billed(FREE_PLAN));
    renderBilling();

    await screen.findByText("Pro");
    expect(screen.queryByText(/subscription has ended/i)).toBeNull();
    expect(screen.queryByText(/no active plan/i)).toBeNull();
  });

  it("warns and offers plans when no plan resolves at all", async () => {
    stubBilling(billed(null));
    renderBilling();

    expect(await screen.findByText(/no active plan/i)).toBeTruthy();
  });

  it("sends an owner to the provider checkout", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, origin: "https://console.test", assign });
    const fetchMock = stubBilling(billed(FREE_PLAN));
    renderBilling();

    await userEvent.click(await screen.findByRole("button", { name: /subscribe/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/billing/checkout"));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({
        planKey: "pro",
        billingPeriod: "month",
      });
    });
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/session"));
  });

  it("offers cancel for a live subscription and resume for a cancelled one", async () => {
    stubBilling(billed(PAID_PLAN, subscription({ renewsAt: "2026-10-01T00:00:00.000Z" })));
    const { unmount } = renderBilling();
    expect(await screen.findByRole("button", { name: /cancel subscription/i })).toBeTruthy();
    unmount();

    vi.unstubAllGlobals();
    stubBilling(billed(
      PAID_PLAN,
      subscription({ status: "cancelled", endsAt: "2026-09-15T00:00:00.000Z" }),
    ));
    renderBilling();
    expect(await screen.findByRole("button", { name: /resume subscription/i })).toBeTruthy();
  });

  /**
   * The buttons act on the subscription, not on the entitled plan: an
   * organization that has fallen back to Free can still un-cancel.
   */
  it("still offers resume once a cancelled subscription has dropped to the default plan", async () => {
    stubBilling(billed(FREE_PLAN, subscription({ status: "cancelled" })));
    renderBilling();

    expect(await screen.findByRole("button", { name: /resume subscription/i })).toBeTruthy();
  });

  it("offers no subscription action to an organization that never subscribed", async () => {
    stubBilling(billed(FREE_PLAN));
    renderBilling();

    await screen.findByText("Pro");
    expect(screen.queryByRole("button", { name: /cancel subscription/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /resume subscription/i })).toBeNull();
  });

  it("disables billing actions for a read-only member", async () => {
    stubBilling(billed(FREE_PLAN));
    renderBilling("member");

    // Billing changes are mutations; the server rejects them for members.
    expect(await screen.findByRole("button", { name: /subscribe/i }))
      .toHaveProperty("disabled", true);
  });
});
