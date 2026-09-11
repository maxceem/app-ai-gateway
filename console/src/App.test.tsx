import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CAPABILITIES_URL, capabilities, renderPublic, stubApi, testSession } from "@/test/render";

const SESSION_URL = "/v1/admin/session";
const PLANS_URL = "/v1/admin/billing/plans";
const STATUS_URL = "/v1/admin/billing/status";
const CHECKOUT_URL = "/v1/admin/billing/checkout";
const SIGN_UP_URL = "/v1/auth/sign-up/email";

afterEach(() => vi.unstubAllGlobals());

const CATALOG = {
  plans: [
    { planKey: "free", name: "Free", description: "", features: [], trialDays: 0, prices: [] },
    {
      planKey: "growth",
      name: "Growth",
      description: "",
      features: [],
      trialDays: 0,
      prices: [{ billingPeriod: "month", priceAmountCents: 3900, priceCurrency: "USD" }],
    },
    {
      planKey: "scale",
      name: "Scale",
      description: "",
      features: [],
      trialDays: 0,
      prices: [{ billingPeriod: "month", priceAmountCents: 14900, priceCurrency: "USD" }],
    },
  ],
};

/** The free default plan, which is what a brand-new organization always holds. */
const FREE_STATUS = {
  access: {
    state: "billed",
    plan: {
      planKey: "free",
      planName: "Free",
      limits: { maxRequestsPerMonth: 1000 },
      isDefault: true,
    },
    subscription: null,
  },
  quota: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/**
 * A console that sells plans, with the sign-up route able to change the answer
 * `/session` gives — which is what a real sign-up does, and what every
 * assertion about where it lands afterwards depends on.
 */
function stubBillingConsole({ authenticated = true }: { authenticated?: boolean } = {}) {
  let signedIn = authenticated;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(CAPABILITIES_URL)) {
      return json(capabilities({ billing: true, registrationOpen: true }).body);
    }
    if (url.startsWith(SIGN_UP_URL)) {
      signedIn = true;
      return json({ ok: true });
    }
    if (url.startsWith(SESSION_URL)) {
      return signedIn
        ? json({ session: testSession() })
        : json({ error: { code: "auth_required" } }, 401);
    }
    if (url.startsWith(STATUS_URL)) return json(FREE_STATUS);
    if (url.startsWith(PLANS_URL)) return json(CATALOG);
    if (url.startsWith(CHECKOUT_URL)) return json({ url: "https://checkout.example/session" });
    if (url.startsWith("/v1/admin/apps")) return json({ apps: [], totals: null });
    return json({ error: { code: "not_found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);

  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, origin: "https://console.test", assign });
  return { fetchMock, assign };
}

const checkoutCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([input]) => String(input).startsWith(CHECKOUT_URL));

describe("console bootstrap", () => {
  it("waits for identity before deciding what to show", async () => {
    // Capabilities resolve immediately; the session never settles.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(CAPABILITIES_URL)) {
        return new Response(JSON.stringify(capabilities().body), { status: 200 });
      }
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { router } = renderPublic(<App />, { route: "/apps" });

    // Neither the console nor the sign-in screen may appear on a guess.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /management keys/i })).toBeNull();
    expect(router.location.pathname).toBe("/apps");
  });

  it("sends an unauthenticated operator to sign-in, preserving the deep link", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
      [SESSION_URL]: { status: 401, body: { error: { code: "auth_required" } } },
    });

    const { router } = renderPublic(<App />, { route: "/apps/my-app/usage" });

    await waitFor(() => expect(router.location.pathname).toBe("/login"));
    expect(router.location.search).toBe("?from=%2Fapps%2Fmy-app%2Fusage");
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeTruthy();
  });

  it("settles on the sign-in screen rather than looping between routes", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
      [SESSION_URL]: { status: 401, body: { error: { code: "auth_required" } } },
    });

    const { router } = renderPublic(<App />, { route: "/apps" });

    await waitFor(() => expect(router.location.pathname).toBe("/login"));
    const settled = router.location.pathname;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A redirect loop would bounce back to /apps and re-trigger the guard.
    expect(router.location.pathname).toBe(settled);
  });

  it("renders the console once identity resolves", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
      [SESSION_URL]: { body: { session: testSession() } },
      "/v1/admin/apps": { body: { apps: [], totals: null } },
    });

    renderPublic(<App />, { route: "/apps" });

    expect(await screen.findByRole("link", { name: /providers/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^sign in$/i })).toBeNull();
  });

  it("keeps an already-signed-in operator off the sign-in screen", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
      [SESSION_URL]: { body: { session: testSession() } },
      "/v1/admin/apps": { body: { apps: [], totals: null } },
    });

    const { router } = renderPublic(<App />, { route: "/login" });

    await waitFor(() => expect(router.location.pathname).toBe("/apps"));
  });
});

/**
 * A plan pressed on the marketing site reaches the console as `?plan=<key>` and
 * has to survive sign-up, sign-in, and an operator who turns out to be signed
 * in already. These cover each of those hops landing on the same checkout.
 */
describe("plan intent carried in from outside", () => {
  it("sends a new account to checkout for the plan they chose, not to the apps page", async () => {
    const { fetchMock } = stubBillingConsole({ authenticated: false });

    const { router } = renderPublic(<App />, { route: "/signup?plan=growth" });

    await userEvent.type(await screen.findByLabelText(/name/i), "Ada Lovelace");
    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.test");
    await userEvent.type(screen.getByLabelText(/password/i), "correct horse battery");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(router.location.pathname).toBe("/checkout"));
    expect(router.location.search).toBe("?plan=growth");
    await waitFor(() => expect(checkoutCalls(fetchMock)).toHaveLength(1));
  });

  it("keeps the plan on the sign-in link, so an existing customer does not lose it", async () => {
    stubBillingConsole({ authenticated: false });

    renderPublic(<App />, { route: "/signup?plan=growth" });

    const signIn = await screen.findByRole("link", { name: /sign in/i });
    expect(signIn.getAttribute("href")).toBe("/login?plan=growth");
  });

  it("sends an operator who is already signed in straight to checkout", async () => {
    stubBillingConsole();

    const { router } = renderPublic(<App />, { route: "/signup?plan=scale" });

    await waitFor(() => expect(router.location.pathname).toBe("/checkout"));
    expect(router.location.search).toBe("?plan=scale");
    expect(await screen.findByText(/redirecting you to checkout for scale/i)).toBeTruthy();
  });

  it("starts exactly one checkout and follows the URL the billing service returns", async () => {
    const { fetchMock, assign } = stubBillingConsole();

    // StrictMode double-invokes effects against the same instance, which is
    // precisely what would buy a customer two subscriptions.
    renderPublic(
      <StrictMode>
        <App />
      </StrictMode>,
      { route: "/checkout?plan=growth" },
    );

    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/session"));
    expect(checkoutCalls(fetchMock)).toHaveLength(1);
  });

  it("sends a request for the free plan to the console, having nothing to sell", async () => {
    const { fetchMock } = stubBillingConsole();

    const { router } = renderPublic(<App />, { route: "/checkout?plan=free" });

    await waitFor(() => expect(router.location.pathname).toBe("/apps"));
    expect(checkoutCalls(fetchMock)).toHaveLength(0);
  });

  it("sends an unknown plan to the billing page rather than nowhere", async () => {
    const { fetchMock } = stubBillingConsole();

    const { router } = renderPublic(<App />, { route: "/checkout?plan=enterprise" });

    await waitFor(() => expect(router.location.pathname).toBe("/billing"));
    expect(checkoutCalls(fetchMock)).toHaveLength(0);
  });

  it("ignores plan intent entirely on a self-hosted deployment", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities({ billing: false }),
      [SESSION_URL]: { body: { session: testSession() } },
      "/v1/admin/apps": { body: { apps: [], totals: null } },
    });

    const { router } = renderPublic(<App />, { route: "/checkout?plan=growth" });

    await waitFor(() => expect(router.location.pathname).toBe("/apps"));
  });
});
