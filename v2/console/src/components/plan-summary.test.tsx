/**
 * Billing in the console's frame (v1's sidebar, banner and checkout landing
 * tests, ported): the plan and allowance at the foot of the sidebar, the
 * Billing menu entry, the banner above every page, the landing for a plan
 * chosen before sign-in, and the return from a completed checkout. The
 * billing service is stubbed: nothing is bought.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./app-shell";
import { SidebarContent } from "./app-sidebar";
import { BillingBanner } from "./plan-summary";
import { CheckoutPage } from "@/pages/checkout";
import { checkoutReturnPathFor, postAuthPath } from "@/lib/auth-redirect";
import { renderAuthenticated, settled } from "@/test/render";
import type { BillingAccess, PlanAllowance } from "@/lib/types";

const FREE: BillingAccess = { state: "billed", plan: { planKey: "free", planName: "Free", isDefault: true }, subscription: null };
const PAID: BillingAccess = { state: "billed", plan: { planKey: "pro", planName: "Pro", isDefault: false }, subscription: null };

const allowance = (used: number, limit = 1_000): PlanAllowance => ({
  periodId: "free:1",
  periodStart: "2026-11-01T00:00:00.000Z",
  periodEnd: "2026-12-01T00:00:00.000Z",
  used,
  limit,
  resetAt: "2026-12-01T00:00:00.000Z",
});

const PLANS = [
  { planKey: "free", name: "Free", description: "Free", features: [], trialDays: 0, prices: [] },
  { planKey: "pro", name: "Pro", description: "Pro", features: [], trialDays: 0, prices: [{ billingPeriod: "month", priceAmountCents: 2000, priceCurrency: "USD" }] },
];

/** The billing service as the console reads it, through the gateway. */
function stubBilling(access: BillingAccess, reading: PlanAllowance | null = null) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/billing/plans")) return new Response(JSON.stringify({ plans: PLANS }), { status: 200 });
    if (url.includes("/billing/checkout")) return new Response(JSON.stringify({ url: "https://checkout.example/pay" }), { status: 200 });
    if (url.includes("/billing/status")) {
      return new Response(JSON.stringify({ access, allowance: reading, limits: {}, features: { conversationStorage: true }, actions: { cancel: false, resume: false, manual: false } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("the sidebar's plan block and Billing entry", () => {
  it("say nothing about billing on a deployment without it, and never ask for it", async () => {
    const fetchMock = stubBilling(FREE, allowance(10));
    const { client } = renderAuthenticated(<SidebarContent />, { capabilities: { billing: false } });
    await settled(client);
    expect(screen.queryByText(/plan$/u)).toBeNull();
    await userEvent.click(screen.getByText("Ada Lovelace"));
    expect(screen.queryByRole("menuitem", { name: /billing/iu })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/billing/"))).toBe(false);
  });

  it("name the plan and this period's allowance, with Billing in the user menu", async () => {
    stubBilling(FREE, allowance(250));
    renderAuthenticated(<SidebarContent />, { capabilities: { billing: true } });
    expect(await screen.findByText("Free plan")).toBeTruthy();
    expect(screen.getByText("250 of 1,000 requests")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Upgrade" })).toBeTruthy();
    await userEvent.click(screen.getByText("Ada Lovelace"));
    expect(await screen.findByRole("menuitem", { name: /billing/iu })).toBeTruthy();
  });

  it("offer a member the plan to read rather than an upgrade they cannot buy", async () => {
    stubBilling(FREE, allowance(250));
    renderAuthenticated(<SidebarContent />, { capabilities: { billing: true }, session: { role: "member" } });
    expect(await screen.findByRole("link", { name: "View plan" })).toBeTruthy();
  });

  it("sell a paying account nothing until its allowance is nearly spent", async () => {
    stubBilling(PAID, allowance(100));
    const first = renderAuthenticated(<SidebarContent />, { capabilities: { billing: true } });
    expect(await screen.findByText("Pro plan")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Upgrade" })).toBeNull();
    first.unmount();
    vi.unstubAllGlobals();
    stubBilling(PAID, allowance(900));
    renderAuthenticated(<SidebarContent />, { capabilities: { billing: true } });
    expect(await screen.findByRole("link", { name: "Upgrade" })).toBeTruthy();
  });
});

describe("the billing banner", () => {
  it("warns above the page once the allowance is nearly spent, with the way to the plans", async () => {
    stubBilling(FREE, allowance(900));
    renderAuthenticated(<BillingBanner />, { capabilities: { billing: true }, route: "/apps" });
    expect(await screen.findByText(/allowance almost spent/iu)).toBeTruthy();
    expect(screen.getByRole("link", { name: "View plans" })).toBeTruthy();
  });

  it("leaves the billing page, which states the same itself, and a healthy account alone", async () => {
    stubBilling(FREE, allowance(900));
    const onBilling = renderAuthenticated(<BillingBanner />, { capabilities: { billing: true }, route: "/billing" });
    await settled(onBilling.client);
    expect(screen.queryByText(/allowance almost spent/iu)).toBeNull();
    onBilling.unmount();
    vi.unstubAllGlobals();
    stubBilling(FREE, allowance(10));
    const healthy = renderAuthenticated(<BillingBanner />, { capabilities: { billing: true }, route: "/apps" });
    await settled(healthy.client);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a plan chosen before sign-in", () => {
  it("goes to that plan's checkout once signed in; the free plan goes nowhere special", () => {
    expect(postAuthPath("?plan=pro")).toBe("/checkout?plan=pro");
    expect(postAuthPath("?plan=free")).toBe("/apps");
    expect(postAuthPath("?plan=<script>")).toBe("/apps");
  });

  it("starts the checkout for an owner and sends them to the provider's page", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, origin: "https://console.test", assign });
    const fetchMock = stubBilling(FREE);
    renderAuthenticated(<CheckoutPage />, { capabilities: { billing: true }, route: "/checkout?plan=pro" });
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/pay"));
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/billing/checkout"));
    expect(JSON.parse(String(call![1]!.body))).toEqual({
      planKey: "pro",
      billingPeriod: "month",
      successUrl: `https://console.test/v2${checkoutReturnPathFor("pro")}`,
      cancelUrl: "https://console.test/v2/billing",
    });
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

describe("the return from a completed checkout", () => {
  it("is announced once, and the marker is taken off the address", async () => {
    stubBilling(PAID);
    const { router } = renderAuthenticated(<AppShell><p>Apps</p></AppShell>, {
      capabilities: { billing: true },
      route: checkoutReturnPathFor("pro"),
    });
    await waitFor(() => expect(router.location.search).toBe(""));
    expect(router.location.pathname).toBe("/apps");
  });
});
