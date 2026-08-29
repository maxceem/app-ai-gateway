import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { UsageTab } from "./usage";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { UsageEvent } from "@/lib/types";

const APP_ID = "my-app";

function event(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    id: 1,
    user_id: "user-1",
    api_key_id: null,
    provider: "openai",
    model: "gpt-5.6-sol",
    route: "openai/v1/responses",
    endpoint_slug: null,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    cost_source: "computed",
    app_version: null,
    auth_method: "api_key",
    status: "ok",
    latency_ms: 12,
    created_at: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function renderUsage(events: UsageEvent[]) {
  stubApi({
    [`/v1/admin/apps/${APP_ID}/usage/timeseries`]: {
      body: { app_id: APP_ID, from: "2026-08-01", to: "2026-08-01", buckets: [] },
    },
    [`/v1/admin/apps/${APP_ID}/usage/breakdown`]: {
      body: { app_id: APP_ID, by: "model", from: "2026-08-01", to: "2026-08-01", rows: [] },
    },
    [`/v1/admin/apps/${APP_ID}/events`]: {
      body: { app_id: APP_ID, limit: 25, next_before_id: null, events },
    },
  });
  return renderAuthenticated(<UsageTab appId={APP_ID} />, { route: `/apps/${APP_ID}/usage` });
}

afterEach(() => vi.unstubAllGlobals());

describe("UsageTab event costs", () => {
  it("says an unresolved event was not metered instead of showing it as free", async () => {
    renderUsage([
      event({ id: 2, cost_source: "unresolved", model: "cohere-command" }),
      event({ id: 1, cost_usd: 0, cost_source: "computed", model: "free-model" }),
    ]);

    expect(await screen.findByText("unresolved")).toBeTruthy();
    // The genuinely-zero event keeps its measured cost, so the two are not
    // collapsed into one appearance.
    expect(screen.getAllByText("$0.00").length).toBe(1);
  });

  it("shows a plain cost when the event was metered", async () => {
    renderUsage([event({ cost_usd: 0.25, cost_source: "computed" })]);

    expect(await screen.findByText("$0.25")).toBeTruthy();
    expect(screen.queryByText("unresolved")).toBeNull();
  });
});
