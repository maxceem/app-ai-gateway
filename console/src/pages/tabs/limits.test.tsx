import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LimitsTab } from "./limits";
import { useAppDraft } from "@/hooks/use-app-draft";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { LimitsConfig } from "@/lib/config-types";

const APP_ID = "my-app";

type EndUser = { source: "none" } | { source: "header"; header: string };
const IDENTIFIED: EndUser = { source: "header", header: "x-end-user-id" };

function appRow(limits?: LimitsConfig, end_user: EndUser = IDENTIFIED) {
  return {
    id: APP_ID,
    name: "My app",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    config: {
      // Per-user limits only render for an application that identifies its
      // users, which is what these tests are about.
      authentication: { type: "api_key", end_user },
      routing: { providers: { mode: "all" }, model_rewrites: {} },
      ...(limits === undefined ? {} : { limits }),
    },
  };
}

function Harness() {
  const state = useAppDraft(APP_ID);
  return state.draft ? <LimitsTab appId={APP_ID} state={state} /> : null;
}

function renderTab(limits?: LimitsConfig, end_user?: EndUser) {
  stubApi({
    [`/v1/admin/apps/${APP_ID}`]: {
      body: { app: appRow(limits, end_user) },
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
   * An app that identifies no users has nobody for a per-user limit to apply
   * to. The card keeps its place so the page reads the same for every app, but
   * its fields are off and the notice says where they are turned on.
   */
  it("keeps the per-user card, disabled, for an app that identifies no users", async () => {
    renderTab(undefined, { source: "none" });

    const rpm = await screen.findByLabelText("Requests per minute", { selector: "#rpm" });
    expect(rpm).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Requests per day", { selector: "#rpd" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText(/monthly spending budget/i, { selector: "#budget" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("link", { name: /turn on user authentication/i }).getAttribute("href"))
      .toBe(`/apps/${APP_ID}/auth/users`);
    // The application limits are unaffected.
    expect(screen.getByLabelText("Requests per minute", { selector: "#app-rpm" })).toHaveProperty("disabled", false);
  });

  it("shows no notice and live fields for an app that identifies its users", async () => {
    renderTab(configured);

    const rpm = await screen.findByLabelText("Requests per minute", { selector: "#rpm" });
    expect(rpm).toHaveProperty("disabled", false);
    expect(screen.queryByRole("link", { name: /turn on user authentication/i })).toBeNull();
  });

  it("renders an app with no limits block as unlimited rather than empty", async () => {
    renderTab();

    // Every field is a placeholder, not a zero: an absent block is unlimited,
    // and showing 0 would read as "no requests allowed".
    const rpm = await screen.findByLabelText("Requests per minute", { selector: "#rpm" });
    expect(rpm).toHaveProperty("value", "");
    expect(rpm.getAttribute("placeholder")).toBe("Unlimited");
    expect(screen.getByLabelText(/monthly spending budget/i, { selector: "#budget" }).getAttribute("placeholder"))
      .toBe("Unlimited");
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

describe("LimitsTab on an App Attest app", () => {
  function renderAttest(endUser: Record<string, unknown>, spending: Record<string, unknown> = { monthly_usd: 5 }) {
    stubApi({
      [`/v1/admin/apps/${APP_ID}`]: {
        body: {
          app: {
            ...appRow(),
            config: {
              authentication: {
                type: "apple_app_attest",
                app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.app", environments: ["production"] },
                end_user: endUser,
              },
              routing: { providers: { mode: "all" }, model_rewrites: {} },
              limits: {
                per_user: { requests: { per_minute: null, per_day: null }, spending },
                per_app: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
              },
            },
          },
        },
      },
    });
    return renderAuthenticated(<Harness />);
  }

  const issuer = {
    source: "issuer",
    issuer: {
      jwks_url: "https://issuer.example.test/jwks.json",
      issuer: ["https://issuer.example.test"],
      audience: ["my-app"],
      user_id_claim: "sub",
      required_claims: [],
      max_token_lifetime_seconds: 3600,
    },
  };

  it("calls the card per-install and measures the budget per install by default", async () => {
    renderAttest({ source: "app_install" });
    expect(await screen.findByText("Per-install limits")).toBeTruthy();
    expect(screen.getByText(/per install per month/u)).toBeTruthy();
    const scope = screen.getByRole("combobox", { name: "Budget measured per" });
    expect(scope.textContent).toBe("Install");
  });

  it("offers per user only where an issuer names the user", async () => {
    renderAttest({ source: "app_install" });
    await userEvent.click(await screen.findByRole("combobox", { name: "Budget measured per" }));
    const user = await screen.findByRole("option", { name: "User" });
    expect(user.getAttribute("aria-disabled")).toBe("true");
  });

  it("moves the budget to the user on an issuer-backed app", async () => {
    renderAttest(issuer, { monthly_usd: 5, scope: "install" });
    await userEvent.click(await screen.findByRole("combobox", { name: "Budget measured per" }));
    await userEvent.click(await screen.findByRole("option", { name: "User" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Budget measured per" }).textContent).toBe("User"));
    expect(screen.getByText(/per user per month/u)).toBeTruthy();
  });

  it("keeps the per-user card and no scope choice on a server app", async () => {
    renderTab(configured);
    expect(await screen.findByText("Per-user limits")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Budget measured per" })).toBeNull();
  });
});
