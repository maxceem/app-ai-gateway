import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./app-shell";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { AppSummary } from "@/lib/types";

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
  },
};

/** The same app as a backend with a key, older than the iOS one. */
const backend: AppSummary = {
  ...app,
  id: "server-app",
  name: "Backend",
  authentication_type: "api_key",
  created_at: "2026-08-01T00:00:00.000Z",
};

/**
 * The shell around an empty page, so what is on screen is the rail. The
 * checklist reads the same lists the pages do, which are stubbed here.
 */
function renderRail(
  {
    apps = [],
    providers = [],
    hasProxiedRequests = false,
  }: { apps?: AppSummary[]; providers?: unknown[]; hasProxiedRequests?: boolean },
  options: Parameters<typeof renderAuthenticated>[1] = {},
) {
  stubApi({
    ...Object.fromEntries(apps.map((entry) => [`${APPS_URL}/${entry.id}`, { body: {
      app: {
        revision: 1,
        id: entry.id,
        name: entry.name,
        status: entry.status,
        created_at: entry.created_at,
        updated_at: entry.created_at,
        config: {
          authentication: entry.authentication_type === "apple_app_attest"
            ? {
                type: "apple_app_attest",
                app_attest: {
                  team_id: "ABCDE12345",
                  bundle_id: entry.apple_bundle_id ?? "com.example.app",
                },
                end_user: { source: "app_install" },
              }
            : { type: "api_key", end_user: { source: "none" } },
          routing: {
            providers: {
              mode: "selected",
              selected: {
                openai: { allowed_paths: ["v1/responses"], allowed_models: ["configured-model"] },
              },
            },
            model_rewrites: {},
          },
        },
      },
    } }])),
    "/v1/admin/prices": { body: { prices: {} } },
    [APPS_URL]: {
      body: { month: "2026-09", has_proxied_requests: hasProxiedRequests, apps },
    },
    [PROVIDERS_URL]: { body: { providers } },
  });
  return renderAuthenticated(<AppShell>content</AppShell>, { route: "/apps", ...options });
}

/** The checklist, once it is up. */
const checklist = () => screen.findByRole("region", { name: /start in 3 steps/i });

/** The step whose label matches, as the list item holding it. */
function step(label: RegExp): HTMLElement {
  const item = screen.getByText(label, { selector: "span" }).closest("li");
  if (!item) throw new Error(`no step found for ${label}`);
  return item;
}

/** Opens the example and returns the code it shows. */
async function openExample() {
  await userEvent.click(screen.getByRole("button", { name: /show code example/i }));
  const dialog = await screen.findByRole("dialog", { name: /send your first request/i });
  const code = await within(dialog).findByText((_, element) => element?.tagName === "CODE" && !!element.closest("pre"));
  return { dialog, code };
}

describe("the first-run checklist", () => {
  it("offers the setup actions, and the quickstart, before setup is complete", async () => {
    renderRail({});

    const region = await checklist();
    // Each pending step keeps its number and its control.
    expect(within(step(/add provider/i)).getByText("1")).toBeTruthy();
    expect(within(step(/add provider/i)).getByRole("button", { name: /^add$/i })).toBeTruthy();
    expect(within(step(/create app/i)).getByRole("button", { name: /^create$/i })).toBeTruthy();
    expect(screen.queryByRole("img", { name: /provider added/i })).toBeNull();
    expect(screen.queryByRole("img", { name: /app created/i })).toBeNull();

    // Waiting, and the example, start only after both prerequisites exist.
    const sending = step(/send a request/i);
    expect(within(sending).queryByRole("status", { name: /waiting for your first request/i })).toBeNull();
    expect(within(sending).queryByRole("button", { name: /show code example/i })).toBeNull();
    expect(within(sending).getByRole("link", { name: /quickstart/i }).getAttribute("href"))
      .toBe("https://docs.appaigateway.com/quickstart/");
    expect(region.contains(sending)).toBe(true);
  });

  it("stays out of the navigation, which is for destinations", async () => {
    renderRail({});

    await checklist();
    expect(screen.getByRole("navigation").querySelectorAll("a")).toHaveLength(2);
  });

  it("marks the provider step done once the organization has one, keeping it in place", async () => {
    renderRail({ providers: [provider] });

    await checklist();
    await waitFor(() => expect(screen.getByRole("img", { name: /provider added/i })).toBeTruthy());
    const added = step(/add provider/i);
    // The control is replaced rather than left to be pressed again, and the
    // step is not collapsed away: progress stays visible.
    expect(within(added).queryByRole("button", { name: /^add$/i })).toBeNull();
    expect(within(step(/create app/i)).getByRole("button", { name: /^create$/i })).toBeTruthy();
    expect(screen.queryByRole("status", { name: /waiting for your first request/i })).toBeNull();
  });

  it("waits, and offers the example, once a provider and an app both exist", async () => {
    renderRail({ apps: [app], providers: [provider] });

    await checklist();
    await waitFor(() => expect(screen.getByRole("img", { name: /provider added/i })).toBeTruthy());
    expect(screen.getByRole("img", { name: /app created/i })).toBeTruthy();
    expect(screen.getByRole("status", { name: /waiting for your first request/i })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /quickstart/i })).toBeNull();
    // The code waits behind a button: the rail is narrow, and the example is not.
    expect(screen.queryByText(/import AppAIGateway/)).toBeNull();
    expect(screen.getByRole("button", { name: /show code example/i })).toBeTruthy();
  });

  it("walks an iOS app through the Swift package before its example", async () => {
    renderRail({ apps: [app], providers: [provider] });

    await checklist();
    await screen.findByRole("button", { name: /show code example/i });
    const { dialog, code } = await openExample();

    expect(code.textContent).toContain("import AppAIGateway");
    expect(code.textContent).toContain('appID: "app-1"');
    expect(code.textContent).toContain("authMode: .appAttestInstall");
    // What to add in Xcode, and where the longer guide is.
    expect(within(dialog).getByText("https://github.com/maxceem/app-ai-gateway-swift")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: /ios integration guide/i }).getAttribute("href"))
      .toBe("https://docs.appaigateway.com/integrate/ios/");
    expect(within(dialog).queryByText(/API_KEY/)).toBeNull();
  });

  it("uses the oldest app's API authentication for the example", async () => {
    renderRail({ apps: [app, backend], providers: [provider] });

    await checklist();
    await screen.findByRole("button", { name: /show code example/i });
    const { dialog, code } = await openExample();

    expect(code.textContent).toContain("curl --fail-with-body");
    expect(code.textContent).toContain("/v1/apps/server-app/proxy/openai/v1/responses");
    expect(code.textContent).toContain("Bearer API_KEY");
    expect(code.textContent).toContain('"model":"configured-model","input":"Say hello."');
    expect(code.textContent).not.toContain("YOUR_");
    expect(within(dialog).getByRole("link", { name: "your API key" }).getAttribute("href"))
      .toBe("/apps/server-app/auth/identity");
    expect(within(dialog).queryByText(/import AppAIGateway/)).toBeNull();
  });

  /**
   * The snippet is pasted into a real application, so it has to name the host
   * that application calls. On a deployment that publishes a separate API
   * domain that is not this console's own origin, and only the deployment can
   * say so.
   */
  it("points the example at the deployment's API host when one is configured", async () => {
    renderRail(
      { apps: [backend], providers: [provider] },
      { capabilities: { apiBaseUrl: "https://api.example.com" } },
    );

    await checklist();
    await screen.findByRole("button", { name: /show code example/i });
    const { code } = await openExample();

    expect(code.textContent).toContain("https://api.example.com/v1/apps/server-app/proxy/openai/");
    expect(code.textContent).not.toContain(window.location.origin);
  });

  it("copies the example to the clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...window.navigator, clipboard: { writeText } });
    renderRail({ apps: [backend], providers: [provider] });

    await checklist();
    await screen.findByRole("button", { name: /show code example/i });
    const { dialog, code } = await openExample();
    await userEvent.click(within(dialog).getByRole("button", { name: /^copy$/i }));

    expect(writeText).toHaveBeenCalledWith(code.textContent);
    expect(await within(dialog).findByRole("button", { name: /copied/i })).toBeTruthy();
  });

  it("closes the example when its API key link is followed", async () => {
    const { router } = renderRail({ apps: [backend], providers: [provider] });

    await checklist();
    await screen.findByRole("button", { name: /show code example/i });
    const { dialog } = await openExample();
    await userEvent.click(within(dialog).getByRole("link", { name: "your API key" }));

    await waitFor(() => expect(router.location.pathname).toBe("/apps/server-app/auth/identity"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /send your first request/i })).toBeNull());
  });

  it("does not wait or offer code when only an app exists", async () => {
    renderRail({ apps: [app] });

    await checklist();
    await waitFor(() => expect(screen.getByRole("img", { name: /app created/i })).toBeTruthy());
    expect(screen.queryByRole("status", { name: /waiting for your first request/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /show code example/i })).toBeNull();
    expect(screen.getByRole("link", { name: /quickstart/i })).toBeTruthy();
  });

  it("stays up inside the app that was just created, where the last step is done", async () => {
    renderRail({ apps: [app], providers: [provider] }, { route: "/apps/app-1/providers" });

    expect(await screen.findByText("Calorie Tracker")).toBeTruthy();
    await checklist();
    expect(await screen.findByRole("button", { name: /show code example/i })).toBeTruthy();
  });

  it("retires once the organization has ever proxied a request", async () => {
    renderRail({ apps: [app], providers: [provider], hasProxiedRequests: true });

    // Waits for the rail to have settled, so "absent" is a conclusion rather
    // than a race won.
    await waitFor(() => expect(screen.getByRole("link", { name: /providers/i })).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("region", { name: /start in 3 steps/i })).toBeNull();
    expect(screen.queryByText(/waiting for the first request/i)).toBeNull();
  });

  it("does not come back for a month the organization happened to send nothing in", async () => {
    // The month's usage is all zeroes, which is exactly the case a month-scoped
    // signal would misread as a brand-new organization.
    const quiet = { ...app, usage: { ...app.usage, requests: 0, cost_usd: 0 } };
    const fetchMock = renderRail({ apps: [quiet], providers: [provider], hasProxiedRequests: true });

    await waitFor(() => expect(screen.getByRole("link", { name: /providers/i })).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("region", { name: /start in 3 steps/i })).toBeNull();
    // Nor does a console past its first request ask for the providers list
    // on every page it opens.
    expect(fetchMock).toBeTruthy();
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .some(([input]) => String(input).startsWith(PROVIDERS_URL))).toBe(false);
  });

  it("explains to a read-only member why they cannot do the steps themselves", async () => {
    renderRail({}, { session: { role: "member" } });

    await checklist();
    // The same guard the rest of the console uses; both controls carry it.
    expect(screen.getByRole("button", { name: /^add$/i })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /^create$/i })).toHaveProperty("disabled", true);
  });
});
