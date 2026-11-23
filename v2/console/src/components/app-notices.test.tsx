import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { AppNotices } from "./app-notices";
import { renderAuthenticated, settled, stubApi } from "@/test/render";
import { testApp } from "@/test/fixtures";
import { retiringModels } from "@/lib/app-notices";
import type { App } from "@/lib/types";

const OPENAI = { id: "p1", type: "openai", slug: "openai", name: "OpenAI", status: "active", secretHint: "abcd", baseUrl: null, pricing: null, revision: 1, createdAt: "", updatedAt: "" };
const PRICES = { openai: { "gpt-old": { input: 1, output: 2, retirement_date: "2027-01-15" }, "gpt-gone": { input: 1, output: 2, unlisted_since: "2026-10-01" }, "gpt-new": { input: 1, output: 2 } } };

afterEach(() => vi.unstubAllGlobals());

function appNaming(): App {
  return testApp({
    config: {
      ...testApp().config,
      routing: { providers: { openai: { operations: ["openai.chat"], models: ["gpt-new", "gpt-old"] } }, model_rewrites: { "gpt-4": "gpt-gone" } },
      presets: { chat: { provider: "openai", operation: "openai.chat", model: "gpt-old" } },
    },
  }) as unknown as App;
}

describe("the app page's notices", () => {
  it("names each model the app uses that is retiring or unlisted, with where it is used", () => {
    expect(retiringModels(appNaming(), [OPENAI] as never, PRICES as never)).toEqual([
      { type: "openai", model: "gpt-old", where: ["allowed on openai", "preset chat"], retirementDate: "2027-01-15", unlistedSince: null },
      { type: "openai", model: "gpt-gone", where: ["rewrite from gpt-4"], retirementDate: null, unlistedSince: "2026-10-01" },
    ]);
  });

  it("shows the leaving models and a key-protected app's missing key", async () => {
    stubApi({
      "/v2/admin/providers": { body: { providers: [OPENAI] } },
      "/v2/admin/prices": { body: { prices: PRICES } },
      "/v2/admin/apps/my-app/keys": { body: { keys: [{ id: "k1", name: "old", key_prefix: "agw_", status: "revoked", created_at: "", last_used_at: null }] } },
    });
    renderAuthenticated(<AppNotices app={appNaming()} />);
    expect(await screen.findByText(/models this app uses are leaving/i)).toBeTruthy();
    expect(screen.getByText(/retires on 2027-01-15/i)).toBeTruthy();
    expect(screen.getByText(/no longer on our price list since 2026-10-01/i)).toBeTruthy();
    expect(await screen.findByText(/this app has no active api key/i)).toBeTruthy();
  });

  it("says nothing when every model stays and a key is active", async () => {
    stubApi({
      "/v2/admin/providers": { body: { providers: [OPENAI] } },
      "/v2/admin/prices": { body: { prices: { openai: { "gpt-new": { input: 1, output: 2 } } } } },
      "/v2/admin/apps/my-app/keys": { body: { keys: [{ id: "k1", name: "main", key_prefix: "agw_", status: "active", created_at: "", last_used_at: null }] } },
    });
    const { client } = renderAuthenticated(<AppNotices app={appNaming()} />);
    await settled(client);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the gateway's own warnings about the app", async () => {
    stubApi({});
    renderAuthenticated(<AppNotices app={testApp({ warnings: [{ code: "w", message: "Something stops soon.", until: "2027-01-01" }] }) as unknown as App} />);
    expect(await screen.findByText(/something stops soon/i)).toBeTruthy();
  });
});
