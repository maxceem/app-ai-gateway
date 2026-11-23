/**
 * The return from a completed checkout: the payment confirmation on the page
 * the provider sends the person back to. The billing service is stubbed:
 * nothing is bought.
 */
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { PLAN_CONFIRM_CHECKS, PLAN_CONFIRM_INTERVAL_MS, stopPaymentConfirmation } from "./checkout-return";
import { useSignOut } from "./queries";
import { setTabAccount } from "./tab-account";
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

/** Where a completed checkout for the pro plan, started in `accountId`, sends the person back. */
const returnFor = (accountId: string) => `/apps?checkout=success&plan=pro&account=${accountId}`;

beforeEach(() => {
  // The tab acts in the account the session shows, as after any page load.
  setTabAccount("acct-1");
});

afterEach(() => {
  stopPaymentConfirmation();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the return from a completed checkout", () => {
  const statusReads = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter(([url]) => String(url).includes("/billing/status")).length;

  it("says the payment is being confirmed, then complete once the billing service reports the plan bought, and takes the marker off", async () => {
    const loading = vi.spyOn(toast, "loading");
    const success = vi.spyOn(toast, "success");
    stubBilling(PAID);
    const { router } = renderAuthenticated(<AppShell><p>Apps</p></AppShell>, {
      capabilities: { billing: true },
      route: returnFor("acct-1"),
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
    renderAuthenticated(<AppShell><p>Apps</p></AppShell>, { capabilities: { billing: true }, route: returnFor("acct-1") });
    for (let check = 0; check < PLAN_CONFIRM_CHECKS + 2; check += 1) {
      await act(() => vi.advanceTimersByTimeAsync(PLAN_CONFIRM_INTERVAL_MS));
    }
    await waitFor(() => expect(info).toHaveBeenCalledWith("Payment received", expect.anything()));
    expect(success).not.toHaveBeenCalledWith("Payment complete", expect.anything());
    // The page's own status read may add one; the confirming reads stop at the cap.
    expect(statusReads(fetchMock)).toBeLessThanOrEqual(PLAN_CONFIRM_CHECKS + 1);
  });

  it("reads the plan in its own reads, each one stoppable and never retried (Sol 7b-8)", async () => {
    const success = vi.spyOn(toast, "success");
    const fetchMock = stubBilling(PAID);
    renderAuthenticated(<AppShell><p>Apps</p></AppShell>, { capabilities: { billing: true }, route: returnFor("acct-1") });
    await waitFor(() => expect(success).toHaveBeenCalledWith("Payment complete", expect.anything()));
    const reads = fetchMock.mock.calls.filter(([url]) => String(url).includes("/billing/status"));
    expect(reads.length).toBeGreaterThanOrEqual(1);
    for (const [, init] of reads) expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("shows nothing for a return that names another account than the tab's (Sol 7b-8)", async () => {
    const loading = vi.spyOn(toast, "loading");
    const success = vi.spyOn(toast, "success");
    const info = vi.spyOn(toast, "info");
    stubBilling(PAID);
    const { router } = renderAuthenticated(<AppShell><p>Apps</p></AppShell>, {
      capabilities: { billing: true },
      route: returnFor("acct-other"),
    });
    await waitFor(() => expect(router.location.search).toBe(""));
    expect(loading).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("takes the confirming notice down on signing out (Sol 7b-8)", async () => {
    const loading = vi.spyOn(toast, "loading");
    const dismiss = vi.spyOn(toast, "dismiss");
    const success = vi.spyOn(toast, "success");
    const fetchMock = stubBilling(PAID);
    const answer = fetchMock.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes("/sign-out")) return new Response(JSON.stringify({ success: true }), { status: 200 });
      if (String(input).includes("/billing/status")) await held;
      return answer(input, init);
    });
    const { client } = renderAuthenticated(<AppShell><p>Apps</p></AppShell>, { capabilities: { billing: true }, route: returnFor("acct-1") });
    await waitFor(() => expect(loading).toHaveBeenCalledWith("Confirming your payment…", expect.anything()));
    expect(dismiss).not.toHaveBeenCalledWith("checkout-return");
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSignOut(), { wrapper });
    await act(() => result.current.mutateAsync());
    expect(dismiss).toHaveBeenCalledWith("checkout-return");
    release();
    await act(async () => undefined);
    expect(success).not.toHaveBeenCalled();
  });

  it("stops, and takes its notice down, once the tab acts in another account (Sol 7b-8)", async () => {
    const success = vi.spyOn(toast, "success");
    const dismiss = vi.spyOn(toast, "dismiss");
    const fetchMock = stubBilling(PAID);
    const answer = fetchMock.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes("/billing/status")) await held;
      return answer(input, init);
    });
    renderAuthenticated(<AppShell><p>Apps</p></AppShell>, { capabilities: { billing: true }, route: returnFor("acct-1") });
    await waitFor(() => expect(statusReads(fetchMock)).toBeGreaterThanOrEqual(1));
    // The tab is moving to another account (the page reloads on it next).
    setTabAccount("acct-2");
    release();
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith("checkout-return"));
    expect(success).not.toHaveBeenCalled();
  });

  it("keeps confirming through a development double mount (Sol 7b-8)", async () => {
    const success = vi.spyOn(toast, "success");
    const dismiss = vi.spyOn(toast, "dismiss");
    stubBilling(PAID);
    renderAuthenticated(<StrictMode><AppShell><p>Apps</p></AppShell></StrictMode>, { capabilities: { billing: true }, route: returnFor("acct-1") });
    await waitFor(() => expect(success).toHaveBeenCalledWith("Payment complete", expect.anything()));
    expect(dismiss).not.toHaveBeenCalledWith("checkout-return");
  });

  it("announces nothing on a console without billing, and still takes the marker off", async () => {
    const loading = vi.spyOn(toast, "loading");
    const success = vi.spyOn(toast, "success");
    const fetchMock = stubBilling(PAID);
    const { router } = renderAuthenticated(<AppShell><p>Apps</p></AppShell>, {
      capabilities: { billing: false },
      route: returnFor("acct-1"),
    });
    await waitFor(() => expect(router.location.search).toBe(""));
    expect(loading).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(statusReads(fetchMock)).toBe(0);
  });
});
