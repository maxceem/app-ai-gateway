import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { OverviewTab } from "./overview";
import { useAppDraft } from "@/hooks/use-app-draft";
import { renderAuthenticated, stubApi } from "@/test/render";

const APP_ID = "my-app";

const APP_ROW = {
  id: APP_ID,
  name: "My app",
  status: "active",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  config: {
    authentication: {
      type: "api_key",
    },
    routing: { providers: { mode: "all" }, model_rewrites: {} },
  },
};

/** The "Client base URL" card; the page has other `code` elements before it. */
function baseUrl(container: HTMLElement): string {
  const code = [...container.querySelectorAll("code")]
    .find((element) => element.textContent?.includes("/v1/apps/"));
  return code?.textContent ?? "";
}

function Harness() {
  const state = useAppDraft(APP_ID);
  return state.draft ? <OverviewTab appId={APP_ID} month="2026-02" state={state} /> : null;
}

function renderTab(apiBaseUrl?: string, keys: Array<{ status: string }> = [{ status: "active" }]) {
  stubApi({
    // Longest prefixes first: `stubApi` matches on the first key that prefixes
    // the URL, and the app row's path prefixes all of these.
    [`/v1/admin/apps/${APP_ID}/usage`]: { body: { requests: 0 } },
    [`/v1/admin/apps/${APP_ID}/users`]: { body: { app_id: APP_ID, total: 0, users: [] } },
    [`/v1/admin/apps/${APP_ID}/keys`]: { body: { app_id: APP_ID, keys } },
    [`/v1/admin/apps/${APP_ID}`]: {
      body: { app: APP_ROW, resolved: null, config_error: null },
    },
  });
  return renderAuthenticated(<Harness />, { capabilities: { apiBaseUrl } });
}

afterEach(() => vi.unstubAllGlobals());

describe("OverviewTab", () => {
  it("builds the client base URL from the console's own origin by default", async () => {
    const { container } = renderTab();

    await waitFor(() =>
      expect(baseUrl(container)).toBe(
        `${window.location.origin}/v1/apps/${APP_ID}/proxy/{provider}/{provider_path}`,
      ));
  });

  /**
   * A deployment that publishes a separate host for application clients is the
   * only thing that can tell the console about it, so the advertised origin
   * replaces the window's rather than being appended to it.
   */
  it("advertises the deployment's API host when one is configured", async () => {
    const { container } = renderTab("https://api.example.com");

    await waitFor(() =>
      expect(baseUrl(container)).toBe(
        `https://api.example.com/v1/apps/${APP_ID}/proxy/{provider}/{provider_path}`,
      ));
    expect(baseUrl(container)).not.toContain(window.location.origin);
  });

  it("says when a server app has no key anything could call it with", async () => {
    renderTab(undefined, [{ status: "revoked" }]);

    expect(await screen.findByText(/no active API key/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /create an API key/i }).getAttribute("href"))
      .toBe(`/apps/${APP_ID}/auth/identity`);
  });

  it("stays quiet about keys while one is active", async () => {
    const { container } = renderTab();

    await waitFor(() => expect(baseUrl(container)).toContain("/v1/apps/"));
    expect(screen.queryByText(/no active API key/i)).toBeNull();
  });

  it("repeats no setting that is decided on another section", async () => {
    const { container } = renderTab();

    await waitFor(() => expect(baseUrl(container)).toContain("/v1/apps/"));
    expect(screen.queryByLabelText(/display name/i)).toBeNull();
    expect(screen.queryByText(/effective configuration/i)).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
