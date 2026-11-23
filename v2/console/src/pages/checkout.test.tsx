/**
 * The checkout landing: the page a plan chosen before sign-in lands on (v1's
 * tests, ported). The billing service is stubbed: nothing is bought.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CheckoutPage } from "./checkout";
import { postAuthPath } from "@/lib/auth-redirect";
import { renderAuthenticated } from "@/test/render";
import type { BillingAccess } from "@/lib/types";

const FREE: BillingAccess = { state: "billed", plan: { planKey: "free", planName: "Free", isDefault: true }, subscription: null };
const PAID: BillingAccess = { state: "billed", plan: { planKey: "pro", planName: "Pro", isDefault: false }, subscription: null };

const PLANS = [
  { planKey: "free", name: "Free", description: "Free", features: [], trialDays: 0, prices: [] },
  { planKey: "pro", name: "Pro", description: "Pro", features: [], trialDays: 0, prices: [{ billingPeriod: "month", priceAmountCents: 2000, priceCurrency: "USD" }] },
];

/** The billing service as the console reads it, through the gateway. */
function stubBilling(access: BillingAccess) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/billing/plans")) return new Response(JSON.stringify({ plans: PLANS }), { status: 200 });
    if (url.includes("/billing/checkout")) return new Response(JSON.stringify({ url: "https://checkout.example/pay" }), { status: 200 });
    if (url.includes("/billing/status")) {
      return new Response(JSON.stringify({ access, allowance: null, limits: {}, features: { conversationStorage: true }, actions: { cancel: false, resume: false, manual: false } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a plan chosen before sign-in", () => {
  it("goes to that plan's checkout once signed in; the free plan goes nowhere special", () => {
    expect(postAuthPath("?plan=pro")).toBe("/checkout?plan=pro");
    expect(postAuthPath("?plan=free")).toBe("/apps");
    expect(postAuthPath("?plan=<script>")).toBe("/apps");
  });

  it("says when the plans cannot be read, with a way to try again and a way back to Billing (Sol 7b-8)", async () => {
    const fetchMock = stubBilling(FREE);
    const answer = fetchMock.getMockImplementation()!;
    let plansUp = false;
    fetchMock.mockImplementation(async (input, init) =>
      String(input).includes("/billing/plans") && !plansUp
        ? new Response(JSON.stringify({ error: { code: "billing_unavailable", message: "The billing service is unavailable" } }), { status: 502 })
        : answer(input, init),
    );
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, origin: "https://console.test", assign });
    renderAuthenticated(<CheckoutPage />, { capabilities: { billing: true }, route: "/checkout?plan=pro" });
    expect(await screen.findByText("Could not load the plans")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to plans" }).getAttribute("href")).toBe("/billing");
    plansUp = true;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/pay"));
  });

  it("starts the checkout for an owner and sends them to the provider's page", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, origin: "https://console.test", assign });
    const fetchMock = stubBilling(FREE);
    renderAuthenticated(<CheckoutPage />, { capabilities: { billing: true }, route: "/checkout?plan=pro" });
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/pay"));
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/billing/checkout"));
    // The plan and period only: the tab names the account, and where the provider sends the person back is the gateway's to choose.
    expect(JSON.parse(String(call![1]!.body))).toEqual({ planKey: "pro", billingPeriod: "month" });
  });

  it("asks before starting a checkout on a page reached through Back or Forward (Sol 7b-8)", async () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "back_forward" } as unknown as PerformanceEntry]);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, origin: "https://console.test", assign });
    const fetchMock = stubBilling(FREE);
    renderAuthenticated(<CheckoutPage />, { capabilities: { billing: true }, route: "/checkout?plan=pro" });
    const proceed = await screen.findByRole("button", { name: "Continue to checkout" });
    expect(screen.getByRole("link", { name: "Go to plans" }).getAttribute("href")).toBe("/billing");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/billing/checkout"))).toBe(false);
    await userEvent.click(proceed);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/pay"));
  });

  it("sends a member, or a plan already held, to the plans page, and a deployment without billing to the apps", async () => {
    stubBilling(FREE);
    const member = renderAuthenticated(<CheckoutPage />, { capabilities: { billing: true }, session: { role: "member" }, route: "/checkout?plan=pro", path: "/checkout" });
    await waitFor(() => expect(member.router.location.pathname).toBe("/billing"));
    member.unmount();
    const held = renderAuthenticated(<CheckoutPage />, { capabilities: { billing: true }, route: "/checkout?plan=free", path: "/checkout" });
    await waitFor(() => expect(held.router.location.pathname).toBe("/apps"));
    held.unmount();
    vi.unstubAllGlobals();
    stubBilling(PAID);
    const owned = renderAuthenticated(<CheckoutPage />, { capabilities: { billing: true }, route: "/checkout?plan=pro", path: "/checkout" });
    await waitFor(() => expect(owned.router.location.pathname).toBe("/billing"));
    owned.unmount();
    const selfHosted = renderAuthenticated(<CheckoutPage />, { capabilities: { billing: false }, route: "/checkout?plan=pro", path: "/checkout" });
    await waitFor(() => expect(selfHosted.router.location.pathname).toBe("/apps"));
  });
});
