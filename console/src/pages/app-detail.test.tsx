import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { AppDetailPage } from "./app-detail";
import { renderAuthenticated, stubApi } from "@/test/render";

const APP = {
  id: "my-app",
  name: "My app",
  status: "active",
  config: {
    authentication: {
      type: "api_key",
      end_user: { header: "x-end-user-id", required: false, fallback: "api_key" },
    },
    routing: { providers: { mode: "all" }, model_rewrites: {} },
    limits: {
      per_user: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
      per_app: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
    },
  },
};

const LIMIT = { requestsPerMinute: null, requestsPerDay: null, monthlyBudgetMicrousd: null };

const RESOLVED = {
  id: APP.id,
  name: APP.name,
  authentication: APP.config.authentication,
  routing: { providerMode: "all", providers: undefined, modelRewrites: {} },
  limits: { perUser: LIMIT, perApp: LIMIT },
  status: APP.status,
};

function renderDetail(role: "owner" | "member") {
  stubApi({
    "/v1/admin/apps/my-app": { body: { app: APP, resolved: RESOLVED, config_error: null } },
  });
  return renderAuthenticated(
    <Routes>
      <Route path="/apps/:appId/:tab" element={<AppDetailPage />} />
    </Routes>,
    { session: { role }, route: "/apps/my-app/overview" },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("AppDetailPage actions menu", () => {
  it("disables destructive app actions for a read-only member", async () => {
    renderDetail("member");

    await userEvent.click(await screen.findByRole("button", { name: /more actions/i }));

    // Visible but inert, and the menu says why rather than leaving it a mystery.
    expect(await screen.findByRole("menuitem", { name: /delete app/i }))
      .toHaveProperty("ariaDisabled", "true");
    expect(screen.getByRole("menuitem", { name: /disable app/i }))
      .toHaveProperty("ariaDisabled", "true");
    expect(screen.getByText(/read-only/i)).toBeTruthy();
  });

  it("leaves them available to an owner", async () => {
    renderDetail("owner");

    await userEvent.click(await screen.findByRole("button", { name: /more actions/i }));

    expect(await screen.findByRole("menuitem", { name: /delete app/i }))
      .toHaveProperty("ariaDisabled", null);
    expect(screen.queryByText(/read-only/i)).toBeNull();
  });

  it("keeps validation available to a member, matching the server's exemption", async () => {
    renderDetail("member");

    // The gateway exempts /validate from its owner/admin mutation gate.
    // It is also disabled until the draft loads, so wait for that first.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /validate/i }))
        .toHaveProperty("disabled", false));
  });
});
