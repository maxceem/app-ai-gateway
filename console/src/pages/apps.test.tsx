import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { AppsPage } from "./apps";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { AppSummary, BillingAccess, OrganizationQuota } from "@/lib/types";

afterEach(() => vi.unstubAllGlobals());

const APPS_URL = "/v1/admin/apps";
const PROVIDERS_URL = "/v1/admin/providers";

const provider = {
  id: "prov-1",
  organizationId: "org-1",
  type: "openai",
  slug: "openai",
  name: "OpenAI",
  status: "active",
  secretHint: "abcd",
  createdAt: "2026-09-01T00:00:00.000Z",
};

const FREE_ACCESS: BillingAccess = {
  state: "billed",
  plan: {
    planKey: "free",
    planName: "Free",
    limits: { maxRequestsPerMonth: 1000 },
    isDefault: true,
  },
  subscription: null,
};

const QUOTA: OrganizationQuota = {
  periodId: "free:2026-09-08T03:15:00.000Z",
  periodStart: "2026-09-08T03:15:00.000Z",
  periodEnd: "2026-10-08T03:15:00.000Z",
  used: 0,
  limit: 1000,
  resetAt: "2026-10-08T03:15:00.000Z",
};

const app: AppSummary = {
  id: "app-1",
  name: "Calorie Tracker",
  status: "active",
  authentication_type: "apple_app_attest",
  apple_bundle_id: "com.example.calories",
  created_at: "2026-09-01T00:00:00.000Z",
  providers: ["openai"],
  referenced_providers: ["openai"],
  allowed_model_count: 3,
  monthly_budget_usd: null,
  users: { total: 4, blocked: 0 },
  usage: {
    requests: 12,
    input_tokens: 100,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 40,
    cost_usd: 0.02,
    errors: 0,
    blocked: 0,
  },
};

function renderApps(
  {
    apps = [],
    providers = [],
    hasProxiedRequests = false,
  }: { apps?: AppSummary[]; providers?: unknown[]; hasProxiedRequests?: boolean },
  options: Parameters<typeof renderAuthenticated>[1] = {},
) {
  stubApi({
    ...Object.fromEntries(apps.map((entry) => [`${APPS_URL}/${entry.id}`, { body: {
      app: { config: { authentication: { type: entry.authentication_type } } },
      resolved: { routing: { providerMode: "selected", providers: { openai: { allowed_paths: ["v1/responses"], allowed_models: ["configured-model"] } } } },
    } }])),
    "/v1/admin/prices": { body: { prices: {} } },
    [APPS_URL]: {
      body: { month: "2026-09", has_proxied_requests: hasProxiedRequests, apps },
    },
    [PROVIDERS_URL]: { body: { providers } },
  });
  return renderAuthenticated(<AppsPage />, { route: "/apps", ...options });
}

/**
 * The step whose title matches, as the list item holding it. Matched on the
 * title element alone: a step's control can carry the same words as its title.
 */
function step(title: RegExp): HTMLElement {
  const heading = screen.getByText(title, { selector: "p" });
  const item = heading.closest("li");
  if (!item) throw new Error(`no step found for ${title}`);
  return item;
}

describe("the first-run checklist", () => {
  it("offers setup actions without waiting before setup is complete", async () => {
    renderApps({}, { capabilities: { billing: true }, billing: FREE_ACCESS, quota: QUOTA });

    expect(await screen.findByText(/start proxying in three steps/i)).toBeTruthy();
    expect(screen.queryByText(/you're on the Free plan/i)).toBeNull();
    expect(screen.queryByText(/need a bigger allowance/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /see plans/i })).toBeNull();

    // Pending steps keep their number and their control.
    expect(within(step(/add a provider key/i)).getByRole("button", { name: /add a provider/i }))
      .toBeTruthy();
    expect(within(step(/create an app/i)).getByRole("button", { name: /create an app/i }))
      .toBeTruthy();
    expect(screen.queryByText("Added")).toBeNull();
    expect(screen.queryByText("Created")).toBeNull();

    // Waiting starts only after both prerequisites exist.
    const sending = step(/send your first request/i);
    expect(within(sending).queryByRole("status", { name: /waiting for your first request/i })).toBeNull();
    expect(within(sending).getByRole("link", { name: /quickstart/i }).getAttribute("href"))
      .toBe("https://docs.appaigateway.com/quickstart/");
  });

  it("marks the provider step done once the organization has one, keeping it in place", async () => {
    renderApps(
      { providers: [provider] },
      { capabilities: { billing: true }, billing: FREE_ACCESS, quota: QUOTA },
    );

    await screen.findByText(/start proxying in three steps/i);
    await waitFor(() => expect(within(step(/add a provider key/i)).getByRole("img", { name: "Added" })).toBeTruthy());
    const added = step(/add a provider key/i);
    expect(within(added).getByText("1")).toBeTruthy();
    expect(screen.queryByText(/waiting for your first request/i)).toBeNull();
    // The control is replaced rather than left to be pressed again.
    expect(within(added).queryByRole("button", { name: /add a provider/i })).toBeNull();
    // Completed steps are not collapsed away: progress stays visible.
    expect(screen.getByText(/add a provider key/i)).toBeTruthy();
    expect(within(step(/create an app/i)).getByRole("button", { name: /create an app/i }))
      .toBeTruthy();
  });

  it("keeps the checklist below the apps table while no request has arrived", async () => {
    renderApps(
      { apps: [app], providers: [provider] },
      { capabilities: { billing: true }, billing: FREE_ACCESS, quota: QUOTA },
    );

    const checklist = await screen.findByText(/start proxying in three steps/i);
    await waitFor(() => expect(within(step(/add a provider key/i)).getByRole("img", { name: "Added" })).toBeTruthy());
    expect(within(step(/create an app/i)).getByRole("img", { name: "Created" })).toBeTruthy();
    expect(within(step(/create an app/i)).getByText("2")).toBeTruthy();
    expect(screen.getByRole("status", { name: /waiting for your first request/i })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /quickstart/i })).toBeNull();
    expect(await screen.findByText(/import AppAIGateway/)).toBeTruthy();

    // The app list comes first, with onboarding below it.
    const row = screen.getByRole("link", { name: /calorie tracker/i });
    expect(checklist.compareDocumentPosition(row)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    // "Requests" is both a stat-card label and a table column by now; Spend is not.
    expect(screen.getByText("Spend")).toBeTruthy();
  });

  it("uses the oldest app's API authentication for the request example", async () => {
    renderApps({
      apps: [app, { ...app, id: "server-app", name: "Backend", authentication_type: "api_key", created_at: "2026-08-01T00:00:00.000Z" }],
      providers: [provider],
    });
    const code = await screen.findByText(/curl --fail-with-body/);
    expect(code.textContent).toContain("/v1/apps/server-app/proxy/openai/");
    expect(code.textContent).toContain("Bearer API_KEY");
    expect(code.textContent).toContain("/proxy/openai/v1/responses");
    expect(code.textContent).toContain('"model":"configured-model","input":"Say hello."');
    expect(code.textContent).not.toContain("YOUR_");
    expect(code.textContent).not.toContain("request.json");
    expect(screen.getByRole("link", { name: "your API key" }).getAttribute("href")).toBe("/apps/server-app/auth/identity");
    expect(screen.queryByText(/import AppAIGateway/)).toBeNull();
  });

  it("does not wait or show code when only an app exists", async () => {
    renderApps({ apps: [app] });
    await screen.findByText(/start proxying in three steps/i);
    expect(screen.queryByText(/waiting for your first request/i)).toBeNull();
    expect(screen.queryByText(/import AppAIGateway/)).toBeNull();
    expect(screen.getByRole("link", { name: /quickstart/i })).toBeTruthy();
  });

  it("retires once the organization has ever proxied a request", async () => {
    renderApps(
      { apps: [app], providers: [provider], hasProxiedRequests: true },
      { capabilities: { billing: true }, billing: FREE_ACCESS, quota: QUOTA },
    );

    expect(await screen.findByRole("link", { name: /calorie tracker/i })).toBeTruthy();
    expect(screen.queryByText(/start proxying in three steps/i)).toBeNull();
    expect(screen.queryByText(/waiting for your first request/i)).toBeNull();
  });

  it("does not come back for a month the organization happened to send nothing in", async () => {
    // The month's usage is all zeroes, which is exactly the case a month-scoped
    // signal would misread as a brand-new organization.
    const quiet = { ...app, usage: { ...app.usage, requests: 0, cost_usd: 0 } };
    renderApps(
      { apps: [quiet], providers: [provider], hasProxiedRequests: true },
      { capabilities: { billing: true }, billing: FREE_ACCESS, quota: QUOTA },
    );

    expect(await screen.findByRole("link", { name: /calorie tracker/i })).toBeTruthy();
    expect(screen.queryByText(/start proxying in three steps/i)).toBeNull();
  });

  it("also keeps billing copy out of the self-hosted checklist", async () => {
    renderApps({}, { capabilities: { billing: false } });

    expect(await screen.findByText(/start proxying in three steps/i)).toBeTruthy();
    expect(screen.queryByText(/you're on the/i)).toBeNull();
    // Nothing to sell, so nothing to link to.
    expect(screen.queryByRole("link", { name: /see plans/i })).toBeNull();
  });

  it("explains to a read-only member why they cannot do the steps themselves", async () => {
    renderApps(
      {},
      { session: { role: "member" }, capabilities: { billing: true }, billing: FREE_ACCESS },
    );

    expect(await screen.findByText(/start proxying in three steps/i)).toBeTruthy();
    // The same guard the rest of the console uses; both controls carry it.
    expect(screen.getByRole("button", { name: /add a provider/i })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /create an app/i })).toHaveProperty("disabled", true);
  });

  it("keeps the totals above it, which read zero rather than being absent", async () => {
    renderApps({}, { capabilities: { billing: true }, billing: FREE_ACCESS, quota: QUOTA });

    expect(await screen.findByText(/start proxying in three steps/i)).toBeTruthy();
    expect(screen.getByText("Requests")).toBeTruthy();
    expect(screen.getByText("Spend")).toBeTruthy();
  });
});
