import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BillingPage } from "./billing";
import { renderAuthenticated } from "@/test/render";

const PLANS = [
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

function stubBilling(access: unknown, checkoutUrl = "https://checkout.example/session") {
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
    stubBilling({
      status: "active",
      planKey: "pro",
      planName: "Pro",
      renewsAt: "2026-10-01T00:00:00.000Z",
    });
    renderBilling();

    expect(await screen.findByText("Active")).toBeTruthy();
    expect(await screen.findByText(/renews/i)).toBeTruthy();
  });

  it("lists plans with prices for the selected billing period", async () => {
    stubBilling({ status: "inactive", reason: "missing_subscription" });
    renderBilling();

    expect(await screen.findByText("Pro")).toBeTruthy();
    expect(await screen.findByText("$20/mo")).toBeTruthy();

    await userEvent.click(screen.getByRole("tab", { name: /yearly/i }));
    expect(await screen.findByText("$200/yr")).toBeTruthy();
  });

  it("warns and offers plans when the subscription has lapsed", async () => {
    stubBilling({ status: "inactive", reason: "past_due" });
    renderBilling();

    expect(await screen.findByText(/payment past due/i)).toBeTruthy();
  });

  it("sends an owner to the provider checkout", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, origin: "https://console.test", assign });
    const fetchMock = stubBilling({ status: "inactive", reason: "missing_subscription" });
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
    stubBilling({ status: "active", planKey: "pro", renewsAt: "2026-10-01T00:00:00.000Z" });
    const { unmount } = renderBilling();
    expect(await screen.findByRole("button", { name: /cancel subscription/i })).toBeTruthy();
    unmount();

    vi.unstubAllGlobals();
    stubBilling({ status: "active", planKey: "pro", endsAt: "2026-09-15T00:00:00.000Z" });
    renderBilling();
    expect(await screen.findByRole("button", { name: /resume subscription/i })).toBeTruthy();
  });

  it("disables billing actions for a read-only member", async () => {
    stubBilling({ status: "inactive", reason: "missing_subscription" });
    renderBilling("member");

    // Billing changes are mutations; the server rejects them for members.
    expect(await screen.findByRole("button", { name: /subscribe/i }))
      .toHaveProperty("disabled", true);
  });
});
