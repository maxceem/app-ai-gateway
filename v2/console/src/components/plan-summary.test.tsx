/**
 * Billing in the console's frame (v1's sidebar, banner and checkout landing
 * tests, ported): the plan and allowance at the foot of the sidebar, the
 * Billing menu entry, the banner above every page, the landing for a plan
 * chosen before sign-in, and the return from a completed checkout. The
 * billing service is stubbed: nothing is bought.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./app-shell";
import { SidebarContent } from "./app-sidebar";
import { BillingBanner } from "./plan-summary";
import { CheckoutPage } from "@/pages/checkout";
import { checkoutReturnPathFor, postAuthPath } from "@/lib/auth-redirect";
import { PLAN_CONFIRM_CHECKS, PLAN_CONFIRM_INTERVAL_MS } from "@/lib/checkout-return";
import { CAPABILITIES, membership, renderAuthenticated, settled, testSession } from "@/test/render";
import { useState, type ReactNode } from "react";
import { ConsoleSessionProvider } from "@/lib/console-session";
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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
    // The account it acts on; where the provider sends the person back is the gateway's to choose.
    expect(JSON.parse(String(call![1]!.body))).toEqual({ planKey: "pro", billingPeriod: "month", accountId: "acct-1" });
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
  const statusReads = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter(([url]) => String(url).includes("/billing/status")).length;

  it("says the payment is being confirmed, then complete once the billing service reports the plan bought, and takes the marker off", async () => {
    const loading = vi.spyOn(toast, "loading");
    const success = vi.spyOn(toast, "success");
    stubBilling(PAID);
    const { router } = renderAuthenticated(<AppShell><p>Apps</p></AppShell>, {
      capabilities: { billing: true },
      route: checkoutReturnPathFor("pro", "acct-1"),
    });
    await waitFor(() => expect(router.location.search).toBe(""));
    expect(router.location.pathname).toBe("/apps");
    expect(loading).toHaveBeenCalledWith("Confirming your payment…", expect.anything());
    await waitFor(() => expect(success).toHaveBeenCalledWith("Payment complete", expect.anything()));
  });

  it("reads the plan a capped number of times, then says the payment was received rather than complete (Sol 7b-8)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const success = vi.spyOn(toast, "success");
    const info = vi.spyOn(toast, "info");
    // Still the free plan: the webhook has not landed.
    const fetchMock = stubBilling(FREE);
    renderAuthenticated(<AppShell><p>Apps</p></AppShell>, { capabilities: { billing: true }, route: checkoutReturnPathFor("pro", "acct-1") });
    for (let check = 0; check < PLAN_CONFIRM_CHECKS + 2; check += 1) {
      await act(() => vi.advanceTimersByTimeAsync(PLAN_CONFIRM_INTERVAL_MS));
    }
    await waitFor(() => expect(info).toHaveBeenCalledWith("Payment received", expect.anything()));
    expect(success).not.toHaveBeenCalledWith("Payment complete", expect.anything());
    // The page's own status read may add one; the confirming reads stop at the cap.
    expect(statusReads(fetchMock)).toBeLessThanOrEqual(PLAN_CONFIRM_CHECKS + 1);
  });

  it("asks for the plan of the account the checkout was for, in its own reads with no retries (Sol 7b-8)", async () => {
    const success = vi.spyOn(toast, "success");
    const fetchMock = stubBilling(PAID);
    renderAuthenticated(<AppShell><p>Apps</p></AppShell>, { capabilities: { billing: true }, route: checkoutReturnPathFor("pro", "acct-1") });
    await waitFor(() => expect(success).toHaveBeenCalledWith("Payment complete", expect.anything()));
    const confirming = fetchMock.mock.calls.filter(([url]) => String(url).includes("/billing/status?account=acct-1"));
    expect(confirming.length).toBeGreaterThanOrEqual(1);
    for (const [, init] of confirming) expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("shows nothing for a return that names another account, and reads nothing for it (Sol 7b-8)", async () => {
    const loading = vi.spyOn(toast, "loading");
    const success = vi.spyOn(toast, "success");
    const info = vi.spyOn(toast, "info");
    const fetchMock = stubBilling(PAID);
    const { router } = renderAuthenticated(<AppShell><p>Apps</p></AppShell>, {
      capabilities: { billing: true },
      route: checkoutReturnPathFor("pro", "acct-other"),
    });
    await waitFor(() => expect(router.location.search).toBe(""));
    expect(loading).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/billing/status?account=acct-other"))).toBe(false);
  });

  it("stops, saying nothing, once the gateway says another account is selected (Sol 7b-8)", async () => {
    const success = vi.spyOn(toast, "success");
    const info = vi.spyOn(toast, "info");
    const dismiss = vi.spyOn(toast, "dismiss");
    const fetchMock = stubBilling(PAID);
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      String(input).includes("/billing/status?account=")
        ? new Response(JSON.stringify({ error: { code: "account_changed", message: "changed" } }), { status: 409 })
        : answer(input, init),
    );
    renderAuthenticated(<AppShell><p>Apps</p></AppShell>, { capabilities: { billing: true }, route: checkoutReturnPathFor("pro", "acct-1") });
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith("checkout-return"));
    expect(success).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    // The page's own read and the one confirming read, neither retried.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/billing/status?account="))).toHaveLength(2);
  });

  it("stops, saying nothing, when the person switches accounts while the payment is being confirmed (Sol 7b-8)", async () => {
    const success = vi.spyOn(toast, "success");
    const info = vi.spyOn(toast, "info");
    const dismiss = vi.spyOn(toast, "dismiss");
    const fetchMock = stubBilling(PAID);
    const answer = fetchMock.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes("/billing/status")) await held;
      return answer(input, init);
    });
    let switchTo!: (accountId: string) => void;
    function Switchable({ children }: { children: ReactNode }) {
      const [accountId, setAccountId] = useState("acct-1");
      switchTo = setAccountId;
      const session = testSession({
        account: { id: accountId, name: accountId },
        accounts: [membership("acct-1", "Acme"), membership("acct-2", "Other")],
      });
      return <ConsoleSessionProvider session={session} capabilities={{ ...CAPABILITIES, billing: true }}>{children}</ConsoleSessionProvider>;
    }
    const { client } = renderAuthenticated(<Switchable><AppShell><p>Apps</p></AppShell></Switchable>, {
      capabilities: { billing: true },
      route: checkoutReturnPathFor("pro", "acct-1"),
    });
    await waitFor(() => expect(statusReads(fetchMock)).toBeGreaterThanOrEqual(1));
    act(() => switchTo("acct-2"));
    expect(dismiss).toHaveBeenCalledWith("checkout-return");
    // The read for the first account lands afterwards, showing the plan bought: nothing is announced.
    release();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/billing/status?account=acct-2"))).toBe(true));
    await settled(client);
    expect(success).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("announces nothing on a console without billing, and still takes the marker off", async () => {
    const loading = vi.spyOn(toast, "loading");
    const success = vi.spyOn(toast, "success");
    const fetchMock = stubBilling(PAID);
    const { router } = renderAuthenticated(<AppShell><p>Apps</p></AppShell>, {
      capabilities: { billing: false },
      route: checkoutReturnPathFor("pro", "acct-1"),
    });
    await waitFor(() => expect(router.location.search).toBe(""));
    expect(loading).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(statusReads(fetchMock)).toBe(0);
  });
});
