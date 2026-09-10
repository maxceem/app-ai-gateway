import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LimitsTab } from "./limits";
import { useAppDraft } from "@/hooks/use-app-draft";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { LimitsConfig } from "@/lib/config-types";

const APP_ID = "my-app";

function appRow(limits?: LimitsConfig) {
  return {
    id: APP_ID,
    name: "My app",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    config: {
      // Per-user limits only render for an application that identifies its
      // users, which is what these tests are about.
      authentication: {
        type: "api_key",
        end_user: { source: "header", header: "x-end-user-id" },
      },
      routing: { providers: { mode: "all" }, model_rewrites: {} },
      ...(limits === undefined ? {} : { limits }),
    },
  };
}

function Harness() {
  const state = useAppDraft(APP_ID);
  return state.draft ? <LimitsTab state={state} /> : null;
}

function renderTab(limits?: LimitsConfig) {
  stubApi({
    [`/v1/admin/apps/${APP_ID}`]: {
      body: { app: appRow(limits), resolved: null, config_error: null },
    },
  });
  return renderAuthenticated(<Harness />);
}

const configured: LimitsConfig = {
  per_user: { requests: { per_minute: 30, per_day: 1000 }, spending: { monthly_usd: 10 } },
  per_app: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
};

afterEach(() => vi.unstubAllGlobals());

describe("LimitsTab", () => {
  /**
   * The whole reason this tab has copy above the cards. An operator reading it
   * has a plan allowance on another page, and the two are unrelated quotas over
   * different populations; the page has to say so before it shows a number.
   */
  it("says whose limits these are, and points at the plan allowance as separate", async () => {
    renderTab(configured);

    expect(await screen.findByText(/your app's end users/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: /plan allowance/i });
    expect(link.getAttribute("href")).toBe("/billing");
  });

  it("renders an app with no limits block as unlimited rather than empty", async () => {
    renderTab();

    // Every field is a placeholder, not a zero: an absent block is unlimited,
    // and showing 0 would read as "no requests allowed".
    const rpm = await screen.findByLabelText("Requests per minute", { selector: "#rpm" });
    expect(rpm).toHaveProperty("value", "");
    expect(rpm.getAttribute("placeholder")).toBe("Unlimited");
    expect(screen.getAllByText("Unlimited").length).toBeGreaterThan(0);
  });

  it("shows the stored per-user and per-app values in their own cards", async () => {
    renderTab(configured);

    expect(await screen.findByLabelText("Requests per minute", { selector: "#rpm" }))
      .toHaveProperty("value", "30");
    expect(screen.getByLabelText("Requests per day", { selector: "#rpd" }))
      .toHaveProperty("value", "1000");
    expect(screen.getByLabelText("Monthly spending budget (USD)", { selector: "#budget" }))
      .toHaveProperty("value", "10");
    // The app-wide scope is a separate card and is untouched by the per-user one.
    expect(screen.getByLabelText("Requests per minute", { selector: "#app-rpm" }))
      .toHaveProperty("value", "");
  });

  it("edits one field without disturbing the rest of the scope", async () => {
    renderTab(configured);

    const rpm = await screen.findByLabelText("Requests per minute", { selector: "#rpm" });
    await userEvent.clear(rpm);
    await userEvent.type(rpm, "45");

    await waitFor(() => expect(rpm).toHaveProperty("value", "45"));
    expect(screen.getByLabelText("Requests per day", { selector: "#rpd" }))
      .toHaveProperty("value", "1000");
    expect(screen.getByLabelText("Monthly spending budget (USD)", { selector: "#budget" }))
      .toHaveProperty("value", "10");
  });

  /** Empty is how an operator says "unlimited"; it must not become zero. */
  it("clears a limit to unlimited rather than to zero", async () => {
    renderTab(configured);

    const rpd = await screen.findByLabelText("Requests per day", { selector: "#rpd" });
    await userEvent.clear(rpd);

    await waitFor(() => expect(rpd).toHaveProperty("value", ""));
    expect(rpd.getAttribute("placeholder")).toBe("Unlimited");
  });

  it("warns that a budget is settled after a request completes", async () => {
    renderTab(configured);

    expect(await screen.findByText(/stops the request after the one that crosses it/i))
      .toBeTruthy();
  });
});
