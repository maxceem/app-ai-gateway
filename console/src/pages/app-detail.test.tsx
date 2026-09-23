import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { screen } from "@testing-library/react";
import { AppDetailPage } from "./app-detail";
import { renderAuthenticated, stubApi } from "@/test/render";

const APP_ID = "my-app";

const APP_ROW = {
  id: APP_ID,
  revision: 1,
  name: "My app",
  status: "active",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  config: {
    authentication: { type: "api_key" },
    routing: { providers: { mode: "all" }, model_rewrites: {} },
  },
};

/** A registered user who has spent something, for the users table. */
const USER = {
  id: "user-1",
  status: "active",
  attest_key_id: "attest-key",
  attest_registered: true,
  // Carried by the API and deliberately not drawn: see the test below.
  attest_counter: 42,
  created_at: "2026-09-01T00:00:00.000Z",
  last_seen_at: "2026-09-18T00:00:00.000Z",
  is_virtual: false,
  usage: {
    requests: 10,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    cost_usd: 3,
    errors: 0,
    blocked: 0,
  },
};

/** `limits` with a per-user monthly budget of `monthlyUsd`; `null` is unlimited. */
function limits(monthlyUsd: number | null) {
  const scope = {
    requests: { per_minute: null, per_day: null },
    spending: { monthly_usd: monthlyUsd },
  };
  return { per_user: scope, per_app: scope };
}

function renderSection(
  tab: string,
  { config, users = [] }: { config?: Record<string, unknown>; users?: unknown[] } = {},
) {
  const authentication = config?.limits && config.authentication === undefined
    ? { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } }
    : APP_ROW.config.authentication;
  const app = {
    ...APP_ROW,
    config: { ...APP_ROW.config, authentication, ...config },
  };
  stubApi({
    // Longest prefixes first: `stubApi` matches the first key that prefixes the
    // URL, and the app row's own path prefixes all of these.
    [`/v1/admin/apps/${APP_ID}/usage`]: { body: { app_id: APP_ID, requests: 0 } },
    [`/v1/admin/apps/${APP_ID}/users`]: {
      body: { app_id: APP_ID, total: users.length, users },
    },
    [`/v1/admin/apps/${APP_ID}/keys`]: { body: { app_id: APP_ID, keys: [] } },
    [`/v1/admin/apps/${APP_ID}`]: { body: { app, config_error: null } },
  });
  return renderAuthenticated(
    <Routes>
      <Route path="/apps/:appId/:tab/:section?" element={<AppDetailPage />} />
    </Routes>,
    { route: `/apps/${APP_ID}/${tab}` },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("AppDetailPage", () => {
  it("renders malformed stored JSON in the repair editor without opening structured tabs", async () => {
    const app = {
      ...APP_ROW,
      config: { authentication: { type: "api_key" }, legacy_field: { keep: true } },
    };
    stubApi({
      [`/v1/admin/apps/${APP_ID}`]: {
        body: { app, config_error: "Invalid routing configuration" },
      },
    });
    renderAuthenticated(
      <Routes>
        <Route path="/apps/:appId/:tab" element={<AppDetailPage />} />
      </Routes>,
      { route: `/apps/${APP_ID}/proxy` },
    );

    expect(await screen.findByRole("heading", { name: "Repair configuration JSON" })).toBeTruthy();
    expect(screen.getByText("My app")).toBeTruthy();
    expect(screen.getByText(/my-app/)).toBeTruthy();
    expect(await screen.findByText(/legacy_field/)).toBeTruthy();
    expect(screen.getByText(/keep/)).toBeTruthy();
    expect(screen.queryByText(/provider access/i)).toBeNull();
  });

  it("heads the content with the section the sidebar is pointing at", async () => {
    renderSection("auth");
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Auth policy");
  });

  it("keeps the app's own actions off the header", async () => {
    renderSection("overview");

    // Turning the app off and deleting it are Settings' business; a menu that
    // followed every section would say they belong to all of them.
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(screen.queryByRole("button", { name: /more actions/i })).toBeNull();
  });

  it("names every section by the same words the rail uses", async () => {
    for (const [tab, label] of [
      ["overview", "Overview"],
      ["proxy", "Proxy policy"],
      ["limits", "Limits"],
      ["settings", "Settings"],
    ] as const) {
      const { unmount } = renderSection(tab);
      expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(label);
      unmount();
    }
  });

  it("offers the month only where the page counts one", async () => {
    const overview = renderSection("overview");
    expect(await screen.findByLabelText("Month")).toBeTruthy();
    overview.unmount();

    renderSection("settings");
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    expect(screen.queryByLabelText("Month")).toBeNull();
  });
});

describe("a tab the app does not have", () => {
  it("sends a stale or mistyped section to the default one", async () => {
    renderSection("not-a-section");

    // The page settles on Overview rather than showing one section's content
    // under another section's name.
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Overview");
    expect(screen.queryByText(/named endpoints/i)).toBeNull();
  });

  it("catches the section slug that was renamed out from under old bookmarks", async () => {
    // `auth-events` was this page's Errors tab until it was renamed, so anyone
    // who bookmarked it is the likeliest visitor to an unknown tab.
    renderSection("auth-events");

    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Overview");
  });
});

describe("the users table", () => {
  it("measures each user against the per-user budget the app sets", async () => {
    renderSection("users", { config: { limits: limits(4) }, users: [USER] });

    const bar = await screen.findByRole("progressbar", { name: /monthly budget used/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("3");
    expect(bar.getAttribute("aria-valuemax")).toBe("4");
    expect(bar.getAttribute("aria-valuetext")).toBe("$3.00 of $4.00");
    // The column reports a budget now, not a bare cost.
    expect(screen.getByRole("columnheader", { name: "Budget" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Cost" })).toBeNull();
  });

  it("reports a user as unlimited when the app sets no budget at all", async () => {
    renderSection("users", { users: [USER] });

    expect(await screen.findByTitle(/no monthly budget/i)).toBeTruthy();
    expect(screen.queryByRole("progressbar", { name: /monthly budget used/i })).toBeNull();
  });

  it("keeps the App Attest assertion counter out of the table", async () => {
    renderSection("users", { config: { limits: limits(4) }, users: [USER] });

    // Registration is worth saying; the number of assertions the key has ever
    // signed is an implementation detail no operator acts on.
    expect(await screen.findByText("registered")).toBeTruthy();
    expect(screen.queryByText(/counter/i)).toBeNull();
    expect(screen.queryByText("42")).toBeNull();
  });
});
